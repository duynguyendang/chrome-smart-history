# Smart History — Semantic Memory

A Chrome extension (Manifest V3) that turns your browsing history into a
**semantic knowledge base**. Every page you visit is embedded **on-device** with
Google's EmbeddingGemma model and stored locally in IndexedDB. You can then
search your history **by meaning**, not just by URL or title keywords.

Everything runs locally: raw page text and embedding vectors never leave your
device. There is no server, no account, and no cost.

---

## Why

Chrome history is a flat log you can only search by URL and title keywords. If
you forget the exact wording, the page is effectively lost. Smart History lets
you ask questions like *"what did I read about React performance last month?"*
and get the right page back by semantic similarity.

---

## Requirements

- **Chrome Canary 152.0.7943.0+** (desktop: Windows / macOS / Linux)
- Enrolled in the **Chrome Built-in AI Early Preview Program (EPP)**
- Enable the flag `chrome://flags/#semantic-embedder-api` → **Enabled**, then relaunch
- The EmbeddingGemma model downloads on first use (multi-GB, **no progress bar**).
  Wait until `SemanticEmbedder.availability()` returns `"available"` before the
  extension can index pages.

---

## Install (load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select the `chrome-smart-history/` folder
4. Pin the extension and open the popup
5. Browse a few pages, then search by meaning in the popup

---

## How to use

- **Browse normally.** Each page that finishes loading is automatically
  extracted, embedded, and stored locally. No action needed.
- **Open the popup** to see the top pages **semantically similar to the tab you
  currently have open**, each with a similarity score and a text snippet.
- **Type a query** to run a semantic search across everything you've indexed.
  Results below a 0.7 cosine-similarity threshold are hidden.
- **"Index current tab"** forces the active tab to be embedded immediately
  (useful for testing).
- **Options** (Settings link in the popup): enable/disable capture, set the
  retention period (default 90 days), and the capture delay.
- **"Clear all"** wipes every indexed page from this device.

---

## How it works

```
Page finishes loading (tabs.onUpdated, status === "complete")
   │
   ▼
Background SW → scripting.executeScript extracts page text (textContent, ≤5000 chars)
   │
   ▼
SemanticEmbedder.embed(text, { taskType: "retrieval-document" })  → 768-dims (Float32Array)
   │
   ▼
IndexedDB  { id = hash(url), url, title, text, embedding[768], norm,
             firstVisitedAt, lastVisitedAt, visitCount, device, dim }
   │
   ▼
Worker (in-memory state) ← INITIALIZE_STATE on startup, ADD_PAGE on each index
   │
   ▼
Popup: embed query/tab (taskType: "retrieval-query") → Float32Array
   → transferred zero-copy into the Worker
   → 2-stage Matryoshka (MRL) ranking over the in-memory index
   → top-k (≥ 0.7 cosine) returned as lightweight metadata
```

Key points:

- **Capture is background-driven.** The service worker listens for
  `chrome.tabs.onUpdated` and pulls text via `chrome.scripting.executeScript`.
  A content script also exists as a fallback path.
- **Dedupe by URL.** `id` is a SHA-256 of the URL, so re-visiting the same page
  updates the existing record (and increments `visitCount`) instead of creating
  duplicates.
- **Embedding runs where the API is available.** The Semantic Embedder needs a
  window context, so it runs in an **Offscreen Document** when
  `chrome.offscreen` exists, and falls back to running directly in the service
  worker on builds that lack the Offscreen API.
- **Fast, off-thread search (Web Worker).** All ranking runs in a dedicated
  Web Worker that holds the page corpus **in memory** (`INITIALIZE_STATE` on
  startup, `ADD_PAGE` on each new index). The main thread never re-reads
  IndexedDB or serializes the whole corpus on a search — it only sends the
  query vector (transferred zero-copy via its `ArrayBuffer`).
- **Two-stage Matryoshka (MRL) retrieval.** Stage 1 ranks by the first 128
  dimensions (a zero-allocation `subarray` view, norm computed on-the-fly) to
  cheaply narrow N pages down to a candidate pool. Stage 2 re-ranks only
  those candidates with the full 768-dim vector. The candidate pool is
  **hard-capped** (`MAX_CANDIDATES = 1000`) so Stage-2 cost stays bounded
  no matter how large the corpus grows.
- **Zero-allocation storage.** Only the full 768-dim `Float32Array` and its
  `norm` are persisted to IndexedDB. The 128-dim MRL sub-vector is derived
  on-the-fly as a view over the same buffer — nothing redundant is stored.
- **Threshold.** Similarity results are filtered at **0.7** cosine — tune in
  `src/search-worker.js` (`rankPages` default threshold) if you want broader recall.
- **Model dimension is 768** for the on-device EmbeddingGemma build used here.
  `dim` is stored per record.

---

## Project structure

```
chrome-smart-history/
├── manifest.json
├── LICENSE
├── NOTICE
├── src/
│   ├── config.js            # shared constants (incl. MRL_SUB_DIM)
│   ├── db.js               # IndexedDB (pages + search_cache stores)
│   ├── embedding.js        # getEmbedder / embedDocument / embedQuery
│   ├── background.js       # capture + search orchestration (service worker)
│   ├── search-worker.js   # in-memory MRL state manager (ranking off-thread)
│   ├── search-client.js   # worker client (zero-copy query transfer)
│   ├── offscreen-manager.js# ensures the offscreen document exists
│   ├── content/extract.js  # fallback page-text extraction
│   ├── offscreen/          # offscreen.html + offscreen.js (hosts Embedding API)
│   ├── popup/              # popup.html + .css + .js (search UI)
│   └── options/            # options.html + .css + .js (settings)
```

---

## Limitations

- **Desktop only** — the Embedding API is desktop-only.
- **Local only** — search returns pages captured on *this* device. Cross-device
  sync is out of scope for this build.
- **Same-model comparison** — vectors are only meaningful when compared against
  embeddings from the same model version.
- **No build step** — the extension is plain ES modules loaded unpacked; there
  is no bundler/minifier.

---

## Privacy

- Raw page text is stored only in IndexedDB on your device.
- Embedding vectors are generated on-device and never uploaded.
- No analytics, no cookies, no third-party requests.
- You can delete any page or all data at any time ("Clear all").

---

## Troubleshooting

- **"0 pages indexed" / "Embedding model not ready"** — the model isn't
  downloaded yet. Open any page, open DevTools console, and run
  `await SemanticEmbedder.availability()`. It must return `"available"`.
- **Background console shows** `chrome.offscreen API unavailable` — harmless;
  the extension falls back to embedding inside the service worker.

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
