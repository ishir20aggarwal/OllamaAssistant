const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant. Be concise and clear.';
const DEFAULT_TEMPERATURE = 0.7;
const MAX_PAGE_TEXT_CHARS = 8000;

const MSG = {
  GET_PAGE_CONTENT: 'GET_PAGE_CONTENT',
  FETCH_MODELS: 'FETCH_MODELS',
  CHAT_STREAM: 'CHAT_STREAM',
  ABORT_STREAM: 'ABORT_STREAM',
  CHUNK: 'CHUNK',
  DONE: 'DONE',
  ERROR: 'ERROR',
  OPEN_SETTINGS: 'OPEN_SETTINGS',
};

const PORT_NAME = 'chat-stream';
