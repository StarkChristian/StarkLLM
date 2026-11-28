// Settings › Connections (docs/connections.md): the helpers of the page. The rules themselves are tested in the desktop
// app (desktop/test/connections.test.js), which checks every answer again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialValues, missingRequired, formatBytes, sortTools, serversOfKinds, hasConnections } from '../src/utils/connections.js';

const FIELDS = [
  { id: 'folder', kind: 'folder', required: true },
  { id: 'apiKey', kind: 'secret', required: true, default: 'never-shown' },
  { id: 'port', kind: 'number', default: 4455 },
  { id: 'allowWrite', kind: 'checkbox', default: false },
  { id: 'on', kind: 'checkbox', default: true },
];

test('a generated form starts with the defaults; a secret field always starts empty', () => {
  assert.deepEqual(initialValues(FIELDS), { folder: '', apiKey: '', port: '4455', allowWrite: false, on: true });
});

test('required fields that are empty are found; checkboxes are never missing', () => {
  assert.deepEqual(missingRequired(FIELDS, initialValues(FIELDS)), ['folder', 'apiKey']);
  assert.deepEqual(missingRequired(FIELDS, { folder: 'C:\\Docs', apiKey: '  ' }), ['apiKey']);
  assert.deepEqual(missingRequired(FIELDS, { folder: 'C:\\Docs', apiKey: 'k' }), []);
});

test('sizes, tool order and the servers of each page', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(20480), '20 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  const tools = [{ name: 'b', tier: 'exec' }, { name: 'z', tier: 'read' }, { name: 'a', tier: 'blocked' }, { name: 'c', tier: 'write' }, { name: 'a', tier: 'read' }];
  assert.deepEqual(sortTools(tools).map((x) => `${x.tier}:${x.name}`), ['read:a', 'read:z', 'write:c', 'exec:b', 'blocked:a']);
  const servers = [{ id: '1' }, { id: '2', kind: 'catalog' }, { id: '3', kind: 'bundle' }, { id: '4', kind: 'manual' }];
  assert.deepEqual(serversOfKinds(servers, ['manual']).map((s) => s.id), ['1', '4']);
  assert.deepEqual(serversOfKinds(servers, ['catalog', 'bundle']).map((s) => s.id), ['2', '3']);
  assert.equal(hasConnections(), false); // a browser without the desktop app: no Connections page
});

test('the page and the tool card use the desktop app\'s rules, not their own', () => {
  const panel = readFileSync(new URL('../src/components/ConnectionsPanel.jsx', import.meta.url), 'utf8');
  const card = readFileSync(new URL('../src/components/ToolCallCard.jsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../src/components/Settings.jsx', import.meta.url), 'utf8');
  assert.match(panel, /bridge\.install\(entry\.id, values, \{ acknowledged: ack/);
  assert.match(panel, /mcp\.stopAll\(\)/);
  assert.match(card, /bridge\.call\(toolName, argsObj, \{ confirmed: auto !== true, checked, chatId \}\)/);
  assert.match(card, /policy\.canAllowSession/); // only read tools get "allow for this session"
  assert.match(card, /disabled=\{Boolean\(jsonError\) \|\| blockedByCheck/);
  assert.match(settings, /s\.id === 'connections' && !hasConnections\(\)/);
});
