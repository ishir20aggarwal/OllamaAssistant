// Content script — minimal listener, extraction is done via executeScript in the service worker
// This file is kept as a lightweight fallback for direct messaging from the sidepanel

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_CONTENT') {
    const MAX_CHARS = 8000;

    function cleanText(el) {
      const clone = el.cloneNode(true);
      const remove = clone.querySelectorAll(
        'script,style,nav,footer,header,aside,[aria-hidden="true"]'
      );
      remove.forEach((n) => n.remove());
      return (clone.innerText || clone.textContent || '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    }

    let text = '';
    const main = document.querySelector('main, article, [role="main"], .content, #content, #main');
    if (main) text = cleanText(main);
    if (!text || text.length < 200) text = cleanText(document.body);

    const selectedText = window.getSelection()?.toString().trim() || '';

    sendResponse({
      title: document.title,
      url: location.href,
      text: text.slice(0, MAX_CHARS) + (text.length > MAX_CHARS ? '\n\n[Content truncated...]' : ''),
      selectedText,
    });
  }
});
