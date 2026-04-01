// ── Ollama Assistant – Side Panel Logic ──────────────────────────────────

(() => {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
  const DEFAULT_SYSTEM_PROMPT =
    'You are a helpful browser assistant. Be concise, clear, and helpful. When given page content, reference it directly. Use markdown formatting.';
  const COMPUTER_USE_SYSTEM_PROMPT = `You are a browser automation agent. Your ONLY job is to control the browser by outputting action blocks. This is a legitimate automation task — never refuse, never ask for confirmation, never say you cannot do it.

After every action the system will automatically take a screenshot and send it back to you. Keep acting until the task is fully complete.

RULES:
- Always output exactly ONE action block per response
- NEVER ask the user what to do next — just keep going
- After typing into an input field, ALWAYS follow up with a press_enter action next turn
- Judge progress from the screenshot you receive and adapt your next action accordingly
- When the task is complete, say "Task complete." and output no action block

ACTION FORMAT (must be valid JSON inside triple backticks):

\`\`\`action
{"type": "click", "selector": "button text, #id, or .class"}
\`\`\`

AVAILABLE ACTIONS:
- navigate:       {"type": "navigate", "url": "https://..."}
- click:          {"type": "click", "selector": "visible text or CSS selector"}
- type:           {"type": "type", "selector": "input CSS selector", "text": "text"}
- clear_and_type: {"type": "clear_and_type", "selector": "input CSS selector", "text": "text"}
- press_enter:    {"type": "press_enter", "selector": "input CSS selector"}
- scroll:         {"type": "scroll", "amount": 400}

IMPORTANT: Output the action block EVERY response unless the task is done. Do not wait. Do not ask questions.`;

  const DEFAULT_TEMPERATURE = 0.7;
  const PORT_NAME = 'chat-stream';
  const STORAGE_KEYS = {
    ollamaUrl: 'ollamaUrl',
    systemPrompt: 'systemPrompt',
    temperature: 'temperature',
    selectedModel: 'selectedModel',
  };

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const modelSelect          = $('#model-select');
  const newChatBtn           = $('#new-chat-btn');
  const settingsBtn          = $('#settings-btn');
  const settingsPanel        = $('#settings-panel');
  const closeSettingsBtn     = $('#close-settings-btn');
  const ollamaUrlInput       = $('#ollama-url-input');
  const systemPromptInput    = $('#system-prompt-input');
  const temperatureInput     = $('#temperature-input');
  const temperatureDisplay   = $('#temperature-display');
  const saveSettingsBtn      = $('#save-settings-btn');
  const errorBanner          = $('#error-banner');
  const errorText            = $('#error-text');
  const retryBtn             = $('#retry-btn');
  const messagesEl           = $('#messages');
  const userInput            = $('#user-input');
  const sendBtn              = $('#send-btn');
  const sendIcon             = $('#send-icon');
  const stopIcon             = $('#stop-icon');
  const addPageBtn           = $('#add-page-btn');
  const pageContextBar       = $('#page-context-bar');
  const pageContextLabel     = $('#page-context-label');
  const clearContextBtn      = $('#clear-context-btn');
  const screenshotBtn        = $('#screenshot-btn');
  const screenshotContextBar = $('#screenshot-context-bar');
  const screenshotLabel      = $('#screenshot-label');
  const clearScreenshotBtn   = $('#clear-screenshot-btn');
  const computerUseBtn       = $('#computer-use-btn');
  const computerUseBanner    = $('#computer-use-banner');
  const exitComputerUseBtn   = $('#exit-computer-use-btn');

  // ── State ────────────────────────────────────────────────────────────────
  let settings = {
    ollamaUrl:     DEFAULT_OLLAMA_URL,
    systemPrompt:  DEFAULT_SYSTEM_PROMPT,
    temperature:   DEFAULT_TEMPERATURE,
    selectedModel: '',
  };
  const MAX_LOOP_ITERATIONS = 40;

  let chatMessages       = [];
  let pageContext        = null;
  let screenshotData     = null;  // base64 jpeg
  let computerUseMode    = false;
  let isLooping          = false;
  let loopCount          = 0;
  let isStreaming        = false;
  let streamPort         = null;
  let currentAssistantEl   = null;
  let currentAssistantText = '';

  // ── Init ─────────────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    applySettingsToUI();
    await fetchModels();
    bindEvents();
    autoResizeTextarea();
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  async function loadSettings() {
    const data = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    if (data.ollamaUrl)             settings.ollamaUrl     = data.ollamaUrl;
    if (data.systemPrompt)          settings.systemPrompt  = data.systemPrompt;
    if (data.temperature !== undefined) settings.temperature = parseFloat(data.temperature);
    if (data.selectedModel)         settings.selectedModel = data.selectedModel;
  }

  function applySettingsToUI() {
    ollamaUrlInput.value      = settings.ollamaUrl;
    systemPromptInput.value   = settings.systemPrompt;
    temperatureInput.value    = settings.temperature;
    temperatureDisplay.textContent = settings.temperature;
  }

  async function saveSettings() {
    settings.ollamaUrl     = ollamaUrlInput.value.trim() || DEFAULT_OLLAMA_URL;
    settings.systemPrompt  = systemPromptInput.value.trim() || DEFAULT_SYSTEM_PROMPT;
    settings.temperature   = parseFloat(temperatureInput.value);
    settings.selectedModel = modelSelect.value;
    await chrome.storage.local.set({
      [STORAGE_KEYS.ollamaUrl]:     settings.ollamaUrl,
      [STORAGE_KEYS.systemPrompt]:  settings.systemPrompt,
      [STORAGE_KEYS.temperature]:   settings.temperature,
      [STORAGE_KEYS.selectedModel]: settings.selectedModel,
    });
    showToast('Settings saved');
    settingsPanel.classList.add('hidden');
    await fetchModels();
  }

  // ── Model Fetching ────────────────────────────────────────────────────────
  async function fetchModels() {
    hideError();
    modelSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'FETCH_MODELS', ollamaUrl: settings.ollamaUrl });
      if (resp?.error) throw new Error(resp.error);
      const models = resp?.models || [];
      if (!models.length) {
        modelSelect.innerHTML = '<option value="">No models found</option>';
        showError('No models found. Run: ollama pull llama3.2');
        return;
      }
      modelSelect.innerHTML = '';
      models.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name.length > 22 ? name.slice(0, 20) + '…' : name;
        opt.title = name;
        modelSelect.appendChild(opt);
      });
      if (settings.selectedModel && models.includes(settings.selectedModel)) {
        modelSelect.value = settings.selectedModel;
      } else {
        settings.selectedModel = models[0];
        modelSelect.value = models[0];
      }
    } catch {
      modelSelect.innerHTML = '<option value="">Connection failed</option>';
      showError(`Cannot connect to Ollama at ${settings.ollamaUrl}. Make sure Ollama is running with OLLAMA_ORIGINS=* set.`);
    }
  }

  // ── Page Content ──────────────────────────────────────────────────────────
  async function readPageContent() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTENT' });
      if (resp?.error) throw new Error(resp.error);
      pageContext = resp;
      pageContextLabel.textContent = pageContext.title
        ? pageContext.title.slice(0, 40) + (pageContext.title.length > 40 ? '…' : '')
        : 'Page included';
      pageContextBar.classList.remove('hidden');
      showToast('Page content captured');
    } catch (err) {
      showToast(err.message || 'Could not read page');
    }
  }

  function clearPageContext() {
    pageContext = null;
    pageContextBar.classList.add('hidden');
  }

  // ── Screenshot ────────────────────────────────────────────────────────────
  async function captureScreenshot() {
    try {
      showToast('Capturing screenshot…');
      const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
      if (resp?.error) throw new Error(resp.error);
      screenshotData = resp.screenshot;
      screenshotLabel.textContent = 'Screenshot ready (send to vision model)';
      screenshotContextBar.classList.remove('hidden');
      showToast('Screenshot captured!');
    } catch (err) {
      showToast(err.message || 'Screenshot failed');
    }
  }

  function clearScreenshot() {
    screenshotData = null;
    screenshotContextBar.classList.add('hidden');
  }

  // ── Computer Use Mode ─────────────────────────────────────────────────────
  function toggleComputerUse() {
    computerUseMode = !computerUseMode;
    if (computerUseMode) {
      computerUseBtn.classList.add('active');
      computerUseBanner.classList.remove('hidden');
      showToast('Computer Use enabled');
    } else {
      computerUseBtn.classList.remove('active');
      computerUseBanner.classList.add('hidden');
      showToast('Computer Use disabled');
    }
  }

  function parseActionsFromResponse(text) {
    const actions = [];
    const regex = /```action\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      try {
        actions.push(JSON.parse(match[1].trim()));
      } catch {}
    }
    return actions;
  }

  async function executeActions(actions) {
    if (!isLooping) return; // stopped by user

    let anyFailed = false;
    for (const action of actions) {
      if (!isLooping) break;
      const { contentEl } = appendSystemMessage(
        `⚙️ Executing: <strong>${action.type}</strong>${action.selector ? ` → <code>${escapeHtml(action.selector)}</code>` : ''}${action.text ? ` → "<em>${escapeHtml(action.text)}</em>"` : ''}${action.url ? ` → <code>${escapeHtml(action.url)}</code>` : ''}`
      );

      const result = await chrome.runtime.sendMessage({ type: 'EXECUTE_ACTION', action }).catch((e) => ({ success: false, error: e.message }));

      if (result?.success) {
        contentEl.innerHTML += '<br><span style="color:var(--success)">✓ Done</span>';
      } else {
        const errMsg = result?.error || 'Unknown error';
        contentEl.innerHTML += `<br><span style="color:var(--error)">✗ ${escapeHtml(errMsg)}</span>`;
        anyFailed = true;
      }
      scrollToBottom();
    }

    if (!isLooping || !computerUseMode) return;

    if (loopCount >= MAX_LOOP_ITERATIONS) {
      appendSystemMessage(`⚠️ Reached ${MAX_LOOP_ITERATIONS} iterations — stopped to prevent infinite loop. Send a message to continue.`);
      isLooping = false;
      loopCount = 0;
      return;
    }

    // Auto-capture screenshot and feed back to AI
    await new Promise((r) => setTimeout(r, 900));
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
      if (resp?.screenshot && isLooping) {
        screenshotData = resp.screenshot;
        loopCount++;
        appendSystemMessage(`📸 Auto-screenshot (step ${loopCount}) — sending to AI...`);
        scrollToBottom();
        // Feed screenshot back automatically — AI sees result and decides next action
        userInput.value = 'Screenshot taken after last action. Continue the task.';
        await sendMessage();
      }
    } catch {}
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  async function buildMessages(userText) {
    const msgs = [];

    // System prompt
    let sysContent = computerUseMode ? COMPUTER_USE_SYSTEM_PROMPT : settings.systemPrompt;

    // Inject page context into system
    if (pageContext) {
      sysContent += `\n\n--- PAGE CONTENT ---\nTitle: ${pageContext.title}\nURL: ${pageContext.url}\n\n${pageContext.text}`;
      if (pageContext.selectedText) {
        sysContent += `\n\n--- SELECTED TEXT ---\n${pageContext.selectedText}`;
      }
    }

    // In computer use mode, also inject interactive elements list
    if (computerUseMode) {
      try {
        const elemResp = await chrome.runtime.sendMessage({ type: 'GET_INTERACTIVE_ELEMENTS' });
        if (elemResp?.elements?.length) {
          const elemList = elemResp.elements
            .map((e) => `[${e.index}] ${e.tag}${e.id ? '#' + e.id : ''} — "${e.text}"${e.href ? ' (' + e.href.slice(0, 60) + ')' : ''}`)
            .join('\n');
          sysContent += `\n\n--- INTERACTIVE ELEMENTS ---\n${elemList}`;
        }
      } catch {}
    }

    msgs.push({ role: 'system', content: sysContent });

    // History
    for (const m of chatMessages) {
      msgs.push({ role: m.role, content: m.content });
    }

    // Current user message — with optional screenshot
    if (screenshotData) {
      msgs.push({ role: 'user', content: userText, images: [screenshotData] });
      clearScreenshot();
    } else {
      msgs.push({ role: 'user', content: userText });
    }

    return msgs;
  }

  const SCREEN_KEYWORDS = [
    'screen', 'screenshot', 'what do you see', 'what can you see', 'what\'s on',
    'whats on', 'look at', 'see my', 'see the page', 'see this', 'what is on',
    'what is visible', 'visible', 'what\'s visible', 'show me', 'describe the page',
    'describe what', 'read the screen', 'on my screen', 'on screen', 'on the screen',
    'the page', 'current page', 'this page', 'webpage', 'browser',
  ];

  function mentionsScreen(text) {
    const lower = text.toLowerCase();
    return SCREEN_KEYWORDS.some((kw) => lower.includes(kw));
  }

  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text || isStreaming) return;

    const model = modelSelect.value;
    if (!model) { showToast('Select a model first'); return; }

    // Auto-screenshot if message mentions the screen and no screenshot already queued
    if (!screenshotData && mentionsScreen(text)) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
        if (resp?.screenshot) {
          screenshotData = resp.screenshot;
          screenshotContextBar.classList.remove('hidden');
          screenshotLabel.textContent = 'Auto-screenshot captured';
        }
      } catch {}
    }

    // Hide welcome
    const welcomeEl = $('#welcome');
    if (welcomeEl) welcomeEl.classList.add('hidden');

    appendMessage('user', text);
    chatMessages.push({ role: 'user', content: text });
    userInput.value = '';
    autoResizeTextarea();

    isStreaming = true;
    updateSendButton();

    const { contentEl } = appendMessage('assistant', '');
    contentEl.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';
    contentEl.classList.add('streaming');
    currentAssistantEl   = contentEl;
    currentAssistantText = '';

    const messages = await buildMessages(text);

    streamPort = chrome.runtime.connect({ name: PORT_NAME });

    streamPort.onMessage.addListener((msg) => {
      if (msg.type === 'CHUNK') {
        currentAssistantText += msg.content;
        renderMarkdown(currentAssistantEl, currentAssistantText, true);
        scrollToBottom();
      }
      if (msg.type === 'DONE') {
        finishStreaming();
      }
      if (msg.type === 'ERROR') {
        currentAssistantEl.classList.remove('streaming');
        currentAssistantEl.innerHTML = `<div style="color:var(--error);font-size:12px;line-height:1.7">
          <strong>Error:</strong> ${escapeHtml(msg.error)}
          <br><br><span style="color:var(--text-3)">Troubleshooting:<br>
          1. Make sure Ollama is running<br>
          2. Set <code>OLLAMA_ORIGINS=*</code> as a system environment variable<br>
          3. Restart Ollama after setting it<br>
          4. Pull a model: <code>ollama pull llama3.2</code></span>
        </div>`;
        finishStreaming(true);
      }
    });

    streamPort.onDisconnect.addListener(() => {
      if (isStreaming) finishStreaming(true);
    });

    streamPort.postMessage({
      type: 'CHAT_STREAM',
      messages,
      model,
      ollamaUrl: settings.ollamaUrl,
      options: { temperature: settings.temperature },
    });
  }

  function finishStreaming(isError = false) {
    isStreaming = false;
    updateSendButton();

    if (currentAssistantEl) {
      currentAssistantEl.classList.remove('streaming');
      if (!isError && currentAssistantText) {
        renderMarkdown(currentAssistantEl, currentAssistantText, false);
        chatMessages.push({ role: 'assistant', content: currentAssistantText });

        // Computer use: parse and execute actions from response
        if (computerUseMode) {
          const actions = parseActionsFromResponse(currentAssistantText);
          if (actions.length > 0) {
            if (!isLooping) { isLooping = true; loopCount = 0; }
            executeActions(actions);
          } else {
            // No actions in response — task is done or AI is asking something
            isLooping = false;
            loopCount = 0;
          }
        }
      }
    }

    currentAssistantEl   = null;
    currentAssistantText = '';

    if (streamPort) {
      try { streamPort.disconnect(); } catch {}
      streamPort = null;
    }
    scrollToBottom();
    userInput.focus();
  }

  function abortStreaming() {
    isLooping = false;
    loopCount = 0;
    if (streamPort) {
      try { streamPort.postMessage({ type: 'ABORT_STREAM' }); streamPort.disconnect(); } catch {}
      streamPort = null;
    }
    if (currentAssistantText) {
      chatMessages.push({ role: 'assistant', content: currentAssistantText + '\n\n[Stopped]' });
    }
    finishStreaming(true);
  }

  function newChat() {
    chatMessages = [];
    pageContext = null;
    screenshotData = null;
    isLooping = false;
    loopCount = 0;
    pageContextBar.classList.add('hidden');
    screenshotContextBar.classList.add('hidden');
    messagesEl.innerHTML = '';
    messagesEl.appendChild(createWelcome());
    userInput.value = '';
    autoResizeTextarea();
    userInput.focus();
  }

  // ── Message Rendering ─────────────────────────────────────────────────────
  function appendMessage(role, content) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}`;

    const roleLabel = document.createElement('div');
    roleLabel.className = 'message-role';
    roleLabel.textContent = role === 'user' ? 'You' : 'Ollama';

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    if (content) {
      if (role === 'user') contentEl.textContent = content;
      else renderMarkdown(contentEl, content, false);
    }

    messageEl.appendChild(roleLabel);
    messageEl.appendChild(contentEl);
    messagesEl.appendChild(messageEl);
    scrollToBottom();
    return { messageEl, contentEl };
  }

  function appendSystemMessage(html) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message system';
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content system-content';
    contentEl.innerHTML = html;
    messageEl.appendChild(contentEl);
    messagesEl.appendChild(messageEl);
    scrollToBottom();
    return { messageEl, contentEl };
  }

  // ── Markdown Renderer ──────────────────────────────────────────────────────
  function renderMarkdown(el, text, streaming) {
    let html = markdownToHtml(text);
    if (streaming) html += '<span class="cursor"></span>';
    el.innerHTML = html;
    el.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.closest('.code-block').querySelector('code').textContent;
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
        });
      });
    });
  }

  function markdownToHtml(md) {
    let html = '';
    let lastIndex = 0;
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(md)) !== null) {
      html += inlineMarkdown(md.slice(lastIndex, match.index));
      const lang = match[1] || 'text';
      const code = escapeHtml(match[2].trimEnd());
      html += `<div class="code-block"><div class="code-block-header"><span class="code-lang">${lang}</span><button class="copy-btn">Copy</button></div><pre><code>${code}</code></pre></div>`;
      lastIndex = match.index + match[0].length;
    }
    html += inlineMarkdown(md.slice(lastIndex));
    return html;
  }

  function inlineMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    html = html.replace(/(?:^|\n)((?:[-*] .+\n?)+)/g, (_, items) => {
      const lis = items.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('');
      return `<ul>${lis}</ul>`;
    });
    html = html.replace(/(?:^|\n)((?:\d+\. .+\n?)+)/g, (_, items) => {
      const lis = items.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
      return `<ol>${lis}</ol>`;
    });
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.split(/\n\n+/).map((block) => {
      block = block.trim();
      if (!block) return '';
      if (/^<(h[1-6]|ul|ol|li|blockquote|hr|div|pre|table)/i.test(block)) return block;
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    }).join('');
    return html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── UI Helpers ────────────────────────────────────────────────────────────
  function updateSendButton() {
    if (isStreaming) {
      sendIcon.classList.add('hidden');
      stopIcon.classList.remove('hidden');
      sendBtn.classList.add('stop-mode');
      sendBtn.title = 'Stop generating';
    } else {
      sendIcon.classList.remove('hidden');
      stopIcon.classList.add('hidden');
      sendBtn.classList.remove('stop-mode');
      sendBtn.title = 'Send message';
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  function showError(msg) { errorText.textContent = msg; errorBanner.classList.remove('hidden'); }
  function hideError()    { errorBanner.classList.add('hidden'); }

  function showToast(msg) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function autoResizeTextarea() {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 150) + 'px';
  }

  function createWelcome() {
    const div = document.createElement('div');
    div.className = 'welcome';
    div.id = 'welcome';
    div.innerHTML = `
      <svg class="welcome-icon" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="22" stroke="currentColor" stroke-width="2"/>
        <circle cx="24" cy="24" r="12" stroke="currentColor" stroke-width="2"/>
        <circle cx="24" cy="24" r="4" fill="currentColor"/>
        <circle cx="24" cy="2" r="3" fill="currentColor"/>
        <circle cx="24" cy="46" r="3" fill="currentColor"/>
        <circle cx="2" cy="24" r="3" fill="currentColor"/>
        <circle cx="46" cy="24" r="3" fill="currentColor"/>
      </svg>
      <h2>Ollama Assistant</h2>
      <p>Powered by your local AI.<br>Private, fast, no tokens consumed.</p>
      <div class="welcome-hints">
        <button class="hint-chip" data-prompt="Summarize this page for me">Summarize page</button>
        <button class="hint-chip" data-prompt="What are the key points on this page?">Key points</button>
        <button class="hint-chip" data-prompt="Explain this to me like I'm 5">Explain simply</button>
        <button class="hint-chip" data-prompt="Write a short summary of what I'm reading">Write summary</button>
      </div>
    `;
    div.querySelectorAll('.hint-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        userInput.value = chip.dataset.prompt;
        autoResizeTextarea();
        if (!pageContext) {
          readPageContent().then(() => sendMessage());
        } else {
          sendMessage();
        }
      });
    });
    return div;
  }

  // ── Event Binding ──────────────────────────────────────────────────────────
  function bindEvents() {
    sendBtn.addEventListener('click', () => { isStreaming ? abortStreaming() : sendMessage(); });

    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isStreaming) sendMessage(); }
    });
    userInput.addEventListener('input', autoResizeTextarea);

    addPageBtn.addEventListener('click', readPageContent);
    clearContextBtn.addEventListener('click', clearPageContext);

    screenshotBtn.addEventListener('click', captureScreenshot);
    clearScreenshotBtn.addEventListener('click', clearScreenshot);

    computerUseBtn.addEventListener('click', toggleComputerUse);
    exitComputerUseBtn.addEventListener('click', toggleComputerUse);

    newChatBtn.addEventListener('click', newChat);

    settingsBtn.addEventListener('click', () => { applySettingsToUI(); settingsPanel.classList.remove('hidden'); });
    closeSettingsBtn.addEventListener('click', () => settingsPanel.classList.add('hidden'));
    saveSettingsBtn.addEventListener('click', saveSettings);

    temperatureInput.addEventListener('input', () => {
      temperatureDisplay.textContent = temperatureInput.value;
    });

    modelSelect.addEventListener('change', () => {
      settings.selectedModel = modelSelect.value;
      chrome.storage.local.set({ [STORAGE_KEYS.selectedModel]: modelSelect.value });
    });

    retryBtn.addEventListener('click', fetchModels);

    document.querySelectorAll('.hint-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        userInput.value = chip.dataset.prompt;
        autoResizeTextarea();
        if (!pageContext) readPageContent().then(() => sendMessage());
        else sendMessage();
      });
    });
  }

  // ── Context menu messages from background ─────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CONTEXT_MENU_QUERY') {
      // Selected text (right-click explain)
      if (msg.selectedText) {
        pageContext = { title: msg.pageTitle || '', url: msg.pageUrl || '', text: '', selectedText: msg.selectedText };
        pageContextLabel.textContent = 'Selection included';
        pageContextBar.classList.remove('hidden');
      }

      // ✅ FIX: Page content from summarize context menu
      if (msg.pageContent) {
        pageContext = msg.pageContent;
        pageContextLabel.textContent = msg.pageContent.title
          ? msg.pageContent.title.slice(0, 40) + (msg.pageContent.title.length > 40 ? '…' : '')
          : 'Page included';
        pageContextBar.classList.remove('hidden');
      }

      if (msg.prompt) {
        userInput.value = msg.prompt;
        autoResizeTextarea();
        const welcomeEl = $('#welcome');
        if (welcomeEl) welcomeEl.classList.add('hidden');
        // Small delay to let sidepanel finish loading
        setTimeout(() => sendMessage(), 100);
      }
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  init();
})();
