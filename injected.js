// injected.js -- runs in the PAGE world so it can read Steam's client globals
// (g_sessionID, g_steamID, g_rgWalletInfo). Content scripts run in an isolated
// world and can't see these directly, so we hand them over via postMessage.

(function () {
  const TAG = "SCBS_INJECTED";

  function collectSession() {
    const info = {
      tag: TAG,
      type: "SESSION",
      g_sessionID: (typeof g_sessionID !== "undefined") ? g_sessionID : null,
      g_steamID: (typeof g_steamID !== "undefined") ? String(g_steamID) : null,
      g_rgWalletInfo: null,
      currency: null,
      ok: false
    };

    if (typeof g_rgWalletInfo !== "undefined" && g_rgWalletInfo) {
      // Serialize a shallow copy so postMessage can clone it.
      info.g_rgWalletInfo = JSON.parse(JSON.stringify(g_rgWalletInfo));
      info.currency = g_rgWalletInfo.wallet_currency || null;
    }

    info.ok = !!(info.g_sessionID);
    return info;
  }

  function post(payload) {
    window.postMessage(payload, window.location.origin);
  }

  // Listen for content-script requests.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.tag !== "SCBS_CONTENT") return;

    if (data.type === "REQUEST_SESSION") {
      post(collectSession());
    }
  });

  // Fire an initial announcement so the content script doesn't have to poll.
  // Steam sometimes assigns g_sessionID after DOMContentLoaded; retry briefly.
  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    const snapshot = collectSession();
    if (snapshot.ok || attempts > 20) {
      post(snapshot);
      if (snapshot.ok) clearInterval(timer);
    }
    if (attempts > 20) clearInterval(timer);
  }, 250);
})();
