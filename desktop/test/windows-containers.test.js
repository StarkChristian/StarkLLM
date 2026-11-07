// Found on a GitHub Windows runner (7 Nov 2026): Docker in Windows-containers mode made the engine build fail
// with "no matching manifest for windows(10.0.26100)/amd64", shown to the user as a raw build log.
const test = require('node:test');
const assert = require('node:assert');
const { buildErrorPage } = require('../diagnostics');

test('the start page explains how to switch Docker to Linux containers', () => {
  const html = buildErrorPage({ docker: 'windows-containers', ollama: true, missingModels: [], backend: false, engine: { ok: false, stage: 'docker-windows-containers', logFile: 'engine.log' } });
  assert.match(html, /Docker Desktop is set to Windows containers/);
  assert.match(html, /Switch to Linux containers/);
  assert.match(html, /DockerCli\.exe&quot; -SwitchLinuxEngine|DockerCli\.exe" -SwitchLinuxEngine/);
  assert.doesNotMatch(html, /StarkLLM engine could not be started/, 'no raw build log on top of the explanation');
});
