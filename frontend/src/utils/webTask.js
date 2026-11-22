// Web tasks (docs/web-tasks.md): what the chat shows of a task, from the events of the desktop app (webtask.js).
// A pure function, so it can be tested without the app: reduce(state, event) -> new state.

export const initialWebTask = () => ({ status: 'starting', steps: [], ask: null, answer: '', url: '', title: '', error: '' });

export function reduceWebTask(state, e) {
  if (!e || !e.type) return state;
  switch (e.type) {
    case 'started':
      return { ...state, status: 'running' };
    case 'step':
      return {
        ...state,
        status: 'running',
        steps: [...state.steps, { action: e.action, detail: e.detail || '' }],
        url: e.url || state.url,
        title: e.title || state.title,
      };
    case 'ask':
      return { ...state, ask: { qid: e.qid, kind: e.ask, text: e.text || '', url: e.url || '', siteKind: e.kind || '' } };
    case 'answer':
      return { ...state, status: 'done', ask: null, answer: e.text || '', url: e.url || state.url, title: e.title || state.title };
    case 'error':
      return { ...state, status: 'error', ask: null, error: e.text || '' };
    case 'stopped':
      return { ...state, status: 'stopped', ask: null, paused: false };
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
    if (!m.webTask || m.webTask.status !== 'done') return null;
    const asked = messages[k - 1];
    return { task: asked && asked.role === 'user' ? asked.content : '', answer: m.webTask.answer || m.content || '' };
  }
  return null;
}

// Can this page start web tasks? Only in the desktop app, which has the browser window and the bridge.
export const webTaskBridge = () => (typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.webTask) || null;
