// Tool servers (MCP) of the user (docs/roadmap-2026-12.md, R6): only in the desktop app, which starts them.
export const mcpBridge = () => (typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.mcp) || null;

// A tool name of an outside server: ext__<server>__<tool>
export const isExternalTool = (name) => /^ext__[a-z0-9-]{1,40}__[A-Za-z0-9_.-]{1,64}$/.test(String(name || ''));
export const externalToolLabel = (name) => { const m = String(name || '').match(/^ext__[^_]+__(.+)$/); return m ? m[1] : String(name || ''); };
