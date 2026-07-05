const api = (typeof chrome !== "undefined" && chrome.runtime) ? chrome : browser;

const DEFAULTS = {
  pricePercent: 0,
  requestDelayMs: 500,
  priceDelayMs: 350,
  maxRetries: 5,
  currency: 1,
  minSellerReceivesCents: 1,
  onlyMarketable: true,
  cardTypes: { normal: true, foil: true },
  priceCacheTTLMs: 30 * 60 * 1000
};

const fields = ["pricePercent", "requestDelayMs", "priceDelayMs", "maxRetries", "onlyMarketable"];
const cardTypeFields = ["cardTypesNormal", "cardTypesFoil"];

function $(id) { return document.getElementById(id); }

function setStatus(text, klass = "") {
  const s = $("status");
  s.textContent = text;
  s.className = "status " + klass;
  if (text) setTimeout(() => { if (s.textContent === text) s.textContent = ""; }, 1500);
}

async function load() {
  const stored = await api.storage.sync.get(Object.keys(DEFAULTS));
  const merged = { ...DEFAULTS, ...stored };
  $("pricePercent").value = merged.pricePercent;
  $("requestDelayMs").value = merged.requestDelayMs;
  $("priceDelayMs").value = merged.priceDelayMs;
  $("maxRetries").value = merged.maxRetries;
  $("priceCacheTTLMin").value = Math.round((merged.priceCacheTTLMs || 0) / 60000);
  $("onlyMarketable").checked = !!merged.onlyMarketable;
  $("cardTypesNormal").checked = !!(merged.cardTypes && merged.cardTypes.normal);
  $("cardTypesFoil").checked = !!(merged.cardTypes && merged.cardTypes.foil);
}

async function save() {
  const ttlMin = Math.max(0, parseInt($("priceCacheTTLMin").value, 10) || 0);
  const payload = {
    pricePercent: parseFloat($("pricePercent").value) || 0,
    requestDelayMs: Math.max(100, parseInt($("requestDelayMs").value, 10) || DEFAULTS.requestDelayMs),
    priceDelayMs: Math.max(100, parseInt($("priceDelayMs").value, 10) || DEFAULTS.priceDelayMs),
    maxRetries: Math.max(0, Math.min(10, parseInt($("maxRetries").value, 10) || DEFAULTS.maxRetries)),
    priceCacheTTLMs: ttlMin * 60000,
    onlyMarketable: $("onlyMarketable").checked,
    cardTypes: {
      normal: $("cardTypesNormal").checked,
      foil: $("cardTypesFoil").checked
    }
  };
  await api.storage.sync.set(payload);
  setStatus("Saved.");
}

async function clearCache() {
  const all = await api.storage.local.get(null);
  const ours = Object.keys(all).filter((k) => k.startsWith("p:"));
  if (ours.length) await api.storage.local.remove(ours);
  setStatus(`Cleared ${ours.length} cached price(s).`);
}

async function reset() {
  await api.storage.sync.set(DEFAULTS);
  await load();
  setStatus("Reset.");
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
  $("reset").addEventListener("click", reset);
  $("clearCache").addEventListener("click", clearCache);
});
