// Search Web Worker acting as an IN-MEMORY state manager.
//
// The service worker streams page records into this worker ONCE (on startup) and
// then incrementally (on each new index). Search runs entirely off the main
// thread over the in-memory `workerStorage` array, so the main thread never
// re-reads IndexedDB or serializes the whole corpus via postMessage on a search.
//
// Only lightweight result objects (ids/urls/scores, no embeddings) are sent back.
//
// Two-stage Matryoshka (MRL) retrieval:
//   Stage 1 (coarse): rank by the first MRL_SUB_DIM components (a zero-alloc
//     subarray view) and keep the top `candidateK` pages. The 128-dim norm is
//     computed on-the-fly (128 mult-adds) — nothing is persisted or allocated.
//   Stage 2 (fine): re-rank only those candidates with the full 768-dim vector
//     and return the top `topK`. `candidateK` is hard-capped at MAX_CANDIDATES
//     so Stage-2 cost stays bounded no matter how large N grows.

const MRL_SUB_DIM = 128; // coarse-pass resolution (prefix of the 768-dim vec)
const COARSE_MIN_MUL = 3; // at least 3x topK
const COARSE_FRACTION = 0.1; // ...or 10% of the corpus
const MAX_CANDIDATES = 1000; // hard cap so Stage 2 never blows up

let workerStorage = []; // [{ id, url, title, site, text, embedding, norm, ... }]

// ---- pure helpers ----

function vectorNorm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

// Cosine similarity using a precomputed norm for `b`. `queryNorm` is computed
// once per query; `bNorm` may be undefined to force a cheap recompute (used for
// the 128-dim view during the coarse pass).
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
  get size() {
    return this.items.length;
  }
  push(item) {
    const h = this.items;
    if (h.length < this.k) {
      h.push(item);
      this._bubbleUp(h.length - 1);
      return;
    }
    if (item.score <= h[0].score) return; // worse than the current minimum
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

function toResult(p, score) {
  return {
    id: p.id,
    url: p.url,
    title: p.title,
    site: p.site,
    visitedAt: p.lastVisitedAt || p.firstVisitedAt,
    score,
    snippet: (p.text || "").slice(0, 420),
  };
}

function rankPages(queryVec, pages, topK = 10, threshold = 0.7) {
  const candidateK = Math.min(
    MAX_CANDIDATES,
    Math.max(topK * COARSE_MIN_MUL, Math.ceil(pages.length * COARSE_FRACTION))
  );
  const qNorm = vectorNorm(queryVec);
  // Zero-alloc 128-dim view of the query for the coarse pass.
  const queryVec128 = queryVec.subarray(0, MRL_SUB_DIM);
  const qNorm128 = vectorNorm(queryVec128);

  // Stage 1 — coarse filter over the 128-dim prefix.
  const coarse = new TopKHeap(candidateK);
  for (const p of pages) {
    const emb = p.embedding;
    if (!emb) continue;
    const sub = emb.subarray(0, MRL_SUB_DIM); // zero-alloc view
    const score = cosineSimilarity(queryVec128, sub, qNorm128, undefined);
    coarse.push({ score, page: p });
  }

  // Stage 2 — fine re-rank over the small candidate set with full vectors.
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

  return fine.sorted().map(({ score, page: p }) => toResult(p, score));
}

function recentPages(topK = 10) {
  return workerStorage
    .slice()
    .sort(
      (a, b) =>
        (b.lastVisitedAt || b.firstVisitedAt || 0) -
        (a.lastVisitedAt || a.firstVisitedAt || 0)
    )
    .slice(0, topK)
    .map((p) => toResult(p, 0));
}

// ---- message router ----

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.action === "INITIALIZE_STATE") {
      // Bulk load: replace the in-memory index with the full corpus.
      workerStorage = Array.isArray(msg.pages) ? msg.pages : [];
      self.postMessage({ id: msg.id, ok: true, count: workerStorage.length });
      return;
    }
    if (msg.action === "ADD_PAGE") {
      // Incremental upsert by id (URL-keyed dedupe lives in the caller).
      const page = msg.page;
      if (!page) {
        self.postMessage({ id: msg.id, ok: false, error: "no page" });
        return;
      }
      const idx = workerStorage.findIndex((p) => p.id === page.id);
      if (idx >= 0) workerStorage[idx] = page;
      else workerStorage.push(page);
      self.postMessage({ id: msg.id, ok: true, count: workerStorage.length });
      return;
    }
    if (msg.action === "SEARCH") {
      const results = rankPages(
        msg.queryVec,
        workerStorage,
        msg.topK,
        msg.threshold
      );
      self.postMessage({ id: msg.id, ok: true, results });
      return;
    }
    if (msg.action === "RECENT") {
      self.postMessage({
        id: msg.id,
        ok: true,
        results: recentPages(msg.topK),
      });
      return;
    }
    self.postMessage({ id: msg.id, ok: false, error: "Unknown worker action" });
  } catch (err) {
    self.postMessage({
      id: msg.id,
      ok: false,
      error: String((err && err.message) || err),
    });
  }
};
