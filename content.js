// content.js -- Steam Cards Bulk Seller
//
// Injects a Steam-native control panel into the Community Market and Inventory
// pages. Handles:
//   - session bridging via injected.js (reads g_sessionID from the page world)
//   - paginated inventory fetch (handles 10,000+ item accounts)
//   - trading-card filtering (Normal / Foil, marketable only)
//   - lowest-market-price lookup with rate-limited queue and exponential backoff
//   - Steam fee inversion (buyer-pays -> seller-receives, mirroring economy_common.js)
//   - bulk sellitem POSTs -- items land in "Awaiting Mobile Confirmation" state,
//     you approve them on the Steam Mobile app.
//
// The rate-limiting queue below is the safety valve that keeps Steam from
// dropping HTTP 429s on you: every network operation flows through it with a
// configurable delay, and 429 responses trigger backoff automatically.

const api = (typeof chrome !== "undefined" && chrome.runtime) ? chrome : browser;

const STEAM_APPID_CARDS = 753;      // Steam Community
const STEAM_CONTEXTID_CARDS = "6";  // Community Items context (cards, badges, backgrounds, emoticons)
const CARD_CATEGORY = "item_class"; // tag category
const CARD_INTERNAL_NAME = "item_class_2"; // Trading Card
const CARDBORDER_CATEGORY = "cardborder";  // 0 = normal, 1 = foil

const DEFAULT_SETTINGS = {
  pricePercent: 0,
  requestDelayMs: 500,
  priceDelayMs: 350,
  maxRetries: 5,
  currency: 1,
  minSellerReceivesCents: 1,
  onlyMarketable: true,
  cardTypes: { normal: true, foil: true },
  priceCacheTTLMs: 30 * 60 * 1000  // 30 minutes -- Steam card prices don't jitter fast
};

// -----------------------------------------------------------------------------
// Session bridge -- talks to injected.js in the page world.
// -----------------------------------------------------------------------------

const Session = (function () {
  let cached = null;
  const waiters = [];

  function handleMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.tag !== "SCBS_INJECTED" || data.type !== "SESSION") return;
    if (!data.ok) return; // wait for a session that actually has an ID
    cached = data;
    while (waiters.length) waiters.shift()(cached);
  }

  function inject() {
    const s = document.createElement("script");
    s.src = api.runtime.getURL("injected.js");
    s.async = false;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
    window.addEventListener("message", handleMessage);
  }

  function request() {
    window.postMessage({ tag: "SCBS_CONTENT", type: "REQUEST_SESSION" }, window.location.origin);
  }

  function get(timeoutMs = 10000) {
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for Steam session data.")), timeoutMs);
      waiters.push((data) => { clearTimeout(timer); resolve(data); });
      request();
    });
  }

  inject();
  return { get, request };
})();

// -----------------------------------------------------------------------------
// Fee math -- port of Steam's economy_common.js CalculateFeeAmount /
// CalculateAmountToSendForDesiredReceivedAmount. Given a buyer-pays cents
// amount, returns the seller-receives cents amount that Steam expects in the
// sellitem "price" field.
// -----------------------------------------------------------------------------

const Fees = (function () {
  // Steam's defaults if wallet info isn't loaded. wallet_fee_percent=5%,
  // wallet_fee_base=0, wallet_fee_minimum=1, publisher fee for 753=10%.
  const DEFAULT_WALLET = { wallet_fee: "1", wallet_fee_base: "0", wallet_fee_percent: "0.05", wallet_fee_minimum: "1" };
  const PUBLISHER_FEE_STEAM_CARDS = 0.10;

  function amountToSendFor(receivedAmount, publisherFee, walletInfo) {
    if (!walletInfo.wallet_fee) return { steam_fee: 0, publisher_fee: 0, fees: 0, amount: Math.trunc(receivedAmount) };
    const nSteamFee = Math.trunc(Math.floor(
      Math.max(receivedAmount * parseFloat(walletInfo.wallet_fee_percent), parseInt(walletInfo.wallet_fee_minimum, 10))
      + parseInt(walletInfo.wallet_fee_base, 10)
    ));
    const nPublisherFee = Math.trunc(Math.floor(publisherFee > 0 ? Math.max(receivedAmount * publisherFee, 1) : 0));
    const nAmountToSend = Math.trunc(receivedAmount) + nSteamFee + nPublisherFee;
    return { steam_fee: nSteamFee, publisher_fee: nPublisherFee, fees: nSteamFee + nPublisherFee, amount: nAmountToSend };
  }

  // Given a buyer-pays amount, iteratively find the seller-receives amount
  // such that seller + fees == buyer amount. Mirrors CalculateFeeAmount.
  function inferSellerReceives(buyerAmount, walletInfo, publisherFee) {
    walletInfo = walletInfo || DEFAULT_WALLET;
    publisherFee = (typeof publisherFee === "number") ? publisherFee : PUBLISHER_FEE_STEAM_CARDS;
    if (!walletInfo.wallet_fee) return { received: buyerAmount, fees: 0 };

    const wfBase = parseInt(walletInfo.wallet_fee_base, 10);
    const wfPct = parseFloat(walletInfo.wallet_fee_percent);
    let estimated = Math.trunc((buyerAmount - wfBase) / (wfPct + publisherFee + 1));
    let bEverUndershot = false;
    let fees = amountToSendFor(estimated, publisherFee, walletInfo);
    let iterations = 0;

    while (fees.amount !== buyerAmount) {
      if (fees.amount > buyerAmount) {
        if (bEverUndershot) {
          fees = amountToSendFor(estimated - 1, publisherFee, walletInfo);
          fees.steam_fee += (buyerAmount - fees.amount);
          fees.fees += (buyerAmount - fees.amount);
          fees.amount = buyerAmount;
          estimated = estimated - 1;
          break;
        }
        estimated--;
      } else {
        bEverUndershot = true;
        estimated++;
      }
      fees = amountToSendFor(estimated, publisherFee, walletInfo);
      if (iterations++ > 20) break;
    }

    return { received: estimated, fees: fees.fees, buyer: fees.amount };
  }

  return { inferSellerReceives };
})();

// -----------------------------------------------------------------------------
// Price cache -- persists lowest-price lookups in storage.local so repeat
// bulk-sell runs don't re-hammer priceoverview. Keyed by currency + hash name.
// Cached null means "Steam had no price data" (still worth caching to avoid
// re-asking during a session).
// -----------------------------------------------------------------------------

const PriceCache = {
  _mem: new Map(), // in-memory tier populated on first read

  _key(hashName, currency) { return `p:${currency}:${hashName}`; },

  async prime(hashNames, currency) {
    // Bulk read from storage.local for a batch of hash names.
    const keys = hashNames.map((n) => this._key(n, currency));
    const chunk = await api.storage.local.get(keys);
    for (const k of keys) {
      if (chunk[k]) this._mem.set(k, chunk[k]);
    }
  },

  get(hashName, currency, ttlMs) {
    const k = this._key(hashName, currency);
    const entry = this._mem.get(k);
    if (!entry) return undefined; // never cached
    if (ttlMs > 0 && (Date.now() - entry.ts) > ttlMs) return undefined; // stale
    return entry.cents; // may be null (no market data), that's a valid cached answer
  },

  set(hashName, currency, cents) {
    const k = this._key(hashName, currency);
    this._mem.set(k, { cents, ts: Date.now() });
  },

  async flush() {
    // Write everything currently in memory to storage.local in one call.
    if (this._mem.size === 0) return;
    const payload = {};
    for (const [k, v] of this._mem) payload[k] = v;
    await api.storage.local.set(payload);
  },

  async clear() {
    // Remove only our keys, leave any other extension data alone.
    const all = await api.storage.local.get(null);
    const ours = Object.keys(all).filter((k) => k.startsWith("p:"));
    if (ours.length) await api.storage.local.remove(ours);
    this._mem.clear();
  }
};

// -----------------------------------------------------------------------------
// Rate-limited async queue. Every task returns a promise; the queue processes
// them serially with a delay between each. HTTP 429 is handled by the caller
// via the runWithBackoff wrapper below.
// -----------------------------------------------------------------------------

class RateLimitedQueue {
  constructor(delayMs) {
    this.delayMs = delayMs;
    this.queue = [];
    this.running = false;
    this.cancelled = false;
  }
  setDelay(ms) { this.delayMs = ms; }
  cancel() { this.cancelled = true; this.queue.length = 0; }

  push(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      if (!this.running) this._pump();
    });
  }

  async _pump() {
    this.running = true;
    while (this.queue.length && !this.cancelled) {
      const { taskFn, resolve, reject } = this.queue.shift();
      try { resolve(await taskFn()); }
      catch (err) { reject(err); }
      if (this.queue.length && !this.cancelled) {
        await sleep(this.delayMs);
      }
    }
    this.running = false;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runWithBackoff(fn, maxRetries, onRetry) {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      const is429 = err && (err.status === 429 || err.code === 429);
      if (!is429 || attempt >= maxRetries) throw err;
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s (capped).
      const wait = Math.min(2000 * Math.pow(2, attempt), 32000);
      attempt++;
      if (onRetry) onRetry(attempt, wait);
      await sleep(wait);
    }
  }
}

// -----------------------------------------------------------------------------
// Price resolver. priceoverview is rate limited to roughly 20 requests per
// minute (per IP; Steam's own inventory page draws on the same budget). Going
// over it gets 429 for every card until the window has passed, so instead of
// reacting to 429s, PriceLimiter keeps a sliding window of our own requests and
// waits before one would exceed it. The window is stored, so reloading the
// page doesn't reset it. If a 429 still comes (Steam's page used some of the
// budget), the window is treated as full and that card is retried at the end.
// -----------------------------------------------------------------------------

const PriceLimiter = {
  MAX: 18,          // stay a little under Steam's ~20/min
  WINDOW_MS: 60000,
  KEY: "rl:priceoverview",
  _stamps: null,

  async _load() {
    if (this._stamps) return;
    try {
      const r = await api.storage.local.get(this.KEY);
      this._stamps = Array.isArray(r[this.KEY]) ? r[this.KEY] : [];
    } catch (_) { this._stamps = []; }
  },
  _save() {
    try { Promise.resolve(api.storage.local.set({ [this.KEY]: this._stamps })).catch(() => {}); } catch (_) {}
  },
  // How long until the next request fits in the window (0 = go now).
  async waitMs() {
    await this._load();
    const now = Date.now();
    this._stamps = this._stamps.filter((t) => now - t < this.WINDOW_MS);
    return this._stamps.length < this.MAX ? 0 : this._stamps[0] + this.WINDOW_MS - now + 250;
  },
  record() { this._stamps.push(Date.now()); this._save(); },
  markFull() { this._stamps = new Array(this.MAX).fill(Date.now()); this._save(); }
};

async function sleepUnless(ms, isCancelled) {
  const end = Date.now() + ms;
  while (!isCancelled() && Date.now() < end) await sleep(Math.min(250, end - Date.now()));
}

// hooks: { isCancelled(), log(msg), onPending(card, text), onResolved(card, cents), onFailed(card, err) }
async function resolvePrices(cards, currency, settings, hooks) {
  const delay = Math.max(100, settings.priceDelayMs);
  const maxAttempts = Math.max(1, (settings.maxRetries | 0) + 1);

  // Copies of the same card share one market_hash_name -- ask Steam once per
  // name and apply the answer to every copy.
  const byName = new Map();
  for (const card of cards) {
    const group = byName.get(card.market_hash_name);
    if (group) group.copies.push(card);
    else byName.set(card.market_hash_name, { card, copies: [card], attempts: 0, retryAt: 0 });
  }
  const pending = [...byName.values()];
  const each = (item, fn) => item.copies.forEach(fn);
  let sentAny = false;

  while (pending.length && !hooks.isCancelled()) {
    // Fresh cards (retryAt 0) first in original order, then ones that got a 429.
    pending.sort((a, b) => a.retryAt - b.retryAt);
    const item = pending[0];
    const { card } = item;

    const limitWait = await PriceLimiter.waitMs();
    if (limitWait > 0) {
      const end = Date.now() + limitWait;
      if (limitWait > 5000) {
        hooks.log(`  Steam allows ~${PriceLimiter.MAX} price lookups per minute -- next batch in ${Math.ceil(limitWait / 1000)}s (${pending.length} left).`);
      }
      // Live countdown on the waiting card's row, refreshed every second.
      while (!hooks.isCancelled() && Date.now() < end) {
        const s = Math.ceil((end - Date.now()) / 1000);
        each(item, (c) => hooks.onPending(c, `waiting for Steam limit (${s}s)...`));
        await sleepUnless(Math.min(1000, end - Date.now()), hooks.isCancelled);
      }
      continue;
    }
    if (sentAny) await sleepUnless(delay, hooks.isCancelled);
    if (hooks.isCancelled()) break;

    pending.shift();
    sentAny = true;
    item.attempts++;
    const pendingText = item.attempts > 1 ? `retrying (${item.attempts}/${maxAttempts})...` : "fetching...";
    each(item, (c) => hooks.onPending(c, pendingText));
    PriceLimiter.record();

    try {
      const cents = await SteamAPI.fetchLowestPriceCents(card.market_hash_name, currency);
      each(item, (c) => hooks.onResolved(c, cents));
    } catch (err) {
      if (!(err && err.status === 429)) { each(item, (c) => hooks.onFailed(c, err)); continue; }
      PriceLimiter.markFull();
      if (item.attempts >= maxAttempts) {
        each(item, (c) => hooks.onFailed(c, err));
      } else {
        item.retryAt = Date.now();
        pending.push(item);
        each(item, (c) => hooks.onPending(c, "Steam limit hit -- retrying later"));
        hooks.log(`  429 on ${card.name} -- Steam limit reached anyway (Steam's own page may be using it), pausing ~60s.`);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Steam API wrappers. All requests share cookies with the page via
// credentials: "include".
// -----------------------------------------------------------------------------

const SteamAPI = {
  async fetchInventoryPage(steamId, startAssetId) {
    let url = `https://steamcommunity.com/inventory/${steamId}/${STEAM_APPID_CARDS}/${STEAM_CONTEXTID_CARDS}?l=english&count=2000`;
    if (startAssetId) url += `&start_assetid=${encodeURIComponent(startAssetId)}`;
    const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    if (res.status === 429) { const e = new Error("HTTP 429 (inventory)"); e.status = 429; throw e; }
    if (!res.ok) throw new Error(`Inventory fetch failed: HTTP ${res.status}`);
    return res.json();
  },

  async fetchAllCards(steamId, cardTypes, onlyMarketable, log) {
    const results = [];
    let start = null;
    let page = 0;

    while (true) {
      page++;
      log(`Fetching inventory page ${page}${start ? ` (from asset ${start})` : ""}...`);
      const data = await this.fetchInventoryPage(steamId, start);
      if (!data || !data.assets) break;

      const descIndex = new Map();
      for (const d of (data.descriptions || [])) {
        descIndex.set(`${d.classid}_${d.instanceid}`, d);
      }

      for (const asset of data.assets) {
        const desc = descIndex.get(`${asset.classid}_${asset.instanceid}`);
        if (!desc) continue;
        if (onlyMarketable && !desc.marketable) continue;
        if (!isTradingCard(desc, cardTypes)) continue;
        results.push({
          assetid: asset.assetid,
          appid: asset.appid,
          contextid: asset.contextid,
          classid: asset.classid,
          instanceid: asset.instanceid,
          name: desc.name || desc.market_name || "(unnamed)",
          market_hash_name: desc.market_hash_name,
          icon_url: desc.icon_url,
          isFoil: isFoil(desc)
        });
      }

      if (!data.more_items || !data.last_assetid) break;
      start = data.last_assetid;
      await sleep(400); // small pause between inventory pages
    }

    return results;
  },

  async fetchLowestPriceCents(marketHashName, currency) {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=${STEAM_APPID_CARDS}`
      + `&currency=${encodeURIComponent(currency)}`
      + `&market_hash_name=${encodeURIComponent(marketHashName)}`;
    const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    if (res.status === 429) { const e = new Error("HTTP 429 (price)"); e.status = 429; throw e; }
    if (!res.ok) throw new Error(`Price fetch failed: HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !json.success) return null;
    // json.lowest_price is a localized string like "$0.10" or "0,10€".
    const cents = parsePriceStringToCents(json.lowest_price || json.median_price);
    return cents;
  },

  async postSellItem({ sessionId, assetid, price, contextid, appid }) {
    const body = new URLSearchParams();
    body.set("sessionid", sessionId);
    body.set("appid", String(appid || STEAM_APPID_CARDS));
    body.set("contextid", String(contextid || STEAM_CONTEXTID_CARDS));
    body.set("assetid", String(assetid));
    body.set("amount", "1");
    body.set("price", String(price));

    const res = await fetch("https://steamcommunity.com/market/sellitem/", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": "https://steamcommunity.com/market/"
      },
      body: body.toString()
    });

    if (res.status === 429) { const e = new Error("HTTP 429 (sellitem)"); e.status = 429; throw e; }

    let json = null;
    try { json = await res.json(); } catch (_) { /* Steam sometimes returns HTML on error */ }

    if (!res.ok) {
      const msg = (json && (json.message || json.strError)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    if (json && json.success === false) {
      throw new Error(json.message || json.strError || "sellitem returned success:false");
    }
    return json || { success: true };
  }
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isTradingCard(desc, cardTypes) {
  if (!desc.tags) return false;
  const tagIsCard = desc.tags.some((t) => t.category === CARD_CATEGORY && t.internal_name === CARD_INTERNAL_NAME);
  if (!tagIsCard) return false;
  const foil = isFoil(desc);
  if (foil && !cardTypes.foil) return false;
  if (!foil && !cardTypes.normal) return false;
  return true;
}

function isFoil(desc) {
  if (!desc.tags) return false;
  return desc.tags.some((t) => t.category === CARDBORDER_CATEGORY && (t.internal_name === "cardborder_1" || /foil/i.test(t.name || "")));
}

function parsePriceStringToCents(str) {
  if (!str || typeof str !== "string") return null;
  // Extract digits, comma, dot, minus. Drop currency symbols and spaces.
  const cleaned = str.replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  // Determine decimal separator by taking the LAST . or , as the decimal.
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let normalized;
  if (lastDot === -1 && lastComma === -1) {
    normalized = cleaned;
  } else if (lastDot > lastComma) {
    // dot is decimal, remove all commas (thousand sep)
    normalized = cleaned.replace(/,/g, "");
  } else {
    // comma is decimal, remove all dots (thousand sep), then swap comma -> dot
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  }
  const value = parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function formatCents(cents, currencySymbol) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${currencySymbol || "$"}${whole}.${frac}`;
}

async function getSettings() {
  const stored = await api.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

// -----------------------------------------------------------------------------
// UI
// -----------------------------------------------------------------------------

const UI = (function () {
  let root, listEl, statusEl, progressBar, progressText, logEl;
  let cards = [];
  let cancelled = false;
  let inFlight = false;
  let sessionCache = null;
  let currencySymbolCache = "$";
  let currencyCache = 1;

  function build() {
    if (document.getElementById("scbs-root")) return; // already built
    root = document.createElement("div");
    root.id = "scbs-root";
    root.className = "scbs-panel";
    root.innerHTML = `
      <div class="scbs-header">
        <span class="scbs-title">Steam Cards Bulk Seller</span>
        <button class="scbs-toggle" title="Collapse/Expand">–</button>
      </div>
      <div class="scbs-body">
        <div class="scbs-row">
          <label>Price modifier
            <input type="number" step="0.5" class="scbs-percent" value="0" title="% relative to lowest market price (buyer-pays). Negative = quick sell." />
            <span class="scbs-hint">%</span>
          </label>
          <label>Delay (ms)
            <input type="number" step="50" min="100" class="scbs-delay" value="500" title="Delay between sellitem POSTs." />
          </label>
        </div>
        <div class="scbs-row">
          <label class="scbs-check"><input type="checkbox" class="scbs-normal" checked /> Normal</label>
          <label class="scbs-check"><input type="checkbox" class="scbs-foil" checked /> Foil</label>
          <label class="scbs-check"><input type="checkbox" class="scbs-marketable" checked /> Marketable only</label>
        </div>
        <div class="scbs-row scbs-actions">
          <button class="scbs-fetch">Load Trading Cards</button>
          <button class="scbs-fetch-prices" disabled>Fetch Prices</button>
          <button class="scbs-sell scbs-primary" disabled>Bulk Sell</button>
          <button class="scbs-cancel" disabled>Cancel</button>
        </div>
        <div class="scbs-row scbs-actions scbs-actions-secondary">
          <button class="scbs-select-all" disabled>Select All</button>
          <button class="scbs-select-none" disabled>Select None</button>
          <label class="scbs-sort-label">Sort
            <select class="scbs-sort">
              <option value="name-asc">Name (A-Z)</option>
              <option value="name-desc">Name (Z-A)</option>
              <option value="price-desc">Price (high to low)</option>
              <option value="price-asc">Price (low to high)</option>
              <option value="foil-first">Foil first</option>
            </select>
          </label>
        </div>
        <div class="scbs-status">Ready.</div>
        <div class="scbs-progress"><div class="scbs-progress-bar"></div><div class="scbs-progress-text"></div></div>
        <div class="scbs-list-wrap">
          <div class="scbs-list-header">
            <span class="scbs-list-count">0 cards</span>
            <span class="scbs-list-selected">0 selected</span>
          </div>
          <div class="scbs-list"></div>
        </div>
        <details class="scbs-log-wrap"><summary>Log</summary><pre class="scbs-log"></pre></details>
      </div>
    `;
    document.body.appendChild(root);

    listEl = root.querySelector(".scbs-list");
    statusEl = root.querySelector(".scbs-status");
    progressBar = root.querySelector(".scbs-progress-bar");
    progressText = root.querySelector(".scbs-progress-text");
    logEl = root.querySelector(".scbs-log");

    // Wire events
    root.querySelector(".scbs-toggle").addEventListener("click", () => {
      root.classList.toggle("scbs-collapsed");
      root.querySelector(".scbs-toggle").textContent = root.classList.contains("scbs-collapsed") ? "+" : "–";
    });
    root.querySelector(".scbs-fetch").addEventListener("click", onFetch);
    root.querySelector(".scbs-fetch-prices").addEventListener("click", onFetchPrices);
    root.querySelector(".scbs-select-all").addEventListener("click", () => setAllSelected(true));
    root.querySelector(".scbs-select-none").addEventListener("click", () => setAllSelected(false));
    root.querySelector(".scbs-sell").addEventListener("click", onBulkSell);
    root.querySelector(".scbs-cancel").addEventListener("click", () => { cancelled = true; setStatus("Cancelling..."); });
    root.querySelector(".scbs-sort").addEventListener("change", (e) => {
      sortCards(e.target.value);
      renderCardList();
    });

    // Load saved settings.
    getSettings().then((s) => {
      root.querySelector(".scbs-percent").value = s.pricePercent;
      root.querySelector(".scbs-delay").value = s.requestDelayMs;
      root.querySelector(".scbs-normal").checked = !!s.cardTypes.normal;
      root.querySelector(".scbs-foil").checked = !!s.cardTypes.foil;
      root.querySelector(".scbs-marketable").checked = !!s.onlyMarketable;
    });

    // Persist when changed.
    ["scbs-percent", "scbs-delay", "scbs-normal", "scbs-foil", "scbs-marketable"].forEach((cls) => {
      root.querySelector("." + cls).addEventListener("change", persist);
    });
  }

  async function persist() {
    const percent = parseFloat(root.querySelector(".scbs-percent").value);
    const delay = parseInt(root.querySelector(".scbs-delay").value, 10);
    await api.storage.sync.set({
      pricePercent: Number.isFinite(percent) ? percent : 0,
      requestDelayMs: Number.isFinite(delay) && delay >= 100 ? delay : 500,
      onlyMarketable: root.querySelector(".scbs-marketable").checked,
      cardTypes: {
        normal: root.querySelector(".scbs-normal").checked,
        foil: root.querySelector(".scbs-foil").checked
      }
    });
  }

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  function log(msg) {
    if (!logEl) return;
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    logEl.textContent += line;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setProgress(done, total) {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    progressBar.style.width = pct + "%";
    progressText.textContent = total > 0 ? `${done} / ${total} (${pct}%)` : "";
  }

  function renderCardList() {
    listEl.innerHTML = "";
    for (const card of cards) {
      const row = document.createElement("div");
      row.className = "scbs-row-card";
      row.dataset.assetid = card.assetid;
      row.innerHTML = `
        <label class="scbs-card-label">
          <input type="checkbox" class="scbs-card-check" ${card._selected ? "checked" : ""} />
          <img class="scbs-card-img" src="https://community.akamai.steamstatic.com/economy/image/${card.icon_url}/32fx32f" alt="" />
          <span class="scbs-card-name">${escapeHtml(card.name)}${card.isFoil ? ' <em class="scbs-foil-badge">FOIL</em>' : ""}</span>
          <span class="scbs-card-price" data-role="price">${formatCardPrice(card)}</span>
          <span class="scbs-card-status" data-role="status"></span>
        </label>
      `;
      row.querySelector(".scbs-card-check").addEventListener("change", (e) => {
        card._selected = e.target.checked;
        updateSelectedCount();
      });
      listEl.appendChild(row);
    }
    root.querySelector(".scbs-list-count").textContent = `${cards.length} cards`;
    updateSelectedCount();
    root.querySelector(".scbs-select-all").disabled = cards.length === 0;
    root.querySelector(".scbs-select-none").disabled = cards.length === 0;
    root.querySelector(".scbs-sell").disabled = cards.length === 0;
    root.querySelector(".scbs-fetch-prices").disabled = cards.length === 0;
  }

  function formatCardPrice(card) {
    if (card._priceCents === undefined) return '<span class="scbs-price-none">—</span>';
    if (card._priceCents === null) return '<span class="scbs-price-none">no data</span>';
    return `<span class="scbs-price-val">${escapeHtml(formatCents(card._priceCents, currencySymbolCache))}</span>`;
  }

  function setRowPrice(assetid, card) {
    const row = listEl.querySelector(`.scbs-row-card[data-assetid="${assetid}"]`);
    if (!row) return;
    const el = row.querySelector('[data-role="price"]');
    if (el) el.innerHTML = formatCardPrice(card);
  }

  function sortCards(mode) {
    const priceOr = (c, fallback) => (typeof c._priceCents === "number") ? c._priceCents : fallback;
    switch (mode) {
      case "name-asc":  cards.sort((a, b) => a.name.localeCompare(b.name)); break;
      case "name-desc": cards.sort((a, b) => b.name.localeCompare(a.name)); break;
      // Unpriced cards sink to the bottom for both price sorts so priced ones are actionable.
      case "price-desc": cards.sort((a, b) => priceOr(b, -1) - priceOr(a, -1)); break;
      case "price-asc":  cards.sort((a, b) => priceOr(a, Number.MAX_SAFE_INTEGER) - priceOr(b, Number.MAX_SAFE_INTEGER)); break;
      case "foil-first": cards.sort((a, b) => (b.isFoil === true) - (a.isFoil === true)); break;
    }
  }

  function updateSelectedCount() {
    const n = cards.filter((c) => c._selected).length;
    root.querySelector(".scbs-list-selected").textContent = `${n} selected`;
  }

  function setAllSelected(state) {
    for (const c of cards) c._selected = state;
    for (const el of listEl.querySelectorAll(".scbs-card-check")) el.checked = state;
    updateSelectedCount();
  }

  function setRowStatus(assetid, text, klass) {
    const row = listEl.querySelector(`.scbs-row-card[data-assetid="${assetid}"]`);
    if (!row) return;
    const s = row.querySelector('[data-role="status"]');
    if (!s) return;
    s.textContent = text;
    s.className = "scbs-card-status " + (klass || "");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function onFetch() {
    const btn = root.querySelector(".scbs-fetch");
    btn.disabled = true;
    setStatus("Loading session...");
    log("Fetching Steam session data...");
    try {
      const session = await Session.get();
      if (!session.g_steamID) throw new Error("Steam ID not found. Are you logged in?");
      sessionCache = session;
      currencyCache = (session.g_rgWalletInfo && session.g_rgWalletInfo.wallet_currency) || 1;
      currencySymbolCache = deriveCurrencySymbol(session.g_rgWalletInfo);
      setStatus("Loading inventory...");
      log(`Logged in as SteamID ${session.g_steamID}. Fetching inventory...`);

      const settings = await getSettings();
      cards = await SteamAPI.fetchAllCards(
        session.g_steamID,
        {
          normal: root.querySelector(".scbs-normal").checked,
          foil: root.querySelector(".scbs-foil").checked
        },
        root.querySelector(".scbs-marketable").checked,
        log
      );
      for (const c of cards) c._selected = true;

      // Prime price cache from storage.local and apply any fresh entries to
      // the loaded cards so the UI shows known prices immediately.
      await PriceCache.prime(cards.map((c) => c.market_hash_name), currencyCache);
      const ttl = settings.priceCacheTTLMs || 0;
      let cachedHits = 0;
      for (const c of cards) {
        const hit = PriceCache.get(c.market_hash_name, currencyCache, ttl);
        if (hit !== undefined) { c._priceCents = hit; cachedHits++; }
      }
      log(`Found ${cards.length} trading card(s). ${cachedHits} price(s) restored from cache.`);
      setStatus(`Loaded ${cards.length} card(s)${cachedHits ? `, ${cachedHits} cached prices` : ""}.`);
      sortCards(root.querySelector(".scbs-sort").value);
      renderCardList();
    } catch (err) {
      log("ERROR: " + err.message);
      setStatus("Error: " + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // Row/cache/log wiring for resolvePrices, shared by Fetch Prices and Bulk Sell.
  function priceHooks(currency, onCardDone) {
    return {
      isCancelled: () => cancelled,
      log,
      onPending: (card, text) => setRowStatus(card.assetid, text, "scbs-pending"),
      onResolved: (card, cents) => {
        card._priceCents = cents; // may be null
        PriceCache.set(card.market_hash_name, currency, cents);
        setRowPrice(card.assetid, card);
        setRowStatus(card.assetid, "", "");
        onCardDone();
      },
      onFailed: (card, err) => {
        setRowStatus(card.assetid, "price err: " + err.message, "scbs-err");
        log(`ERR   ${card.name}: ${err.message}`);
        onCardDone();
      }
    };
  }

  async function onFetchPrices() {
    if (inFlight) return;
    if (!cards.length) { setStatus("Load cards first."); return; }
    if (!sessionCache) sessionCache = await Session.get();

    const settings = await getSettings();
    const ttl = settings.priceCacheTTLMs || 0;

    // Fetch only cards whose price is missing OR stale (never re-fetch fresh cache).
    const targets = cards.filter((c) => {
      if (c._priceCents !== undefined) return false;
      return PriceCache.get(c.market_hash_name, currencyCache, ttl) === undefined;
    });

    if (!targets.length) {
      setStatus("All prices already cached.");
      log("Nothing to fetch -- prices are cached and fresh.");
      return;
    }

    inFlight = true;
    cancelled = false;
    root.querySelector(".scbs-fetch-prices").disabled = true;
    root.querySelector(".scbs-cancel").disabled = false;
    root.querySelector(".scbs-fetch").disabled = true;
    root.querySelector(".scbs-sell").disabled = true;

    log(`Fetching prices for ${targets.length} card(s)...`);
    let done = 0;
    setProgress(done, targets.length);
    await resolvePrices(targets, currencyCache, settings, priceHooks(currencyCache, () => {
      done++;
      setProgress(done, targets.length);
    }));

    await PriceCache.flush();
    sortCards(root.querySelector(".scbs-sort").value);
    renderCardList();

    inFlight = false;
    root.querySelector(".scbs-cancel").disabled = true;
    root.querySelector(".scbs-fetch-prices").disabled = false;
    root.querySelector(".scbs-fetch").disabled = false;
    root.querySelector(".scbs-sell").disabled = false;
    setStatus(cancelled
      ? `Price fetch cancelled. ${done}/${targets.length} fetched.`
      : `Prices fetched. ${done}/${targets.length} updated.`);
  }

  async function onBulkSell() {
    if (inFlight) return;
    const selected = cards.filter((c) => c._selected);
    if (!selected.length) { setStatus("No cards selected."); return; }
    const confirmed = window.confirm(
      `About to list ${selected.length} card(s) on the Steam Community Market.\n\n` +
      `Each listing must still be confirmed on the Steam Mobile app.\n\n` +
      `Continue?`
    );
    if (!confirmed) return;

    inFlight = true;
    cancelled = false;
    root.querySelector(".scbs-sell").disabled = true;
    root.querySelector(".scbs-cancel").disabled = false;
    root.querySelector(".scbs-fetch").disabled = true;

    const settings = await getSettings();
    const percent = parseFloat(root.querySelector(".scbs-percent").value);
    const delay = Math.max(100, parseInt(root.querySelector(".scbs-delay").value, 10) || 500);

    const session = sessionCache || (sessionCache = await Session.get());
    const walletInfo = session.g_rgWalletInfo || null;
    const currency = currencyCache;
    const currencySymbol = currencySymbolCache;
    const ttl = settings.priceCacheTTLMs || 0;

    const sellQueue = new RateLimitedQueue(delay);

    // Resolve all missing prices up front, so a card Steam has no price ready
    // for gets retried in the background instead of holding up the listings.
    const needPrice = selected.filter((c) => c._priceCents === undefined);
    if (needPrice.length) {
      log(`Fetching prices for ${needPrice.length} card(s) before listing...`);
      let fetched = 0;
      setProgress(0, needPrice.length);
      await resolvePrices(needPrice, currency, settings, priceHooks(currency, () => {
        fetched++;
        setProgress(fetched, needPrice.length);
      }));
      await PriceCache.flush();
    }

    let done = 0;
    setProgress(done, selected.length);

    for (const card of selected) {
      if (cancelled) break;
      // Prices were resolved above; null = Steam has no price, undefined = lookup failed.
      try {
        const lowest = card._priceCents;
        if (typeof lowest !== "number") {
          const why = lowest === null ? "no price data" : "price lookup failed";
          setRowStatus(card.assetid, why, lowest === null ? "scbs-warn" : "scbs-err");
          log(`SKIP  ${card.name}: ${why}.`);
          done++; setProgress(done, selected.length);
          continue;
        }

        const targetBuyer = Math.max(1, Math.round(lowest * (1 + (percent / 100))));
        const inv = Fees.inferSellerReceives(targetBuyer, walletInfo);
        const sellerReceives = Math.max(settings.minSellerReceivesCents, inv.received);

        setRowStatus(card.assetid, `listing @ ${formatCents(targetBuyer, currencySymbol)} (you get ${formatCents(sellerReceives, currencySymbol)})`, "scbs-pending");

        await sellQueue.push(() => runWithBackoff(
          () => SteamAPI.postSellItem({
            sessionId: session.g_sessionID,
            assetid: card.assetid,
            appid: card.appid,
            contextid: card.contextid,
            price: sellerReceives
          }),
          settings.maxRetries,
          (n, w) => log(`  429 on sell for ${card.name}, backoff ${w}ms (retry ${n})`)
        ));
        setRowStatus(card.assetid, `listed @ ${formatCents(targetBuyer, currencySymbol)} (awaiting mobile confirm)`, "scbs-ok");
        log(`OK    ${card.name} @ ${formatCents(targetBuyer, currencySymbol)} (you receive ${formatCents(sellerReceives, currencySymbol)})`);
      } catch (err) {
        setRowStatus(card.assetid, "error: " + err.message, "scbs-err");
        log(`ERR   ${card.name}: ${err.message}`);
      }
      done++;
      setProgress(done, selected.length);
    }

    await PriceCache.flush();

    inFlight = false;
    root.querySelector(".scbs-cancel").disabled = true;
    root.querySelector(".scbs-sell").disabled = false;
    root.querySelector(".scbs-fetch").disabled = false;
    setStatus(cancelled
      ? `Cancelled. Processed ${done}/${selected.length}. Confirm listed items on your Steam Mobile app.`
      : `Done. Processed ${done}/${selected.length}. Confirm listings on your Steam Mobile app.`);
  }

  function deriveCurrencySymbol(walletInfo) {
    // Best-effort — full mapping table is overkill for a helper UI.
    const map = { 1: "$", 2: "£", 3: "€", 4: "CHF ", 5: "₽", 7: "R$", 8: "¥", 9: "kr", 10: "S$", 11: "HK$", 12: "NT$", 13: "₩", 14: "₪", 20: "kr", 24: "R", 25: "kr", 28: "zł", 34: "kr", 35: "Bs.", 36: "kr", 37: "kr" };
    const code = walletInfo && walletInfo.wallet_currency;
    return map[code] || "$";
  }

  return { build };
})();

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

function onReady() {
  UI.build();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", onReady, { once: true });
} else {
  onReady();
}
