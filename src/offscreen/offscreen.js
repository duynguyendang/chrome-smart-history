// Offscreen document: hosts the Semantic Embedder API (needs a window context)
// and serves embed requests from the background service worker.

import { embedDocument, embedQuery } from "../embedding.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen-embed") return;

  (async () => {
    try {
      if (msg.type === "EMBED_DOCUMENT") {
        const values = await embedDocument(msg.text);
        sendResponse({ ok: true, values: Array.from(values) });
      } else if (msg.type === "EMBED_QUERY") {
        const values = await embedQuery(msg.text);
        sendResponse({ ok: true, values: Array.from(values) });
      } else {
        sendResponse({ ok: false, error: "Unknown embed request" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true; // keep message channel open for async response
});
