// Content script: extract meaningful text from the visited page.
// Runs at document_idle; posts the extracted text to the background SW.

(function () {
  function extractText() {
    // Skip non-content pages handled by the SW (chrome://, pdf, etc.),
    // but guard here too in case injection is broad.
    if (location.protocol === "chrome:" || location.protocol === "about:") {
      return null;
    }

    // Extraction priority:
    // 1. <meta name="description">
    // 2. <article> content
    // 3. main body text
    // 4. fallback innerText
    const meta = document.querySelector('meta[name="description"]');
    const metaText = meta ? meta.getAttribute("content") || "" : "";

    let bodyText = "";
    const article = document.querySelector("article");
    if (article) {
      bodyText = article.innerText || "";
    }
    if (!bodyText.trim()) {
      const main = document.querySelector("main") || document.body;
      bodyText = main ? main.innerText || "" : "";
    }

    const combined = `${document.title}\n\n${metaText}\n\n${bodyText}`.replace(
      /\s+/g,
      " "
    ).trim();

    return combined.slice(0, 3000);
  }

  const text = extractText();
  if (!text) return;

  chrome.runtime.sendMessage({
    target: "content-extract",
    url: location.href,
    title: document.title,
    site: location.hostname,
    text,
  });
})();
