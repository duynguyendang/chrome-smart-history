// Shared constants for Smart History MVP (local-only, no Cloudflare).

export const DB_NAME = "smart-history";
export const RETENTION_DAYS_DEFAULT = 90;
export const MAX_TEXT_CHARS = 3000;
export const EMBED_DIM = 768;
export const DEFAULT_TOP_K = 10;
// Different cutoffs for the two entry points:
//  - SIMILAR_CURRENT (popup opens on the active tab): stricter, so only
//    pages genuinely similar to the current tab are shown.
//  - SEARCH (free-text query): looser, so results are not hidden when the
//    query is broad or loosely related.
export const SIMILAR_THRESHOLD = 0.3;
export const SEARCH_THRESHOLD = 0.0;

export const SETTINGS_KEY = "settings";
export const DEVICE_ID_KEY = "deviceId";

export const DEFAULT_SETTINGS = {
  enabled: true,
  retentionDays: RETENTION_DAYS_DEFAULT,
  captureDelayMs: 1500,
  topK: DEFAULT_TOP_K,
};

// Offscreen document target for the Embedding API (needs a window context).
export const OFFSCREEN_TARGET = "src/offscreen/offscreen.html";
