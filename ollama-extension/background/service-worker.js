// Service worker — routes messages, proxies Ollama API, handles streaming

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const PORT_NAME = 'chat-stream';

// Open side panel when toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Set side panel to open on action click + register context menus
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({ id: 'ollama-explain', title: 'Ask Ollama about "%s"', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'ollama-summarize', title: 'Summarize this page with Ollama', contexts: ['page'] });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });

  setTimeout(async () => {
    if (info.menuItemId === 'ollama-explain' && info.selectionText) {
      chrome.runtime.sendMessage({
        type: 'CONTEXT_MENU_QUERY',
        selectedText: info.selectionText,
        pageTitle: tab.title,
        pageUrl: tab.url,
        prompt: `Explain this:\n\n"${info.selectionText}"`,
      });
    }

    if (info.menuItemId === 'ollama-summarize') {
      // ✅ FIX: Read page content first, then send it along with the prompt
      const pageContent = await handleGetPageContent().catch(() => null);
      chrome.runtime.sendMessage({
        type: 'CONTEXT_MENU_QUERY',
        selectedText: '',
        pageTitle: tab.title,
        pageUrl: tab.url,
        pageContent,
        prompt: 'Summarize this page for me',
      });
    }
  }, 600);
});

// Handle one-shot messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_MODELS') {
    handleFetchModels(msg.ollamaUrl || DEFAULT_OLLAMA_URL)
      .then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'GET_PAGE_CONTENT') {
    handleGetPageContent()
      .then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_SCREENSHOT') {
    handleCaptureScreenshot()
      .then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'EXECUTE_ACTION') {
    handleExecuteAction(msg.action)
      .then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'GET_INTERACTIVE_ELEMENTS') {
    handleGetInteractiveElements()
      .then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'OPEN_SETTINGS') {
    chrome.runtime.openOptionsPage();
    return false;
  }
});

// Handle long-lived port connections for streaming
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  let abortController = null;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'CHAT_STREAM') {
      abortController = new AbortController();
      try {
        await handleChatStream(port, msg, abortController.signal);
      } catch (err) {
        if (err.name !== 'AbortError') {
          try {
            await handleChatNonStreaming(port, msg);
          } catch (fallbackErr) {
            safePostMessage(port, { type: 'ERROR', error: buildErrorMessage(fallbackErr) });
          }
        }
      }
    }
    if (msg.type === 'ABORT_STREAM') {
      abortController?.abort();
      abortController = null;
    }
  });

  port.onDisconnect.addListener(() => {
    abortController?.abort();
    abortController = null;
  });
});

// ── Core handlers ──────────────────────────────────────────────────────────

async function handleFetchModels(ollamaUrl) {
  const resp = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return { models: (data.models || []).map((m) => m.name) };
}

async function handleGetPageContent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');

  const url = tab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('edge://')) {
    throw new Error('Cannot read browser internal pages (chrome://, about:, etc). Navigate to a real webpage first.');
  }

  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageContent });
    if (results?.[0]?.result) return results[0].result;
    throw new Error('Script returned no content');
  } catch (scriptErr) {
    // Fallback: try messaging the already-injected content script
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTENT' });
      if (resp?.text) return resp;
      throw new Error('Content script returned no content');
    } catch {
      throw new Error(`Page is not accessible. Try refreshing the page. (${scriptErr.message})`);
    }
  }
}

async function handleCaptureScreenshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 });
    return { screenshot: dataUrl.split(',')[1], title: tab.title, url: tab.url };
  } catch (err) {
    throw new Error(`Screenshot failed: ${err.message}. Make sure you are on a real webpage (not chrome:// pages).`);
  }
}

async function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        // Extra pause for JS frameworks to initialise
        setTimeout(resolve, 1800);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function handleExecuteAction(action) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  if (action.type === 'navigate') {
    await chrome.tabs.update(tab.id, { url: action.url });
    await waitForTabLoad(tab.id);
    return { success: true };
  }

  // Small settle delay so dynamic pages have time to render
  await new Promise((r) => setTimeout(r, 600));

  // Re-query tab in case navigation happened between actions
  const [freshTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetId = freshTab?.id || tab.id;

  const tabInfo = await chrome.tabs.get(targetId).catch(() => null);
  const tabUrl = tabInfo?.url || '';
  if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('about:')) {
    throw new Error(`Cannot run scripts on ${tabUrl} — navigate to a real webpage first`);
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetId },
    func: executePageAction,
    args: [action],
  });
  return results?.[0]?.result || { success: false };
}

async function handleGetInteractiveElements() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractInteractiveElements });
  return results?.[0]?.result || { elements: [] };
}

// ── Functions injected into the page ──────────────────────────────────────

function extractPageContent() {
  const MAX_CHARS = 8000;
  function cleanText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,nav,footer,header,aside,[aria-hidden="true"],.ad,.ads,.advertisement')
      .forEach((n) => n.remove());
    return (clone.innerText || clone.textContent || '')
      .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }
  let text = '';
  const main = document.querySelector('main, article, [role="main"], .content, #content, #main');
  if (main) text = cleanText(main);
  if (!text || text.length < 200) text = cleanText(document.body);
  const selectedText = window.getSelection()?.toString().trim() || '';
  return {
    title: document.title,
    url: location.href,
    text: text.slice(0, MAX_CHARS) + (text.length > MAX_CHARS ? '\n\n[Content truncated...]' : ''),
    selectedText,
  };
}

function executePageAction(action) {
  try {
    function findEl(selector) {
      if (!selector) return null;
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch {}
      // Fallback: find by visible text
      const candidates = document.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="link"]');
      for (const el of candidates) {
        const txt = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (txt.includes(selector.toLowerCase())) return el;
      }
      return null;
    }

    if (action.type === 'click') {
      const el = findEl(action.selector);
      if (!el) return { success: false, error: `Not found: ${action.selector}` };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { success: true, info: el.tagName + (el.id ? '#' + el.id : '') };
    }

    if (action.type === 'type') {
      const el = findEl(action.selector);
      if (!el) return { success: false, error: `Not found: ${action.selector}` };
      el.focus();
      el.value = action.text || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    }

    if (action.type === 'clear_and_type') {
      const el = findEl(action.selector);
      if (!el) return { success: false, error: `Not found: ${action.selector}` };
      el.focus();
      el.select();
      el.value = action.text || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    }

    if (action.type === 'press_enter') {
      const el = action.selector ? document.querySelector(action.selector) : document.activeElement;
      if (el) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
      }
      return { success: true };
    }

    if (action.type === 'scroll') {
      const el = action.selector ? document.querySelector(action.selector) : null;
      (el || document.documentElement).scrollBy({ top: action.amount || 300, behavior: 'smooth' });
      return { success: true };
    }

    return { success: false, error: `Unknown action type: ${action.type}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function extractInteractiveElements() {
  const sel = 'button:not([disabled]),a[href],input:not([type="hidden"]):not([disabled]),select,textarea,[role="button"],[role="link"]';
  const elements = Array.from(document.querySelectorAll(sel))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.offsetParent !== null;
    })
    .slice(0, 60);

  return {
    elements: elements.map((el, i) => ({
      index: i,
      tag: el.tagName.toLowerCase(),
      type: el.type || el.getAttribute('role') || '',
      text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 80),
      id: el.id || '',
      name: el.name || '',
      href: (el.href || '').slice(0, 80),
    })).filter((el) => el.text || el.id || el.href),
  };
}

// ── Streaming chat ─────────────────────────────────────────────────────────

async function handleChatStream(port, msg, signal) {
  const { messages, model, ollamaUrl, options } = msg;
  const url = `${ollamaUrl || DEFAULT_OLLAMA_URL}/api/chat`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: { temperature: options?.temperature ?? 0.7 } }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw err;
  }

  if (!resp.ok) {
    let errText = `HTTP ${resp.status}`;
    try { errText = await resp.text(); } catch {}
    safePostMessage(port, { type: 'ERROR', error: errText });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotAny = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed);
          const content = data?.message?.content;
          if (content) { gotAny = true; safePostMessage(port, { type: 'CHUNK', content }); }
          if (data?.done) { safePostMessage(port, { type: 'DONE' }); return; }
        } catch {}
      }
    }
    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer.trim());
        const content = data?.message?.content;
        if (content) safePostMessage(port, { type: 'CHUNK', content });
      } catch {}
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (gotAny) { safePostMessage(port, { type: 'DONE' }); return; }
    throw err;
  }
  safePostMessage(port, { type: 'DONE' });
}

async function handleChatNonStreaming(port, msg) {
  const { messages, model, ollamaUrl, options } = msg;
  const url = `${ollamaUrl || DEFAULT_OLLAMA_URL}/api/chat`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: options?.temperature ?? 0.7 } }),
  });
  if (!resp.ok) {
    let errText = `HTTP ${resp.status}`;
    try { errText = await resp.text(); } catch {}
    throw new Error(errText);
  }
  const data = await resp.json();
  const content = data?.message?.content;
  if (content) safePostMessage(port, { type: 'CHUNK', content });
  safePostMessage(port, { type: 'DONE' });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildErrorMessage(err) {
  const msg = err.message || String(err);
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('TypeError'))
    return 'Cannot reach Ollama. Make sure it is running and OLLAMA_ORIGINS=* is set, then restart Ollama.';
  if (msg.includes('403') || msg.includes('Forbidden'))
    return 'Ollama rejected the request (403). Set OLLAMA_ORIGINS=* as a system environment variable and restart Ollama.';
  if (msg.includes('404'))
    return 'Model not found. Pull it first: ollama pull llama3.2';
  return msg;
}

function safePostMessage(port, msg) {
  try { port.postMessage(msg); } catch {}
}
