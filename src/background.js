// Background service worker: orchestrate capture, embedding, storage, search.
// MVP: local-only (no Cloudflare). Embeddings computed in-process (SW) or in
// the Offscreen Document when the Offscreen API is available.

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  DEVICE_ID_KEY,
  RETENTION_DAYS_DEFAULT,
} from "./config.js";
import { ensureOffscreen } from "./offscreen-manager.js";
import {
  putPage,
  getPageByUrl,
  getAllPages,
  countPages,
  deletePage,
  clearAllPages,
  cleanupOldPages,
  cacheSearch,
  getCachedSearch,
} from "./db.js";
import { rankPages, cosineSimilarity, EMBED_DIM, embedDocument, embedQuery } from "./embedding.js";

// Stable key per URL so re-visits overwrite the same record (dedupe).
async function urlKey(url) {
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(url)
    );
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return url; // fallback
}

// Prefer the Offscreen Document (window context) when the API exists;
// otherwise embed directly inside the service worker (Chrome Canary 152 path).
async function offscreenAvailable() {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.offscreen &&
    typeof chrome.offscreen.createDocument === "function"
  );
}

// ---- settings & device ----

async function getSettings() {
  const s = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s[SETTINGS_KEY] || {}) };
}

async function getDeviceId() {
  let { [DEVICE_ID_KEY]: id } = await chrome.storage.local.get(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
  }
  return id;
}

// ---- capture pipeline ----

// NOTE: this runs inside the page's isolated world via scripting.executeScript,
// so it must be fully self-contained (no references to outer module scope).
function extractPageText() {
  const MAX = 5000;
  const meta = document.querySelector('meta[name="description"]');
  const metaText = meta ? meta.getAttribute("content") || "" : "";

  const article = document.querySelector("article");
  const main = document.querySelector("main");
  let bodyText =
    (article && article.textContent) ||
    (main && main.textContent) ||
    (document.body && document.body.textContent) ||
    "";

  if (!bodyText || !bodyText.trim()) {
    bodyText = document.documentElement.innerText || "";
  }

  return `${document.title}\n\n${metaText}\n\n${bodyText}`
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX);
}

// index a single tab: pull text via scripting, embed, store.
// Per-url promise cache so concurrent calls (auto-capture + manual button)
// share one result instead of racing / returning "pending".
const inflight = new Map();

export function indexTab(tabId, url, title) {
  if (!url || /^(chrome|about|edge|extension|file):/i.test(url)) {
    return Promise.resolve({ ok: false, reason: "unsupported-url" });
  }
  if (inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    const settings = await getSettings();
    if (!settings.enabled) return { ok: false, reason: "disabled" };

    try {
      console.log("[smart-history] extracting", url);
      const [{ result: text }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPageText,
      });
      console.log("[smart-history] extracted length:", text ? text.length : 0);
      if (!text) return { ok: false, reason: "empty-text" };

      let values;
      if (await offscreenAvailable()) {
        const { ok, values: v, error } = await chrome.runtime.sendMessage({
          target: "offscreen-embed",
          type: "EMBED_DOCUMENT",
          text: `${title}\n${text}`,
        });
        if (!ok) return { ok: false, reason: "embed-failed", error };
        values = v;
      } else {
        values = Array.from(await embedDocument(`${title}\n${text}`));
      }
      console.log("[smart-history] embedded dims:", values?.length);

      // Dedupe by URL: same URL re-visited updates the existing record
      // (re-embeds in case content changed) instead of creating a duplicate.
      const id = await urlKey(url);
      const existing = await getPageByUrl(url);
      const now = Date.now();
      await putPage({
        id,
        url,
        title: title || url,
        site: new URL(url).hostname,
        text,
        embedding: values,
        firstVisitedAt: existing?.firstVisitedAt || now,
        lastVisitedAt: now,
        visitCount: (existing?.visitCount || 0) + 1,
        device: await getDeviceId(),
        dim: values.length,
      });
      console.log(`[smart-history] indexed ${url}`);
      return { ok: true };
    } catch (e) {
      console.warn("[smart-history] capture error:", e);
      return { ok: false, reason: "error", error: e.message };
    }
  })();

  inflight.set(url, p);
  p.finally(() => inflight.delete(url));
  return p;
}

// Auto-capture on page load (reliable SW-driven path).
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  indexTab(tabId, tab.url, tab.title);
});

// Keep the content-script path as a fallback. The content script runs in a
// tab, so use the sender's tab id (msg.tabId passed from the router).
async function handleExtract(msg) {
  console.log("[smart-history] content-extract from", msg.url);
  await indexTab(msg.tabId, msg.url, msg.title);
}

// ---- search (served to popup) ----

async function handleSearch(query, topK) {
  if (!query || !query.trim()) return [];

  const cacheKey = `${topK}:${query.trim().toLowerCase()}`;
  const cached = await getCachedSearch(cacheKey);
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    return cached.results;
  }

  let values;
  if (await offscreenAvailable()) {
    const { ok, values: v, error } = await chrome.runtime.sendMessage({
      target: "offscreen-embed",
      type: "EMBED_QUERY",
      text: query,
    });
    if (!ok) throw new Error(error || "Embedding query failed");
    values = v;
  } else {
    values = Array.from(await embedQuery(query));
  }

  const pages = await getAllPages();
  const scored = pages
    .map((p) => ({ ...p, score: cosineSimilarity(Float32Array.from(values), p.embedding) }))
    .sort((a, b) => b.score - a.score);
  console.log(
    "[smart-history] top scores:",
    scored.slice(0, 3).map((s) => s.score.toFixed(3))
  );
  const results = rankPages(Float32Array.from(values), pages, topK);

  await cacheSearch(cacheKey, results);
  return results;
}

async function handleStats() {
  const count = await countPages();
  const settings = await getSettings();
  return { count, settings };
}

// Top pages semantically similar to the currently active tab.
async function handleSimilarCurrent(topK = 10) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || /^(chrome|about|edge|extension|file):/i.test(tab.url)) {
    return [];
  }
  const [{ result: text }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageText,
  });
  if (!text) return [];

  let values;
  if (await offscreenAvailable()) {
    const { ok, values: v, error } = await chrome.runtime.sendMessage({
      target: "offscreen-embed",
      type: "EMBED_QUERY",
      text: `${tab.title}\n${text}`,
    });
    if (!ok) throw new Error(error || "Embedding query failed");
    values = v;
  } else {
    values = Array.from(await embedQuery(`${tab.title}\n${text}`));
  }

  const pages = await getAllPages();
  const scored = pages
    .map((p) => ({ ...p, score: cosineSimilarity(Float32Array.from(values), p.embedding) }))
    .sort((a, b) => b.score - a.score);
  console.log(
    "[smart-history] similar top scores:",
    scored.slice(0, 3).map((s) => s.score.toFixed(3))
  );
  return rankPages(Float32Array.from(values), pages, topK);
}

// ---- message router ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === "content-extract") {
    handleExtract(msg);
    return false; // fire-and-forget
  }
  if (msg?.target === "popup") {
    (async () => {
      try {
        if (msg.type === "SEARCH") {
          sendResponse({ ok: true, results: await handleSearch(msg.query, msg.topK) });
        } else if (msg.type === "STATS") {
          sendResponse({ ok: true, ...(await handleStats()) });
        } else if (msg.type === "RECENT") {
          sendResponse({ ok: true, results: await handleRecent(msg.topK) });
        } else if (msg.type === "SIMILAR_CURRENT") {
          const results = await handleSimilarCurrent(msg.topK);
          // Fallback to recent list if the active tab has no similar pages.
          sendResponse({
            ok: true,
            results: results.length ? results : await handleRecent(msg.topK),
            similar: results.length > 0,
          });
        } else if (msg.type === "DELETE") {
          await deletePage(msg.id);
          sendResponse({ ok: true });
        } else if (msg.type === "CLEAR_ALL") {
          await clearAllPages();
          sendResponse({ ok: true });
        } else if (msg.type === "INDEX_CURRENT") {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) sendResponse({ ok: false, error: "no active tab" });
          else sendResponse(await indexTab(tab.id, tab.url, tab.title));
        } else {
          sendResponse({ ok: false, error: "Unknown popup request" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

// ---- periodic cleanup ----

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "cleanup") {
    const settings = await getSettings();
    await cleanupOldPages(settings.retentionDays || RETENTION_DAYS_DEFAULT);
  }
});

chrome.alarms.create("cleanup", { periodInMinutes: 60 * 24 });

// Warm up the offscreen document on startup so first capture is fast.
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen().catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => {
  ensureOffscreen().catch(() => {});
});
