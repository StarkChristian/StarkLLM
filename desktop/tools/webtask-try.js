// Try the web-task loop (webtask-core.js) outside the app: a real Chromium (Playwright) and a real Ollama, with the
// same page script as the app window. For development and for comparing AI models; not part of the app.
//
//   node tools/webtask-try.js --task "..." [--model qwen2.5:7b] [--ollama http://127.0.0.1:11434] [--start URL]
//        [--allow] [--chromium /path/to/chrome] [--shots DIR] [--language English]
//
// Needs the npm package "playwright" where Node can find it (NODE_PATH). Confirmations are answered "no" unless
// --allow is given; a step for the user (password, payment) is answered "not done".
const fs = require('fs');
const path = require('path');
const { runTask, TOOLS } = require('../webtask-core');
const { PAGE_SCRIPT } = require('../webtask-page');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function main() {
  const { chromium } = require('playwright');
  const task = arg('task');
  if (!task) throw new Error('--task is missing');
  const model = arg('model', 'qwen2.5:7b');
  const ollama = arg('ollama', 'http://127.0.0.1:11434');
  const shots = arg('shots', '');
  const launch = { headless: true };
  if (arg('chromium')) launch.executablePath = arg('chromium');
  const br = await chromium.launch(launch);
  // The browser says what it is (no changed user agent): a site that asks for a CAPTCHA gets the user, never a trick.
  const page = await br.newPage({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
  page.on('download', (d) => d.cancel()); // like the app: no downloads
  let opened = false;
  let shot = 0;

  const ready = async () => {
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(700);
    await page.evaluate(PAGE_SCRIPT);
    if (shots) await page.screenshot({ path: path.join(shots, `step-${String(++shot).padStart(2, '0')}.png`) });
  };
  const browser = {
    hasPage: () => opened,
    async open(url) { await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }); opened = true; await ready(); },
    async snapshot() { await page.evaluate(PAGE_SCRIPT); return page.evaluate(() => window.__starkllm.snapshot()); },
    async click(i) {
      const r = await page.evaluate((n) => window.__starkllm.rect(n), i);
      if (!r) throw new Error('the element is gone');
      await page.mouse.click(r.x, r.y);
      await ready();
      return r;
    },
    async focusInfo(i) { await page.evaluate(PAGE_SCRIPT); return page.evaluate((n) => window.__starkllm.focusField(n), i); },
    async type(i, text, enter) {
      const info = await page.evaluate((n) => window.__starkllm.focusField(n), i);
      if (!info) throw new Error('the field is gone');
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.insertText(text);
      if (enter) await page.keyboard.press('Enter');
      await ready();
      return info;
    },
    async select(i, option) { const v = await page.evaluate(([n, o]) => window.__starkllm.choose(n, o), [i, option]); await ready(); return v; },
    async scroll(dir) { await page.evaluate((d) => window.__starkllm.scrollPage(d), dir); await ready(); },
    async back() { await page.goBack({ timeout: 20000 }).catch(() => {}); await ready(); },
    async read() { await page.evaluate(PAGE_SCRIPT); return page.evaluate(() => window.__starkllm.read()); },
    async leave() { await page.goBack({ timeout: 10000 }).catch(() => page.goto('about:blank')); await ready(); },
  };

  let calls = 0;
  let tokens = 0;
  const llm = async (messages, tools) => {
    calls++;
    const t0 = Date.now();
    const res = await fetch(ollama + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: false, think: false, options: { num_ctx: 16384, temperature: 0.1 } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const j = await res.json();
    tokens += (j.prompt_eval_count || 0) + (j.eval_count || 0);
    const m = j.message || {};
    console.log(`   model ${((Date.now() - t0) / 1000).toFixed(1)}s, prompt ${j.prompt_eval_count} tok` +
      (m.tool_calls ? `, call ${JSON.stringify(m.tool_calls[0].function)}` : `, text ${JSON.stringify(String(m.content).slice(0, 200))}`));
    return m;
  };
  const allow = Boolean(arg('allow'));
  const asked = [];
  const ask = async (q) => {
    asked.push(q.type + ': ' + q.text);
    console.log(`?? ${q.type}: ${q.text} -> ${q.type === 'confirm' ? (allow ? 'yes' : 'no') : q.type === 'question' ? 'answered' : 'not done'}`);
    if (q.type === 'confirm') return { ok: allow };
    if (q.type === 'question') return { ok: true, text: 'Choose what fits the task best; I have no further wishes.' };
    if (q.type === 'site') return { ok: allow };
    return { ok: false };
  };
  const emit = (e) => console.log(`-- ${e.type}${e.n ? ' ' + e.n : ''}: ${e.action || ''} ${e.detail || e.text || ''}`);

  const start = arg('start');
  if (start) await browser.open(start);
  const t0 = Date.now();
  const result = await runTask({ task, language: arg('language', 'English'), browser, llm, ask, emit });
  const out = { model, task, status: result.status, answer: result.answer || result.error, steps: result.steps.length, model_calls: calls, tokens, seconds: Math.round((Date.now() - t0) / 1000), asked, final_url: page.url() };
  console.log('RESULT ' + JSON.stringify(out));
  if (arg('json')) fs.appendFileSync(arg('json'), JSON.stringify(out) + '\n');
  await br.close();
}

main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { TOOLS };
