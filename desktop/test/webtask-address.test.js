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
