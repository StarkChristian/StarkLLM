// Try the tool servers (mcp.js) in Electron: add the fake server of the tests, turn on one tool, call it, and check
// that a tool that is off cannot be called. From desktop/: xvfb-run -a node_modules/electron/dist/electron --no-sandbox tools/mcp-try.js
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
app.setPath("userData", fs.mkdtempSync("/tmp/starkllm-mcp-"));
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  require("../netguard").initShared(fs.mkdtempSync("/tmp/mcp-net-"));
  const mcp = require("../mcp");
  const h = {};
  mcp.register({ handle: (n, f) => { h[n] = f; } }, { fromApp: () => true, log: (l) => console.log("log:", l) });
  const ev = {};
  const added = await h["mcp:add"](ev, { name: "Fake", transport: "stdio", command: "node", args: [path.join(__dirname, "..", "testdata", "fake-mcp-server.js")], env: {} });
  const s = added.servers[0];
  console.log("running", s.running, "tools", s.tools.map((t) => t.name).join(","), "enabled", s.enabledTools.length);
  console.log("call while off:", JSON.stringify(await h["mcp:call"](ev, `ext__${s.id}__add`, { a: 1, b: 2 })));
  await h["mcp:set-tool"](ev, s.id, "add", true);
  console.log("enabled tools:", (await h["mcp:enabled-tools"](ev)).tools.map((t) => t.name).join(","));
  console.log("call:", JSON.stringify(await h["mcp:call"](ev, `ext__${s.id}__add`, { a: 2, b: 40 })));
  mcp.stopAll();
  console.log("after stop:", JSON.stringify(await h["mcp:call"](ev, `ext__${s.id}__add`, { a: 2, b: 40 })));
  app.quit();
});
