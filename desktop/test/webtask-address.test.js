// The address bar of StarkLLM browser window: what the user types becomes a web address or a search
const test = require("node:test");
const assert = require("node:assert");
const { addressOf } = require("../webtask");

test("an address, a bare domain and a search", () => {
  assert.strictEqual(addressOf("https://example.org/a?b=1"), "https://example.org/a?b=1");
  assert.strictEqual(addressOf("aachen.de"), "https://aachen.de");
  assert.strictEqual(addressOf("www.aachen.de/rathaus"), "https://www.aachen.de/rathaus");
  assert.strictEqual(addressOf("Einwohner Aachen"), "https://duckduckgo.com/?q=Einwohner%20Aachen");
  assert.strictEqual(addressOf("file:///C:/Windows"), "https://duckduckgo.com/?q=file%3A%2F%2F%2FC%3A%2FWindows");
  assert.strictEqual(addressOf("javascript:alert(1)"), "https://duckduckgo.com/?q=javascript%3Aalert(1)");
  assert.strictEqual(addressOf("  "), "");
});

// target="_blank" and window.open (2.5.0 acceptance test, serviceportal.aachen.de): the same page, never a new window
test("a link that opens a new window opens in the same page; other schemes do nothing", () => {
  const { openHereHandler } = require("../webtask");
  const loaded = [];
  const queued = [];
  const wc = { isDestroyed: () => false, loadURL: (u) => { loaded.push(u); return Promise.resolve(); } };
  const handler = openHereHandler(wc, (fn) => queued.push(fn));
  assert.deepStrictEqual(handler({ url: "https://serviceportal.aachen.de/%C3%96ffnungszeiten" }), { action: "deny" });
  assert.deepStrictEqual(handler({ url: "file:///C:/Windows/win.ini" }), { action: "deny" });
  assert.deepStrictEqual(handler({ url: "javascript:alert(1)" }), { action: "deny" });
  assert.deepStrictEqual(handler({ url: "about:blank" }), { action: "deny" });
  assert.strictEqual(loaded.length, 0, "loaded after the handler returned, not inside it");
  queued.forEach((fn) => fn());
  assert.deepStrictEqual(loaded, ["https://serviceportal.aachen.de/%C3%96ffnungszeiten"]);
  // a page closed meanwhile is not touched
  const gone = { isDestroyed: () => true, loadURL: () => { throw new Error("must not load"); } };
  const q2 = [];
  openHereHandler(gone, (fn) => q2.push(fn))({ url: "https://example.org/" });
  q2.forEach((fn) => fn());
});
