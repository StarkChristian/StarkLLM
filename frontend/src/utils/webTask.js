// Web tasks (docs/web-tasks.md): what the chat shows of a task, from the events of the desktop app (webtask.js).
// A pure function, so it can be tested without the app: reduce(state, event) -> new state.

export const initialWebTask = (task = '') => ({ status: 'starting', task, steps: [], ask: null, answer: '', url: '', title: '', error: '' });

// Saved web tasks are prompt templates with this tag (Templates in the chat); choosing one turns "Web task" on.
export const WEB_TASK_TAG = 'web-task';
export const isWebTaskTemplate = (template) => Boolean(template && String(template.tags || '').split(/[,\s]+/).includes(WEB_TASK_TAG));

export function reduceWebTask(state, e) {
  if (!e || !e.type) return state;
  switch (e.type) {
    case 'started':
      return { ...state, status: 'running', folder: e.folder || state.folder || '', ...(e.taskId ? { taskId: e.taskId } : {}) };
    case 'step':
      return {
        ...state,
        status: 'running',
        steps: [...state.steps, e.extra ? { action: e.action, detail: e.detail || '', extra: e.extra } : { action: e.action, detail: e.detail || '' }],
        url: e.url || state.url,
        title: e.title || state.title,
      };
    case 'ask':
      return { ...state, ask: { qid: e.qid, kind: e.ask, text: e.text || '', url: e.url || '', siteKind: e.kind || '', ...(e.extra ? { extra: e.extra } : {}) } };
    case 'answer':
      return { ...state, status: 'done', ask: null, answer: e.text || '', url: e.url || state.url, title: e.title || state.title, files: e.files || state.files || [] };
    case 'error':
      return { ...state, status: 'error', ask: null, error: e.text || '', files: e.files || state.files || [] };
    case 'stopped':
      return { ...state, status: 'stopped', ask: null, paused: false, files: e.files || state.files || [] };
    case 'paused':
      return { ...state, paused: true };
    case 'resumed':
      return { ...state, paused: false };
    case 'ended':
      // the end of the run: a task that ended without an answer, error or stop is not finished
      return state.status === 'running' || state.status === 'starting' ? { ...state, status: 'error', ask: null } : { ...state, ask: null };
    default:
      return state;
  }
}

// After the user answered a question in the chat, the question is gone until the next one.
export const answered = (state, qid) => (state.ask && state.ask.qid === qid ? { ...state, ask: null } : state);

// A follow-up ("and the 14th?"): the last finished web task of this chat, if the newest answer is one.
export function previousWebTask(messages) {
  for (let k = messages.length - 1; k > 0; k--) {
    const m = messages[k];
    if (m.role !== 'assistant') continue;
    // a web task answer loaded with its chat from the engine (the task ended while another chat was open)
    if (!m.webTask && m.sources && m.sources.web_task) {
      const asked = messages[k - 1];
      return { task: asked && asked.role === 'user' ? asked.content : '', answer: m.sources.answer || m.content || '' };
    }
    if (!m.webTask || m.webTask.status !== 'done') return null;
    const asked = messages[k - 1];
    // a follow-up of a follow-up: the whole task it stood for, not only its last words
    return { task: m.webTask.fullTask || (asked && asked.role === 'user' ? asked.content : ''), answer: m.webTask.answer || m.content || '' };
  }
  return null;
}

// A follow-up ("and next week?") saved as a template or repeated on a schedule runs without the chat around it
// (2.5.0 acceptance test: a weekly repeat of a follow-up did not know what it was about). The saved task is the task
// before it with the follow-up: label is the translated word that introduces the follow-up.
export function selfContainedTask(task, previous, label = 'Follow-up:') {
  const now = String(task || '').trim();
  const before = previous && String(previous.task || '').trim();
  if (!now || !before) return now;
  return `${before}\n\n${label} ${now}`.slice(0, 2000);
}

// The chat of a running web task, loaded again after the user was in another chat: its saved messages, then the
// question and the card of the running task (with a question it waits for). The id may come as a number or a string.
export function withLiveTask(messages, live, chatId) {
  if (!live || live.chatId == null || chatId == null || String(live.chatId) !== String(chatId)) return messages;
  const saved = messages.filter((m) => !m.greeting && m.liveId !== live.id);
  return [...saved, live.user, live.card];
}

// The title of a chat that holds a web task: the task, at once (not "New Chat" like an empty chat)
export const isUntitledChat = (title) => !title || title === 'New Chat' || title === 'Untitled Chat';
export const chatTitleOf = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 50);

// Can this page start web tasks? Only in the desktop app, which has the browser window and the bridge.
export const webTaskBridge = () => (typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.webTask) || null;
