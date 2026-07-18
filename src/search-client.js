// Client wrapper around the search Web Worker, which holds the page corpus
// in memory (see search-worker.js). Keeps a single worker instance alive for
// the lifetime of the service worker and exposes Promise-based helpers so callers
// stay on the (responsive) main thread while heavy cosine ranking runs off-thread.
//
// Chrome MV3 service workers support `new Worker(url, { type: "module" })`.

const WORKER_URL = new URL("./search-worker.js", import.meta.url).href;

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(WORKER_URL, { type: "module" });
    worker.onmessage = (e) => {
      const { id, ok, results, error, count } = e.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve({ results, count });
      else entry.reject(new Error(error || "search worker failed"));
    };
    worker.onerror = (e) => {
      // Fail every in-flight request; the worker is dead until recreated.
      const err = new Error(e.message || "search worker error");
      for (const { reject } of pending.values()) reject(err);
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function send(action, payload = {}) {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, action, ...payload });
  });
}

// SEARCH is the hot path: transfer the query's underlying ArrayBuffer so
// Structured Clone does a zero-copy move instead of copying 768 floats. The
// query vector is freshly built per call and never reused, so detaching its
// buffer is safe.
function postSearch(queryVec, topK, threshold) {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(
      { id, action: "SEARCH", queryVec, topK, threshold },
      [queryVec.buffer]
    );
  });
}

// Stream the full corpus into the worker once (on startup / reload).
export function initWorkerState(pages) {
  return send("INITIALIZE_STATE", { pages });
}

// Sync a single newly indexed page into the worker (upsert by id).
export function addPageToWorker(page) {
  return send("ADD_PAGE", { page });
}

// Run the 2-stage MRL search over the in-memory index. Returns only result
// metadata (id/url/title/score/snippet) — no embeddings cross postMessage.
export function rankPagesAsync(queryVec, topK = 10, threshold = 0.7) {
  return postSearch(queryVec, topK, threshold);
}

// Recently visited pages from the in-memory index (used as a fallback).
export function recentPagesAsync(topK = 10) {
  return send("RECENT", { topK });
}
