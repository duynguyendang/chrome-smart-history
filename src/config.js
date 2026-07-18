// Shared constants for Smart History MVP (local-only, no Cloudflare).

export const DB_NAME = "smart-history";
export const RETENTION_DAYS_DEFAULT = 90;
export const MAX_TEXT_CHARS = 3000;
export const EMBED_DIM = 768;
// MRL coarse-pass resolution. The 128-dim sub-vector is NOT stored — it is a
// zero-allocation `subarray(0, MRL_SUB_DIM)` view over the 768-dim vector.
export const MRL_SUB_DIM = 128;
export const DEFAULT_TOP_K = 10;
export const SIMILARITY_THRESHOLD = 0.0;

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
