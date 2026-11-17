// Reads from or presses something in the StarkLLM window through Chromium's remote debugging port, the way a user
// would click (the app is started with --remote-debugging-port=9333). Used by clean-pc-first-answer.yml.
//   node cdp.mjs "<JavaScript expression>"   prints the value as JSON (null when no window is there yet)
const expr = process.argv[2];
const port = process.env.CDP_PORT || 9333;
try {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no window yet');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('debugging connection failed')); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer from the window')), 10000);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 1) { clearTimeout(timer); resolve(d.result); }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  console.log(JSON.stringify(result && result.result ? result.result.value ?? null : null));
} catch (e) {
  console.log('null');
}
