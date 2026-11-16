const test = require('node:test');
const assert = require('node:assert');
const { sameOrigin, isWebLink, permissionAllowed } = require('../window-security');

const APP = 'http://localhost:5173';

test('only the app itself is the app: no prefix tricks, no other port', () => {
  assert.ok(sameOrigin('http://localhost:5173/settings', APP));
  assert.ok(!sameOrigin('http://localhost:51730/', APP));
  assert.ok(!sameOrigin('https://evil.example/?localhost:5173', APP));
  assert.ok(!sameOrigin('http://127.0.0.1:5173/', APP)); // another origin for the browser, so not the app's storage
  assert.ok(!sameOrigin('file:///C:/x.html', APP));
  assert.ok(!sameOrigin('data:text/html,hi', APP));
  assert.ok(!sameOrigin('not a url', APP));
});

test('web links', () => {
  assert.ok(isWebLink('https://starkllm.com'));
  assert.ok(!isWebLink('javascript:alert(1)'));
  assert.ok(!isWebLink('file:///etc/passwd'));
});

test('permissions only for the app page, and only what it uses', () => {
  assert.ok(permissionAllowed('media', `${APP}/chat`, APP, { mediaTypes: ['audio'] }));
  assert.ok(!permissionAllowed('media', `${APP}/chat`, APP, { mediaTypes: ['video'] }));
  assert.ok(permissionAllowed('clipboard-sanitized-write', `${APP}/`, APP));
  assert.ok(!permissionAllowed('geolocation', `${APP}/`, APP));
  assert.ok(!permissionAllowed('media', 'https://evil.example/', APP, { mediaTypes: ['audio'] }));
});
