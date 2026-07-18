// Popup UI logic: semantic search over local history.

const $ = (id) => document.getElementById(id);
const queryInput = $("query");
const searchBtn = $("searchBtn");
const resultsEl = $("results");
const statusEl = $("status");
const statsEl = $("stats");

function setStatus(text) {
  statusEl.textContent = text || "";
}

function renderResults(results, isRecent = false) {
  resultsEl.innerHTML = "";
  if (!results || results.length === 0) {
    resultsEl.innerHTML = `<div class="empty">No matches. Try different words, or keep browsing to build your memory.</div>`;
    return;
  }
  for (const r of results) {
    const li = document.createElement("li");
    const when = new Date(r.visitedAt).toLocaleDateString();
    const scoreLabel = isRecent ? "recent" : `${(r.score * 100).toFixed(0)}%`;
    li.innerHTML = `
      <span class="score">${scoreLabel}</span>
      <a class="title" href="${r.url}" target="_blank" rel="noopener">${escapeHtml(
      r.title || r.url
    )}</a>
      <div class="meta">${escapeHtml(r.site || "")} · ${when}</div>
      <div class="snippet">${escapeHtml(r.snippet || "")}</div>
    `;
    resultsEl.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function doSearch() {
  const query = queryInput.value.trim();
  if (!query) return;
  setStatus("Embedding query…");
  searchBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      target: "popup",
      type: "SEARCH",
      query,
      topK: 10,
    });
    if (!res.ok) {
      setStatus("⚠ " + (res.error || "Search failed"));
      return;
    }
    setStatus(`${res.results.length} results`);
    renderResults(res.results, false);
  } catch (e) {
    setStatus("⚠ " + e.message);
  } finally {
    searchBtn.disabled = false;
  }
}

async function loadStats() {
  try {
    const res = await chrome.runtime.sendMessage({ target: "popup", type: "STATS" });
    if (res?.ok) {
      statsEl.textContent = `${res.count} pages indexed`;
    }
  } catch (_) {}
}

async function loadSimilar() {
  try {
    const res = await chrome.runtime.sendMessage({
      target: "popup",
      type: "SIMILAR_CURRENT",
      topK: 10,
    });
    if (res?.ok) {
      renderResults(res.results, !res.similar);
      setStatus(res.similar ? "Similar to current tab" : "Recently visited");
    }
  } catch (_) {}
}

searchBtn.addEventListener("click", doSearch);
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});
queryInput.addEventListener("input", () => {
  if (!queryInput.value.trim()) loadSimilar();
});

$("optionsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$("clearBtn").addEventListener("click", async () => {
  if (!confirm("Delete all indexed pages from this device?")) return;
  const res = await chrome.runtime.sendMessage({ target: "popup", type: "CLEAR_ALL" });
  if (res?.ok) {
    setStatus("Cleared all pages.");
    queryInput.value = "";
    loadStats();
    loadSimilar();
  } else {
    setStatus("⚠ " + (res?.error || "Clear failed"));
  }
});

$("indexBtn").addEventListener("click", async () => {
  setStatus("Indexing current tab…");
  $("indexBtn").disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      target: "popup",
      type: "INDEX_CURRENT",
    });
    if (res?.ok) setStatus("✓ Indexed current tab.");
    else setStatus("⚠ " + (res?.error || res?.reason || "Index failed"));
    loadStats();
    loadSimilar();
  } catch (e) {
    setStatus("⚠ " + e.message);
  } finally {
    $("indexBtn").disabled = false;
  }
});

loadStats();
loadSimilar();
queryInput.focus();
