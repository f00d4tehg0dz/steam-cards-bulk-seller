// Cross-browser polyfill: expose "chrome" if only "browser" is available (older Firefox builds).
const api = (typeof chrome !== "undefined" && chrome.runtime) ? chrome : browser;

const DEFAULT_SETTINGS = {
  pricePercent: 0,          // +/- percent modifier applied to lowest market price (buyer-pays)
  requestDelayMs: 500,      // delay between listing POSTs
  priceDelayMs: 350,        // delay between price fetch requests
  maxRetries: 5,            // retry attempts on HTTP 429
  currency: 1,              // Steam currency code (1 = USD). Auto-detected from the page when possible.
  minSellerReceivesCents: 1,// never list below this seller-receives amount
  onlyMarketable: true,     // safety: skip non-marketable items
  cardTypes: {
    normal: true,
    foil: true
  },
  priceCacheTTLMs: 30 * 60 * 1000
};

api.runtime.onInstalled.addListener(async () => {
  const existing = await api.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const merged = { ...DEFAULT_SETTINGS, ...existing };
  await api.storage.sync.set(merged);
});

// Keep the service worker responsive for content-script pings.
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "SCBS_PING") {
    sendResponse({ ok: true, ts: Date.now() });
    return true;
  }
  if (msg && msg.type === "SCBS_GET_DEFAULTS") {
    sendResponse({ defaults: DEFAULT_SETTINGS });
    return true;
  }
});
