// Accessibility check of the built interface (WCAG 2.1 A/AA rules of axe-core), see docs/accessibility.md.
// It serves dist/ with made-up answers for the /api calls (no backend, no model), opens every page, the settings
// sections and the dialogs in every theme, and runs axe-core on each.
//
//   npx vite build && node scripts/a11y-check.mjs            (exit 1 when axe finds a WCAG violation)
//   THEMES=dark,light node scripts/a11y-check.mjs            (only these themes)
//   A11Y_OUT=/tmp/a11y.json node scripts/a11y-check.mjs      (also write every finding with its elements)
//   A11Y_REPORT_ONLY=1 node scripts/a11y-check.mjs           (print, but exit 0)
//   A11Y_SKIP_AXE=1 / A11Y_SKIP_KEYBOARD=1                   (only the keyboard, heading and zoom checks / only axe)
//   A11Y_CONTRAST_PENDING=light,doodle,flowers               (colour contrast of these themes reported, not failing)
//
// Needs playwright (with chromium) and axe-core. They are not in package.json, so `npm ci` stays small; CI installs
// them for this step (.github/workflows/checks.yml). Locally: NODE_PATH=<dir with playwright and axe-core>.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.resolve(process.argv[2] || path.join(HERE, '..', 'dist'));
const ALL_THEMES = ['dark', 'pink', 'black', 'glass', 'emerald', 'amber', 'nord', 'light', 'doodle', 'doodle-night', 'flowers', 'matrix', 'stars'];
const THEMES = (process.env.THEMES || ALL_THEMES.join(',')).split(',').filter(Boolean);
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`no build in ${DIST}: run npx vite build first`);
  process.exit(2);
}

// ── made-up backend ──
const now = new Date().toISOString();
const today = now.slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const workspaces = [{ id: 1, name: 'Letters', description: '' }, { id: 2, name: 'Tax 2026', description: '' }];
const chats = [
  { id: 11, title: 'What does the letter say?', created_at: now, updated_at: now },
  { id: 12, title: 'Insurance renewal', created_at: now, updated_at: now, is_pinned: true },
];
const session = {
  chat_id: 11, title: chats[0].title, messages: [
    { id: 101, role: 'user', content: 'What does the letter say?', timestamp: now },
    { id: 102, role: 'assistant', content: 'According to [letter-en.png], the letter asks you to **renew the contract** by 15 December.\n\n- Amount: 120 EUR\n- Customer number: K-123', timestamp: now, sources: { ws: ['letter-en.png (Photo, read from the image)', 'letter-en.png (Page 1)'], kb: [], used: true, mode: 'documents' } },
  ],
};
const fact = (value, text = value) => ({ value, page: 1, text });
const letter = (id, status, extra = {}) => ({
  scope: 'ws', id, workspace_id: 1, workspace: 'Letters', filename: `letter-${id}.png`, file_type: 'png', status, added: now,
  facts: {
    type: fact('invoice', 'Invoice'), sender: fact('Stadtwerke Aachen'), date: fact(inDays(-3)),
    references: [{ kind: 'customer', ...fact('K-123') }], amounts: [fact('120,00 EUR')],
    accounts: [{ kind: 'iban', ...fact('DE02 1203 0000 0000 2020 51') }],
    dates: [{ kind: 'payment', ...fact(inDays(17)), amount: '120,00 EUR' }],
  },
  ...extra,
});
const inbox = {
  today, new_count: 1,
  documents: [letter(5, 'new'), letter(6, 'done', { suspicious: true })],
  cases: [{ key: 'stadtwerke', name: 'Stadtwerke Aachen', documents: [{ scope: 'ws', id: 5 }, { scope: 'ws', id: 6 }], references: [{ kind: 'customer', value: 'K-123' }], suspicious: 1, next: { kind: 'payment', value: inDays(17), amount: '120,00 EUR' } }],
};
const deadlines = [{ key: 'd1', kind: 'payment', value: inDays(17), amount: '120,00 EUR', scope: 'ws', document_id: 5, workspace_id: 1, filename: 'letter-5.png', title: 'Stadtwerke invoice', page: 1, text: inDays(17) }];
const models = [{ name: 'qwen3:8b', size: 5200000000, modified_at: now, details: { parameter_size: '8B', family: 'qwen3' } }];

function api(url, method) {
  const u = new URL(url); const p = u.pathname;
  if (method !== 'GET') return {};
  if (p.endsWith('/auth/me')) return { username: 'tester', default_model: 'qwen3:8b' };
  if (p.endsWith('/workspaces/')) return workspaces;
  if (p.includes('/chat/sessions/')) return chats;
  if (p.includes('/chat/session/')) return session;
  if (p.includes('/chat/folders/')) return [];
  if (p.endsWith('/chat/models')) return { models: models.map((m) => m.name), default: 'qwen3:8b' };
  if (p.endsWith('/chat/models/detailed')) return { models };
  if (p.endsWith('/chat/models/catalog')) return { models: [{ name: 'llama3.2:3b', description: 'Small and quick', size: '2.0 GB', tags: ['fast'] }] };
  if (p.includes('/system-status')) return { ollama: { status: 'online', latency_ms: 14 }, text_model: { status: 'online', name: 'qwen3:8b' }, embedding_model: { status: 'missing' }, available_models: ['qwen3:8b', 'llama3.2:3b'] };
  if (p.includes('/crypto-prices')) return { bitcoin: { usd: 91234.5, usd_24h_change: 1.8 } };
  if (p.includes('/market-prices')) return { chart: { result: [{ meta: { regularMarketPrice: 74.2, chartPreviousClose: 73.9 } }] } };
  if (p.endsWith('/dashboard/inbox')) return inbox;
  if (p.endsWith('/dashboard/deadlines')) return { today, deadlines, items: deadlines };
  if (p.endsWith('/version')) return { version: '2.7.0' };
  if (p.includes('/privacy/network-log')) return { entries: [{ time: now, host: 'example.org', outcome: 'blocked', reason: 'offline', source: 'engine' }], status: 'ok', features: {} };
  if (p.includes('/count')) return { count: 0 };
  if (p.includes('/documents/1') && !p.includes('/documents/1/')) return [{ id: 5, filename: 'letter-5.png', status: 'indexed', file_type: 'png', created_at: now, chunk_count: 3 }];
  return [];
}

// ── what is checked ──
// Each step: a name, and how to get there from a freshly loaded app (dashboard).
const nav = (name) => async (page) => { await page.getByRole('button', { name, exact: true }).first().click(); };
const clickTitle = (title) => async (page) => { await page.locator(`[title="${title}"], [aria-label="${title}"]`).first().click(); };
const MAIN = [
  ['dashboard', async () => {}],
  ['inbox', nav('Inbox')],
  ['chat', nav('Chat')],
  ['knowledge-base', nav('Knowledge Base')],
  ['settings', nav('Settings')],
];
const SETTINGS = ['Custom Instructions', 'Instructions for this workspace', 'Model Settings', 'Document search', 'Knowledge Base', 'Local Tools', 'Other apps', 'Privacy & network', 'Appearance', 'Language & Locale', 'Reading photos and scans', 'Keyboard Shortcuts', 'Protection', 'Backup & Restore', 'About StarkLLM'];
const EXTRA = [
  ['inbox/cases', async (page) => { await nav('Inbox')(page); await page.waitForTimeout(500); await page.getByRole('tab', { name: /Cases/ }).click(); await page.getByRole('button', { name: /Stadtwerke/ }).first().click(); }],
  ['inbox/deadlines', async (page) => { await nav('Inbox')(page); await page.waitForTimeout(500); await page.getByRole('tab', { name: /Deadlines/ }).click(); }],
  ['inbox/all', async (page) => { await nav('Inbox')(page); await page.waitForTimeout(500); await page.getByRole('tab', { name: /All documents/ }).click(); }],
  ['dialog/search', async (page) => { await page.keyboard.press('Control+k'); }],
  ['dialog/model-hub', clickTitle('Open StarkLLM Model Hub')],
  ['dialog/studio', clickTitle('Open AI Studio - Podcast, Briefing, Study Guide')],
  ['dialog/new-workspace', async (page) => { await nav('Chat')(page); await page.waitForTimeout(500); await clickTitle('New Workspace')(page); }],
  ['dialog/sources', async (page) => { await nav('Chat')(page); await page.waitForTimeout(800); await page.locator('button[class*="sourceGroup"]').first().click(); }],
  ['chat/model-menu', async (page) => { await nav('Chat')(page); await page.waitForTimeout(800); }],
  ...SETTINGS.map((s) => [`settings/${s}`, async (page) => { await nav('Settings')(page); await page.waitForTimeout(400); await page.getByRole('button', { name: s, exact: true }).last().click(); }]),
];

const results = [];
// A11Y_CONTRAST_PENDING=light,doodle,flowers: the colour contrast of these themes is reported but does not fail the
// check (their fix is on the branch fix261/theme; drop the variable once it is merged).
const PENDING = (process.env.A11Y_CONTRAST_PENDING || '').split(',').filter(Boolean);
const pending = [];
const errors = [];

async function openApp(browser, theme, name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', bypassCSP: true, ...opts.context });
  await ctx.addInitScript(({ th, onboarded }) => {
    localStorage.setItem('token', 'mock');
    localStorage.setItem('username', 'tester');
    if (onboarded) localStorage.setItem('starkllm_onboarding_done', 'true');
    localStorage.setItem('ui_theme', th);
    localStorage.setItem('starkllm_language', 'en');
    localStorage.setItem('starkllm_market_prices_consent', 'yes');
    localStorage.setItem('default_model', 'qwen3:8b');
    if (onboarded) localStorage.setItem('starkllm_lucy_guide_done', '1');
  }, { th: theme, onboarded: !opts.onboarding });
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const url = req.url(); const p = new URL(url).pathname;
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(api(url, req.method())) });
    if (!url.startsWith('http://app.test')) return route.fulfill({ status: 404, body: '' });
    let f = path.join(DIST, p === '/' ? 'index.html' : decodeURIComponent(p));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errors.push(`${theme} ${name}: ${e.message}`));
  await page.goto('http://app.test/');
  await page.waitForTimeout(1200);
  return { ctx, page };
}

async function check(browser, theme, name, go, opts = {}) {
  const { ctx, page } = await openApp(browser, theme, name, opts);
  try {
    await go(page);
    await page.waitForTimeout(900);
    await page.addScriptTag({ content: AXE });
    const r = await page.evaluate((tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }), TAGS);
    for (const v of r.violations) {
      if (v.id === 'color-contrast' && PENDING.includes(theme)) { pending.push({ theme, view: name, nodes: v.nodes.length }); continue; }
      results.push({ theme, view: name, rule: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), summary: n.failureSummary, html: n.html.slice(0, 160) })) });
    }
  } catch (e) {
    errors.push(`${theme} ${name}: could not open (${e.message.split('\n')[0]})`);
  }
  await ctx.close();
}

const browser = await chromium.launch();
for (const theme of process.env.A11Y_SKIP_AXE ? [] : THEMES) {
  for (const [name, go] of MAIN) await check(browser, theme, name, go);
}
// sections and dialogs: in one dark and one light theme (the markup is the same in every theme)
for (const theme of process.env.A11Y_SKIP_AXE ? [] : THEMES.filter((th) => th === 'dark' || th === 'light')) {
  for (const [name, go] of EXTRA) await check(browser, theme, name, go);
  await check(browser, theme, 'onboarding', async () => {}, { onboarding: true });
}

// ── keyboard, structure and zoom (axe does not test these) ──
const kbFailures = [];
const expect = (ok, what) => { if (!ok) kbFailures.push(what); };
const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return {
    tag: a?.tagName, id: a?.id, text: (a?.getAttribute('aria-label') || a?.getAttribute('title') || a?.textContent || '').trim().slice(0, 40),
    inDialog: Boolean(a?.closest('[role="dialog"],[role="alertdialog"]')), outline: a ? getComputedStyle(a).outlineStyle : '',
  };
});
if (!process.env.A11Y_SKIP_KEYBOARD) {
  const { ctx, page } = await openApp(browser, THEMES[0], 'keyboard');
  try {
    await page.keyboard.press('Tab');
    let a = await active(page);
    expect(a.tag === 'A' && /content/i.test(a.text), `first Tab: the skip link (got ${a.tag} "${a.text}")`);
    expect(a.outline !== 'none', 'the focused skip link shows a focus ring');
    await page.keyboard.press('Enter');
    a = await active(page);
    expect(a.id === 'main-content', `the skip link moves the focus to the page (got ${a.tag} #${a.id})`);
    await page.keyboard.press('Tab');
    a = await active(page);
    expect(a.outline !== 'none', `a button reached with Tab shows a focus ring (${a.tag} "${a.text}")`);
    // every page: one h1, no skipped heading level, one main landmark and a named navigation
    for (const [view, go] of MAIN) {
      await go(page); await page.waitForTimeout(500);
      const h = await page.evaluate(() => ({
        levels: [...document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')]
          .filter((e) => e.getClientRects().length || e.classList.contains('sr-only')).map((e) => +e.tagName[1]),
        mains: document.querySelectorAll('main').length,
        nav: document.querySelectorAll('nav[aria-label]').length,
      }));
      expect(h.levels.filter((l) => l === 1).length === 1, `${view}: one h1 (headings ${h.levels.join(',')})`);
      expect(h.levels.every((l, i) => i === 0 || l <= h.levels[i - 1] + 1), `${view}: no skipped heading level (${h.levels.join(',')})`);
      expect(h.mains === 1 && h.nav >= 1, `${view}: one main landmark and a named navigation`);
    }
    // dialogs: the focus moves in, Tab stays inside, Escape closes and the focus goes back to the opener
    await MAIN[0][1](page); await page.waitForTimeout(400);
    const dialogs = [
      ['search (Ctrl+K)', async () => { await page.locator('[title="Global Search (Ctrl+K)"]').focus(); await page.keyboard.press('Control+k'); }],
      ['model hub', async () => { await page.locator('[title="Open StarkLLM Model Hub"]').focus(); await page.keyboard.press('Enter'); }],
    ];
    for (const [label, open] of dialogs) {
      await open(); await page.waitForTimeout(600);
      a = await active(page);
      expect(a.inDialog, `${label}: the focus moves into the dialog`);
      let inside = true;
      for (let i = 0; i < 30; i++) { await page.keyboard.press('Tab'); if (!(await active(page)).inDialog) { inside = false; break; } }
      expect(inside, `${label}: Tab stays inside the dialog`);
      await page.keyboard.press('Shift+Tab');
      expect((await active(page)).inDialog, `${label}: Shift+Tab stays inside the dialog`);
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      expect(await page.locator('[role="dialog"]').count() === 0, `${label}: Escape closes the dialog`);
      a = await active(page);
      expect(a.tag === 'BUTTON' && !a.inDialog, `${label}: the focus goes back to the button that opened it (got ${a.tag} "${a.text}")`);
    }
    // the chat: a log that is not read token by token, and a polite status line for the finished answer
    await nav('Chat')(page); await page.waitForTimeout(800);
    const log = await page.evaluate(() => {
      const l = document.querySelector('[role="log"]');
      return l && { live: l.getAttribute('aria-live'), label: l.getAttribute('aria-label'), status: document.querySelectorAll('main [role="status"][aria-live="polite"]').length };
    });
    expect(log && log.live === 'off' && log.label && log.status >= 1, 'chat: role="log" with aria-live="off", a name, and a polite status line');
  } catch (e) { kbFailures.push(`keyboard check stopped: ${e.message.split('\n')[0]}`); }
  await ctx.close();
  // 200 % zoom of a 1280x900 window is 640x450 CSS pixels; Windows text size 150 % of 1280x900 is 853x600.
  for (const [w, h, label] of [[640, 450, '200 % zoom'], [853, 600, 'Windows text size 150 %']]) {
    const z = await openApp(browser, THEMES[0], label, { context: { viewport: { width: w, height: h } } });
    for (const [view, go] of MAIN) {
      try {
        await go(z.page); await z.page.waitForTimeout(400);
        const m = await z.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, main: document.querySelector('main')?.getBoundingClientRect().width || 0 }));
        expect(m.sw <= m.cw + 1, `${label}, ${view}: no sideways scrolling of the window (${m.sw} > ${m.cw})`);
        expect(m.main >= 320, `${label}, ${view}: the page keeps at least 320 px next to the sidebar (got ${Math.round(m.main)})`);
      } catch (e) { kbFailures.push(`${label}, ${view}: ${e.message.split('\n')[0]}`); }
    }
    await z.ctx.close();
  }
}
await browser.close();

// ── report ──
const byRule = new Map();
for (const r of results) {
  const e = byRule.get(r.rule) || { rule: r.rule, impact: r.impact, help: r.help, nodes: 0, where: new Set() };
  e.nodes += r.nodes.length; e.where.add(`${r.view}@${r.theme}`); byRule.set(r.rule, e);
}
const nodes = results.reduce((n, r) => n + r.nodes.length, 0);
console.log(`axe-core ${JSON.parse(fs.readFileSync(require.resolve('axe-core/package.json'), 'utf8')).version}, rules ${TAGS.join(' ')}, themes ${THEMES.length}`);
for (const e of [...byRule.values()].sort((a, b) => b.nodes - a.nodes)) {
  const where = [...e.where];
  console.log(`  ${e.rule} (${e.impact}): ${e.nodes} element(s) in ${where.length} view(s) - ${e.help}`);
  console.log(`      ${where.slice(0, 6).join(', ')}${where.length > 6 ? ', …' : ''}`);
}
if (process.env.A11Y_VERBOSE) for (const r of results) for (const n of r.nodes) console.log(`   ${r.theme} ${r.view} ${r.rule}: ${n.target}\n      ${n.html}\n      ${n.summary.replace(/\n/g, ' | ')}`);
for (const e of errors) console.log(`  page error: ${e}`);
if (pending.length) console.log(`  not counted (A11Y_CONTRAST_PENDING): color-contrast ${pending.reduce((n, x) => n + x.nodes, 0)} element(s) in ${[...new Set(pending.map((x) => x.theme))].join(', ')}`);
console.log(`violations: ${byRule.size} rule(s), ${nodes} element(s) in ${new Set(results.map((r) => `${r.view}@${r.theme}`)).size} view(s)`);
if (process.env.A11Y_OUT) fs.writeFileSync(process.env.A11Y_OUT, JSON.stringify({ results, errors }, null, 1));
for (const f of kbFailures) console.log(`  keyboard/structure: ${f}`);
console.log(`keyboard, structure and zoom: ${kbFailures.length} problem(s)`);
// a view that could not be opened was not checked: that fails too
const unchecked = errors.filter((e) => e.includes('could not open')).length;
process.exit((nodes > 0 || unchecked > 0 || kbFailures.length > 0) && !process.env.A11Y_REPORT_ONLY ? 1 : 0);
