// Settings > Letters from e-mail (docs/mail-import.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseList, accountBody, formProblem, portFor, emptyForm, formFromAccount } from '../src/utils/mailImport.js';

test('lists: one entry per line (or comma), no empty ones, no repeats', () => {
  assert.deepEqual(parseList(' INBOX\n\nRechnungen, INBOX ;Post '), ['INBOX', 'Rechnungen', 'Post']);
  assert.deepEqual(parseList(''), []);
});

test('the request to the engine never carries the password', () => {
  const form = { ...emptyForm(3), host: ' imap.example.org ', username: 'me@example.org', password: 'secret-pw', senders: '@amt.example' };
  const body = accountBody(form);
  assert.equal('password' in body, false);
  assert.equal(JSON.stringify(body).includes('secret-pw'), false);
  assert.deepEqual(body.folders, ['INBOX']);
  assert.equal(body.host, 'imap.example.org');
  assert.equal(body.workspace_id, 3);
  assert.equal(body.mark_read, false);   // off unless the user turns it on
  assert.equal(formFromAccount({ ...body, id: 1, password_saved: true }).password, '');
});

test('only encrypted connections can be chosen, and the form says what is missing', () => {
  const ok = { ...emptyForm(1), host: 'imap.example.org', username: 'me', password: 'x' };
  assert.equal(formProblem(ok, { needPassword: true }), null);
  assert.equal(formProblem({ ...ok, password: '' }, { needPassword: true }), 'incomplete');
  assert.equal(formProblem({ ...ok, password: '' }, { needPassword: false }), null);
  assert.equal(formProblem({ ...ok, security: 'plain' }, { needPassword: true }), 'tls_required');
  assert.equal(formProblem({ ...ok, host: 'https://imap.example.org' }, { needPassword: true }), 'bad_host');
  assert.equal(formProblem({ ...ok, port: 70000 }, { needPassword: true }), 'bad_port');
  assert.equal(formProblem({ ...ok, interval_minutes: 1 }, { needPassword: true }), 'bad_interval');
  assert.equal(portFor('starttls', 993), 143);
  assert.equal(portFor('ssl', 143), 993);
  assert.equal(portFor('ssl', 1993), 1993);   // a port the user typed stays
});

test('the page has no choice without encryption and hands the password to the desktop app only', () => {
  const src = readFileSync(new URL('../src/components/MailImportSettings.jsx', import.meta.url), 'utf8');
  const options = [...src.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(options, ['ssl', 'starttls']);
  assert.match(src, /desktop\.setPassword\(body\.id, form\.password\)/);
  assert.doesNotMatch(src, /JSON\.stringify\(\{[^}]*password/);
  const settings = readFileSync(new URL('../src/components/Settings.jsx', import.meta.url), 'utf8');
  assert.match(settings, /shown === 'mail' && <MailImportSettings/);
});
