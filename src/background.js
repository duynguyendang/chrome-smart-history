// Background service worker: orchestrate capture, embedding, storage, search.
// MVP: local-only (no Cloudflare). Embeddings computed in-process (SW) or in
// the Offscreen Document when the Offscreen API is available.
//
// NOTE: Chrome MV3 service workers do NOT support `new Worker()`, so the
// ranking logic lives here directly. All the perf optimizations are kept:
// Float32Array storage, precomputed norms, two-stage Matryoshka (MRL)
// retrieval with a hard-capped candidate pool, and a top-k heap.

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  DEVICE_ID_KEY,
  RETENTION_DAYS_DEFAULT,
  SIMILAR_THRESHOLD,
  SEARCH_THRESHOLD,
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
import { embedDocument, embedQuery } from "./embedding.js";

// L2 norm of a vector, computed when a page is indexed so search only
// needs a dot product + one division.
function vectorNorm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

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

      let rawValues;
      if (await offscreenAvailable()) {
        const { ok, values: v, error } = await chrome.runtime.sendMessage({
          target: "offscreen-embed",
          type: "EMBED_DOCUMENT",
          text: `${title}\n${text}`,
        });
        if (!ok) return { ok: false, reason: "embed-failed", error };
        rawValues = v;
      } else {
        rawValues = await embedDocument(`${title}\n${text}`);
      }
      // Store as a TypedArray (V8 can vectorize the math) and precompute the
      // L2 norm once so search only needs a dot product + one division.
      // Only the full 768-dim vector is persisted; the 128-dim MRL sub-vector
      // is derived on-the-fly as a zero-alloc view during search.
      const values = Float32Array.from(rawValues);
      const norm = vectorNorm(values);
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
        norm,
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

// Cosine similarity using a precomputed norm for `b`. `queryNorm` is computed
// once per query; `bNorm` may be undefined to force a cheap recompute (used
// for the 128-dim view during the coarse pass).
function cosineSimilarity(a, b, queryNorm, bNorm) {
  if (!a || !b || a.length !== b.length) return 0;
  const qn = queryNorm != null ? queryNorm : vectorNorm(a);
  const bn = bNorm != null ? bNorm : vectorNorm(b);
  if (qn === 0 || bn === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (qn * bn);
}

// Fixed-size min-heap keyed by `score` (descending). Keeps only the top-k
// cheapest elements instead of sorting the whole array.
class TopKHeap {
  constructor(k) {
    this.k = k;
    this.items = [];
  }
  push(item) {
    const h = this.items;
    if (h.length < this.k) {
      h.push(item);
      this._bubbleUp(h.length - 1);
      return;
    }
    if (item.score <= h[0].score) return;
    h[0] = item;
    this._bubbleDown(0);
  }
  _bubbleUp(i) {
    const h = this.items;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].score <= h[i].score) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  _bubbleDown(i) {
    const h = this.items;
    const n = h.length;
    for (;;) {
      let s = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && h[l].score < h[s].score) s = l;
      if (r < n && h[r].score < h[s].score) s = r;
      if (s === i) break;
      [h[s], h[i]] = [h[i], h[s]];
      i = s;
    }
  }
  sorted() {
    return this.items.slice().sort((a, b) => b.score - a.score);
  }
}

const MRL_SUB_DIM = 128; // coarse-pass resolution (prefix of the 768-dim vec)
const COARSE_MIN_MUL = 3; // at least 3x topK
const COARSE_FRACTION = 0.1; // ...or 10% of the corpus
const MAX_CANDIDATES = 1000; // hard cap so Stage 2 never blows up

// Two-stage Matryoshka (MRL) retrieval over the in-memory page list:
//   Stage 1 (coarse): rank by the first MRL_SUB_DIM components (a zero-alloc
//     subarray view) and keep the top `candidateK` pages.
//   Stage 2 (fine): re-rank only those candidates with the full 768-dim vector
//     and return the top `topK`. `candidateK` is hard-capped so Stage-2
//     cost stays bounded no matter how large N grows.
// Default threshold is 0.0 so the top-k most-similar pages are always
// returned. EmbeddingGemma retrieval-style cosine scores for unrelated
// text sit well below 0.7; a fixed 0.7 cutoff hides nearly
// every result. Tune per your corpus if you want stricter filtering.
function rankPages(queryVec, pages, topK = 10, threshold = 0.0) {
  const candidateK = Math.min(
    MAX_CANDIDATES,
    Math.max(topK * COARSE_MIN_MUL, Math.ceil(pages.length * COARSE_FRACTION))
  );
  const qNorm = vectorNorm(queryVec);
  const queryVec128 = queryVec.subarray(0, MRL_SUB_DIM);
  const qNorm128 = vectorNorm(queryVec128);

  const coarse = new TopKHeap(candidateK);
  for (const p of pages) {
    const emb = p.embedding;
    if (!emb) continue;
    const sub = emb.subarray(0, MRL_SUB_DIM); // zero-alloc view
    const score = cosineSimilarity(queryVec128, sub, qNorm128, undefined);
    coarse.push({ score, page: p });
  }

  const fine = new TopKHeap(topK);
  for (const { page: p } of coarse.sorted()) {
    const emb = p.embedding;
    if (!emb) continue;
    const score = cosineSimilarity(
      queryVec,
      emb,
      qNorm,
      p.norm != null ? p.norm : undefined
    );
    if (score >= threshold) fine.push({ score, page: p });
  }

  return fine.sorted().map(({ score, page: p }) => ({
    id: p.id,
    url: p.url,
    title: p.title,
    site: p.site,
    visitedAt: p.lastVisitedAt || p.firstVisitedAt,
    score,
    snippet: (p.text || "").slice(0, 420),
  }));
}

// Recently visited pages (used as a fallback when no similar pages are found).
function recentPages(pages, topK = 10) {
  return pages
    .slice()
    .sort(
      (a, b) =>
        (b.lastVisitedAt || b.firstVisitedAt || 0) -
        (a.lastVisitedAt || a.firstVisitedAt || 0)
    )
    .slice(0, topK)
    .map((p) => ({
      id: p.id,
      url: p.url,
      title: p.title,
      site: p.site,
      visitedAt: p.lastVisitedAt || p.firstVisitedAt,
      score: 0,
      snippet: (p.text || "").slice(0, 420),
    }));
}

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
    values = await embedQuery(query);
  }
  const queryVec = Float32Array.from(values);

  const pages = await getAllPages();
  const results = rankPages(queryVec, pages, topK, SEARCH_THRESHOLD);

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
    values = await embedQuery(`${tab.title}\n${text}`);
  }
  const queryVec = Float32Array.from(values);

  const pages = await getAllPages();
  return rankPages(queryVec, pages, topK, SIMILAR_THRESHOLD);
}

// Recently visited pages (used as a fallback when no similar pages are found).
async function handleRecent(topK = 10) {
  const pages = await getAllPages();
  return recentPages(pages, topK);
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

