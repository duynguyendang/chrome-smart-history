// Options page: persist settings to chrome.storage.local.

import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../config.js";

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(s[SETTINGS_KEY] || {}) };
  $("enabled").checked = settings.enabled;
  $("retention").value = settings.retentionDays;
  $("captureDelay").value = settings.captureDelayMs;
}

async function save() {
  const settings = {
    enabled: $("enabled").checked,
    retentionDays: Number($("retention").value) || DEFAULT_SETTINGS.retentionDays,
    captureDelayMs: Number($("captureDelay").value) || DEFAULT_SETTINGS.captureDelayMs,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  const saved = $("saved");
  saved.textContent = "Saved ✓";
  setTimeout(() => (saved.textContent = ""), 1500);
}

$("save").addEventListener("click", save);
load();
