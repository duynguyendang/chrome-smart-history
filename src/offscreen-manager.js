// Ensure a single offscreen document exists for embedding.

import { OFFSCREEN_TARGET } from "./config.js";

let creating = null;
let initialized = false;

async function offscreenExists() {
  if (typeof chrome === "undefined" || !chrome.offscreen) return false;
  // hasDocument is newer; fall back to listing existing documents.
  if (typeof chrome.offscreen.hasDocument === "function") {
    try {
      return await chrome.offscreen.hasDocument(OFFSCREEN_TARGET);
    } catch (_) {
      return false;
    }
  }
  return false;
}

export async function ensureOffscreen() {
  if (typeof chrome === "undefined" || !chrome.offscreen) {
    console.warn(
      "[smart-history] chrome.offscreen API unavailable in this Chrome build. " +
        "Update to a Chrome Canary that supports the Offscreen API."
    );
    return;
  }

  if (initialized || (await offscreenExists())) {
    initialized = true;
    return;
  }

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_TARGET,
        reasons: ["EMBEDDING"],
        justification:
          "Run on-device EmbeddingGemma for semantic history search.",
      })
      .then(() => {
        initialized = true;
      })
      .catch((e) => {
        console.warn("[smart-history] offscreen create failed:", e);
      })
      .finally(() => {
        creating = null;
      });
  }
  return creating;
}
