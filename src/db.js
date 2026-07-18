// IndexedDB wrapper (local-only store, no Cloudflare).
// Stores: pages (raw text + embedding), search_cache (query results).

import { DB_NAME, RETENTION_DAYS_DEFAULT } from "./config.js";

const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pages")) {
        const store = db.createObjectStore("pages", { keyPath: "id" });
        store.createIndex("visitedAt", "visitedAt");
        store.createIndex("site", "site");
        store.createIndex("url", "url");
      }
      if (!db.objectStoreNames.contains("search_cache")) {
        db.createObjectStore("search_cache", { keyPath: "queryHash" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putPage(page) {
  const db = await openDB();
  await reqToPromise(tx(db, "pages", "readwrite").put(page));
}

export async function getPage(id) {
  const db = await openDB();
  return reqToPromise(tx(db, "pages", "readonly").get(id));
}

// Look up a page by its URL (used for dedupe on re-visit).
export async function getPageByUrl(url) {
  const db = await openDB();
  const idx = tx(db, "pages", "readonly").index("url");
  return reqToPromise(idx.get(url));
}

export async function getAllPages() {
  const db = await openDB();
  return reqToPromise(tx(db, "pages", "readonly").getAll());
}

export async function deletePage(id) {
  const db = await openDB();
  return reqToPromise(tx(db, "pages", "readwrite").delete(id));
}

export async function countPages() {
  const db = await openDB();
  return reqToPromise(tx(db, "pages", "readonly").count());
}

export async function clearAllPages() {
  const db = await openDB();
  await reqToPromise(tx(db, "pages", "readwrite").clear());
  await reqToPromise(tx(db, "search_cache", "readwrite").clear());
}

// Delete pages older than retentionDays. Returns number deleted.
export async function cleanupOldPages(retentionDays = RETENTION_DAYS_DEFAULT) {
  const db = await openDB();
  const store = tx(db, "pages", "readwrite");
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const all = await reqToPromise(store.getAll());
  let deleted = 0;
  for (const p of all) {
    const ts = p.lastVisitedAt || p.firstVisitedAt || 0;
    if (ts < cutoff) {
      store.delete(p.id);
      deleted++;
    }
  }
  return deleted;
}

// ---- search_cache ----

export async function cacheSearch(queryHash, results) {
  const db = await openDB();
  await reqToPromise(
    tx(db, "search_cache", "readwrite").put({
      queryHash,
      results,
      timestamp: Date.now(),
    })
  );
}

export async function getCachedSearch(queryHash) {
  const db = await openDB();
  return reqToPromise(tx(db, "search_cache", "readonly").get(queryHash));
}
