// Embedding helpers built on the Semantic Embedder API (EPP, Chrome Canary 152+).
// Runs inside the Offscreen Document (needs a window context).

import { EMBED_DIM } from "./config.js";

// Gate on availability() — the model downloads on first use with NO progress
// events, and create() fails unless availability() === "available".
export async function getEmbedder() {
  if (
    !("SemanticEmbedder" in self) ||
    (await SemanticEmbedder.availability()) !== "available"
  ) {
    throw new Error(
      "Embedding model not ready. Open chrome://on-device-internals and trigger a download, or visit a page to warm it up."
    );
  }
  return SemanticEmbedder.create();
}

// Cache a single embedder instance across calls (don't create/destroy per call).
let embedderPromise = null;
async function getSharedEmbedder() {
  if (!embedderPromise) {
    embedderPromise = getEmbedder().catch((e) => {
      embedderPromise = null; // allow retry on next call
      throw e;
    });
  }
  return embedderPromise;
}

export async function embedDocument(text) {
  const embedder = await getSharedEmbedder();
  const result = await embedder.embed(text, { taskType: "retrieval-document" });
  return result.embeddings[0].values; // Float32Array(768)
}

export async function embedQuery(text) {
  const embedder = await getSharedEmbedder();
  const result = await embedder.embed(text, { taskType: "retrieval-query" });
  return result.embeddings[0].values; // Float32Array(768)
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Local semantic search over a set of stored pages.
export function rankPages(queryVec, pages, topK = 10, threshold = 0.7) {
  return pages
    .map((p) => ({
      ...p,
      score: cosineSimilarity(queryVec, p.embedding),
    }))
    .filter((p) => p.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((p) => ({
      id: p.id,
      url: p.url,
      title: p.title,
      site: p.site,
      visitedAt: p.lastVisitedAt || p.firstVisitedAt,
      score: p.score,
      snippet: (p.text || "").slice(0, 420),
    }));
}

export { EMBED_DIM };
