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

export { EMBED_DIM };
