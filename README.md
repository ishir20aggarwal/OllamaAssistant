# Ollama Assistant

A Chrome extension that adds a side panel chat interface powered by a local Ollama instance. No API keys, no cloud, no cost — all inference runs on your machine.

## Requirements

- [Ollama](https://ollama.com) running locally on `http://localhost:11434`
- At least one model pulled (e.g. `ollama pull llama3.2-vision`)
- Chrome or a Chromium-based browser

## Installation

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Click the extension icon to open the side panel

## Features

**Chat** — standard back-and-forth with any model available in your Ollama instance.

**Page context** — click the page button to pull the current page's text into the conversation so the model can reference it.

**Screenshot** — captures the visible tab and attaches it as an image. Works with vision-capable models (e.g. `llama3.2-vision`).

**Computer Use mode** — the model can autonomously control the browser by outputting structured action blocks. After each action, a screenshot is taken automatically and fed back to the model so it can see the result and decide the next step. Actions include:
- `navigate` — go to a URL
- `click` — click an element
- `type` / `clear_and_type` — type text into a field
- `press_enter` — submit a form
- `scroll` — scroll the page

The loop runs up to 40 iterations before stopping. Hit the stop button at any time to interrupt.

## Settings

Accessible via the gear icon in the side panel:

| Setting | Default |
|---|---|
| Ollama URL | `http://localhost:11434` |
| Temperature | `0.7` |
| System prompt | General assistant |

Settings are saved to Chrome's local storage.

## File Structure

```
ollama-extension/
  manifest.json              # Extension manifest (MV3)
  background/
    service-worker.js        # Handles streaming, action execution, screenshots
  content/
    content-script.js        # Injected into pages — executes DOM actions
  sidepanel/
    sidepanel.html/css/js    # Main UI and chat logic
  shared/
    constants.js             # Shared values across contexts
  icons/                     # Extension icons (16/48/128px)
```
