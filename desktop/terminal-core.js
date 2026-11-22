// Terminal for tasks (docs/web-tasks.md, "Terminal"): with a project folder the user chose, the task assistant can
// list and read the files, change them and run commands, to help with code. No Electron here: the file system and
// the command runner are passed in, so the same rules run in the app (webtask.js) and in the tests.
//
// The rules the user can rely on are enforced here, in code:
//  * only inside the chosen folder: paths that leave it (also through links, "..", "~" or another drive) are refused;
//  * every file change shows the change first and waits for the user's yes ("all changes in this task" possible);
//  * every command waits for the user's yes, except a few that only look (git status, git diff, dir ...);
//  * commands that change Windows, its security settings or permissions, run hidden or downloaded code, stay running
//    after the task or reach outside the folder are refused, also when the user would say yes;
//  * while StarkLLM is fully offline, commands that use the internet (npm install, git push ...) are refused;
//  * files with secrets (.env, keys, certificates) are not read and not changed;
//  * the file changes of a task can be undone afterwards (the files as they were before the task).

const path = require('path');

const COMMAND_SECONDS = 120;
const MAX_OUTPUT = 12000; // characters of a command's output or a file the model sees per step
const MAX_READ_LINES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_CHARS = 200000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', 'bin', 'obj', '.idea', '.vs']);

function tool(name, description, props, required) {
  const properties = {};
  for (const [k, [type, desc]] of Object.entries(props)) properties[k] = { type, description: desc };
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const TERMINAL_TOOLS = [
  tool('list_files', 'List the files and folders of a folder of the project.', {
    path: ['string', 'A folder of the project, relative to the project folder; "." is the project folder itself'],
  }, []),
  tool('read_file', `Read a text file of the project (${MAX_READ_LINES} lines at a time).`, {
    path: ['string', 'The file, relative to the project folder'],
    start_line: ['integer', 'The first line to read (1 is the start of the file)'],
  }, ['path']),
  tool('edit_file', 'Change a file: replace an exact piece of its text with new text. Read the file first and copy the piece exactly, with a few whole lines; it must appear only once in the file.', {
    path: ['string', 'The file, relative to the project folder'],
    old_text: ['string', 'The exact text that is in the file now'],
    new_text: ['string', 'The text that replaces it'],
  }, ['path', 'old_text', 'new_text']),
  tool('write_file', 'Create a new file, or replace the whole content of a small file.', {
    path: ['string', 'The file, relative to the project folder'],
    content: ['string', 'The whole new content of the file'],
  }, ['path', 'content']),
  tool('run_command', `Run a command in the terminal, in the project folder, for example tests, a build, git status or git diff. It ends after ${COMMAND_SECONDS / 60} minutes: do not start servers or programs that keep running or wait for input.`, {
    command: ['string', 'The command'],
  }, ['command']),
];
const TERMINAL_TOOL_NAMES = new Set(TERMINAL_TOOLS.map((x) => x.function.name));

// Files with secrets: StarkLLM neither reads nor changes them (examples and templates are fine).
const SECRET_FILE = /(^|[\\/])(\.env(\.[\w-]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|secrets?\.(json|ya?ml|toml|txt)|[^\\/]*\.(pem|key|pfx|p12|jks|keystore|kdbx|ovpn|ppk|asc|gpg))$/i;
const NOT_SECRET = /\.env\.(example|sample|template|dist|defaults)$/i;

function isSecretFile(rel) {
  const p = String(rel || '');
  // "x.env::$DATA" (another stream of a file) and "ENV~1" (a short 8.3 name) could name a secret file differently
  if (/:/.test(p.replace(/^[a-z]:/i, '')) || /~\d/.test(p)) return true;
  return SECRET_FILE.test(p) && !NOT_SECRET.test(p);
}

// Commands that are refused, also when the user would say yes: they change more than a project.
const BLOCKED_COMMANDS = [
  [/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/, 'it has more than one line: run one command at a time'],
  [/\bcmd(\.exe)?\s+\/[ck]\b|\b(start-job|start-threadjob|invoke-command|icm|saps|register-objectevent|register-wmievent|invoke-cimmethod|invoke-wmimethod|wmic)\b|win32_process|\[scriptblock\]::create|\bnew-pssession\b/i, 'it starts other programs or commands in a way StarkLLM cannot check'],
  [/\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-(e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s/i, 'it runs hidden or encoded code'],
  [/registry::|\bhk(lm|cu|cr|u|cc):/i, 'it changes Windows settings'],
  [/(downloadstring|downloadfile|downloaddata)\s*\(/i, 'it downloads code and runs it'],
  [/\b(format(-volume)?|diskpart|bcdedit|shutdown|restart-computer|stop-computer|vssadmin|wbadmin|cipher\s+\/w|clear-disk|initialize-disk|mkfs(\.\w+)?|dd\s+if=)\b/i, 'it changes Windows or the disks'],
  [/\b(reg(\.exe)?\s+(add|delete|import|load)|(set|new|remove)-itemproperty\b[^\n]*\bhk(lm|cu|cr|u)\b|setx)\b/i, 'it changes Windows settings'],
  [/\b(set-executionpolicy|set-mppreference|add-mppreference|remove-mppreference|netsh|new-netfirewallrule|set-netfirewall\w*|disable-netfirewall\w*|takeown|icacls|cacls|net\s+(user|localgroup|share)|runas|sudo|doas|chmod\s+[0-7]*7[0-7]*\s+\/|chown|set-acl|uac)\b|-verb\s+runas/i, 'it changes security settings or permissions'],
  [/\b(invoke-expression|iex)\b|\s-e(nc|ncodedcommand)?\s+[a-z0-9+/=]{16,}|frombase64string|\bbase64\s+(-d|--decode)\b/i, 'it runs hidden or encoded code'],
  [/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(sh|bash|zsh|iex|invoke-expression|powershell|pwsh|python3?|node|cmd)\b/i, 'it downloads code and runs it'],
  [/(^|[;&|]\s*)(start-process|start|nohup|setsid|disown)\b|\b(schtasks|register-scheduledtask|new-scheduledtask\w*|crontab|new-service|sc(\.exe)?\s+(create|config)|at\s+\d)/i, 'it keeps running after the task or starts by itself later'],
  [/\b(git\s+config\s+(--global|--system)|npm\s+(config\s+set|(install|i|add|uninstall|remove|update)\s+[^\n]*(-g|--global)\b)|pip3?\s+install\s+[^\n]*--user|(install|uninstall)-module|install-package|winget|choco|scoop)\b/i, 'it changes programs or settings outside the project folder'],
];

// Commands that use the internet: asked online, refused while StarkLLM is fully offline.
const NETWORK = /(?<![.\\/\w-])(new-object\s+(system\.)?net\.webclient|net\.http\.httpclient|test-netconnection|resolve-dnsname|nslookup|ping|npm\s+(install|i|ci|add|update|upgrade|publish|login|audit|outdated|view|info)|npx|pnpm\s+(install|i|add|update|dlx)|yarn(\s+(install|add|upgrade|dlx))?$|yarn\s+(install|add|upgrade|dlx)|pip3?\s+(install|download)|python3?\s+-m\s+pip\s+(install|download)|uv\s+(add|sync|pip\s+install)|poetry\s+(install|add|update)|git\s+(clone|fetch|pull|push|submodule|ls-remote)|curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|ssh|scp|sftp|ftp|rsync|nuget|dotnet\s+(restore|add)|cargo\s+(install|add|update|publish|fetch)|go\s+(get|install|mod\s+download)|gem\s+install|bundle(\s+install)?|composer\s+(install|require|update)|docker\s+(pull|push|run|build|login)|gh)\b/i;
// Commands that delete or throw away work: always asked, also after "allow for this task".
const DELETES = /\b(rm|rmdir|rd|del|erase|remove-item|ri|unlink)\b|\bgit\s+(clean|reset\s+--hard|checkout\s+(--|\.)|restore|stash\s+(drop|clear)|branch\s+-D|push\s+[^\n]*(-f|--force))\b/i;
// Commands that only look: run without asking, when they are alone (no ; | > & and no $( )).
const READ_ONLY = /^(git\s+(status|diff|log|show)(\s+[\w./\\:@^~=-]+)*|git\s+branch(\s+(-a|-v|-vv|-r|--list|--show-current))?|git\s+remote\s+-v|git\s+--version|ls(\s+-[a-z]+)*(\s+[\w./\\-]+)?|dir(\s+[\w./\\-]+)?|pwd|get-childitem(\s+[\w./\\-]+)?|gci|get-location|node\s+(-v|--version)|npm\s+(-v|--version)|python3?\s+(-V|--version)|java\s+-version|dotnet\s+--version|tree(\s+[\w./\\-]+)?)$/i;

// A token that names a place outside the project folder: another drive or folder, "..", "~" or an environment
// variable such as $HOME or %APPDATA%. Returns the token, or ''.
function outsideToken(command, root, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const inside = (abs) => {
    const r = p.relative(root, abs);
    return r === '' || (!r.startsWith('..') && !p.isAbsolute(r));
  };
  for (const raw of String(command).split(/[\s"'=,;()|&<>]+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    if (/^~|\$home\b|\$env:|\$\{?(home|userprofile|appdata|localappdata|programfiles|windir|systemroot)\b|%[a-z_()]+%/i.test(tok)) return tok;
    if (/^[a-z]+:\/\//i.test(tok)) continue; // a web address
    if (/^[a-z]:([\\/]|$)/i.test(tok) || /^\\\\/.test(tok)) {
      if (platform !== 'win32' || !inside(p.resolve(tok))) return tok;
      continue;
    }
    if (platform === 'win32' && (/^\\(?!\\)/.test(tok) || /^\/[^/\s]{4,}/.test(tok) || /^\/[^/\s]*[\\/]/.test(tok))) {
      if (!inside(p.resolve(root.slice(0, 2), tok))) return tok;
      continue;
    }
    if (platform !== 'win32' && tok.startsWith('/')) {
      if (tok === '/dev/null') continue;
      if (!inside(p.resolve(tok))) return tok;
      continue;
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(tok) && !inside(p.resolve(root, tok))) return tok;
  }
  return '';
}

// command -> { blocked, reason } or { network, deletes, readOnly }
function classifyCommand(command, { root, platform = process.platform, offline = false } = {}) {
  const raw = String(command || '');
  if (BLOCKED_COMMANDS[0][0].test(raw.trim())) return { blocked: true, reason: BLOCKED_COMMANDS[0][1] };
  const c = raw.replace(/[ \t]+/g, ' ').trim();
  for (const [re, why] of BLOCKED_COMMANDS) if (re.test(c)) return { blocked: true, reason: why };
  const out = root ? outsideToken(c, root, platform) : '';
  if (out) return { blocked: true, reason: `it reaches outside the project folder (${out.slice(0, 60)})` };
  const network = NETWORK.test(c);
  if (network && offline) return { blocked: true, reason: 'it uses the internet, and StarkLLM is fully offline' };
  const deletes = DELETES.test(c);
  const chained = /[;&|<>`]|\$\(/.test(c);
  const printsFiles = /^git\s+(show|log)\b/i.test(c) && /:|\s-p\b|--patch|\s-u\b|--stat-graph|\s-L/i.test(c);
  const readOnly = !chained && !network && !deletes && !printsFiles && READ_ONLY.test(c) && !/--output|--ext-diff|--textconv|\s-c\s|--exec/i.test(c);
  return { blocked: false, network, deletes, readOnly };
}

// A short line diff ("-" removed, "+" added, two lines of context) for the user to see a change before it is made.
function diffText(before, after, maxChars = 6000) {
  const a = String(before).replace(/\r\n/g, '\n').split('\n');
  const b = String(after).replace(/\r\n/g, '\n').split('\n');
  // the same start and end are skipped; the rest is compared line by line (small enough for an LCS table)
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length; let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea); const B = b.slice(s, eb);
  const out = [];
  for (let k = Math.max(0, s - 2); k < s; k++) out.push(`  ${a[k]}`);
  if (A.length * B.length > 250000) {
    for (const l of A) out.push(`- ${l}`);
    for (const l of B) out.push(`+ ${l}`);
  } else {
    const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0; let j = 0;
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) { out.push(`  ${A[i]}`); i++; j++; }
      else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) { out.push(`+ ${B[j]}`); j++; }
      else { out.push(`- ${A[i]}`); i++; }
    }
  }
  for (let k = ea; k < Math.min(a.length, ea + 2); k++) out.push(`  ${a[k]}`);
  const text = (s > 2 ? `@@ line ${s + 1}\n` : '') + out.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…' : text;
}

// Strings that look like secrets are hidden before the model or the chat sees a file or a command's output.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key hidden]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,})\b/g, '[secret hidden]'],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi, '$1[hidden]'],
];
function redact(text) {
  let s = String(text || '');
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}

// head and tail of a long text: the end of a test run has the result, the start has the first error
function clip(text, max = MAX_OUTPUT) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.35);
  return `${s.slice(0, head)}\n… (${s.length - max} characters left out) …\n${s.slice(s.length - (max - head))}`;
}

// fs: node's fs (sync calls); run(command, { cwd, timeoutMs, signal }) -> Promise<{ code, output, timedOut }>
// ask(question) -> Promise<{ ok, remember }> (the same as for the web part); offline() -> boolean
function createTerminal({ root, fs, run, platform = process.platform, offline = () => false, commandSeconds = COMMAND_SECONDS }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const realRoot = fs.realpathSync(root);
  const folderName = p.basename(realRoot) || realRoot;
  const originals = new Map(); // absolute path -> content before the task (null: the task created the file)
  const allowedCommands = new Set();
  const refusedCommands = new Set();
  let editsAllowed = false;
  const state = { version: 0 };
  // the files the model looked at or changed in this task, newest first: shown again in every step as they are now,
  // so a small model does not have to remember a file it read three steps ago
  let seen = [];
  const look = (r) => { seen = [r, ...seen.filter((x) => x !== r)].slice(0, 8); };

  const rel = (abs) => p.relative(realRoot, abs).split(p.sep).join('/') || '.';
  const isInside = (abs) => {
    const r = p.relative(realRoot, abs);
    return r === '' || (!r.startsWith('..') && !p.isAbsolute(r));
  };
  // a path of the model -> the absolute path inside the folder, or null; links that lead out are followed and refused
  function resolve(given) {
    const g = String(given == null || given === '' ? '.' : given).trim();
    if (!g || g.includes('\0')) return null;
    const abs = p.resolve(realRoot, g);
    if (!isInside(abs)) return null;
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== realRoot) probe = p.dirname(probe);
    let real;
    try { real = fs.realpathSync(probe); } catch (e) { return null; }
    return isInside(real) ? abs : null;
  }
  const inGitFolder = (abs) => rel(abs).split('/').includes('.git');
  // the real name of an existing file (Windows: the long name of "ENV~1", the target of a link)
  const realName = (abs) => {
    try {
      const real = (fs.realpathSync.native || fs.realpathSync)(abs);
      return p.basename(real);
    } catch (e) {
      return '';
    }
  };

  function listing(abs, max = 200) {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
    const lines = entries.slice(0, max).map((e) => {
      if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? `${e.name}/ (not listed)` : `${e.name}/`;
      let size = '';
      try { size = ` (${fs.statSync(p.join(abs, e.name)).size} bytes)`; } catch (err) { /* ignore */ }
      return `${e.name}${size}`;
    });
    if (entries.length > max) lines.push(`… and ${entries.length - max} more`);
    return lines.join('\n') || '(empty folder)';
  }

  function remember(abs) {
    if (originals.has(abs)) return;
    originals.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
  }

  async function change(abs, content, diff, created, ask) {
    if (!editsAllowed) {
      const res = await ask({ type: 'edit', text: rel(abs), extra: { diff, created } });
      if (!res || !res.ok) return false;
      if (res.remember) editsAllowed = true;
    }
    remember(abs);
    fs.mkdirSync(p.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    state.version++;
    return true;
  }

  const refusedEdit = (r) => ({ refused: true, refusedKey: `edit ${r}`, step: { action: 'refused', detail: `the user did not allow the change of ${r}` },
    note: `The user did NOT allow this change of ${r}. Do not make it again. Ask the user what they want instead, or finish and say what you would change.` });

  // one tool call of the model -> { step: { action, detail, extra }, output, note, refused }
  async function call(name, a, { ask, signal } = {}) {
    switch (name) {
      case 'list_files': {
        const abs = resolve(a.path);
        if (!abs) return { note: `"${String(a.path).slice(0, 80)}" is outside the project folder. Use paths inside it.` };
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { note: `There is no folder "${rel(abs)}". Use list_files with "." to see the project.` };
        return { step: { action: 'list', detail: rel(abs) }, output: `Folder ${rel(abs)}:\n${listing(abs)}` };
      }
      case 'read_file': {
        const abs = resolve(a.path);
        if (!abs) return { note: `"${String(a.path).slice(0, 80)}" is outside the project folder. Use paths inside it.` };
        const r = rel(abs);
        if (isSecretFile(r) || isSecretFile(realName(abs))) return { history: `read_file ${r}: NOT allowed, it may hold secrets; do not try again`, step: { action: 'secret', detail: r }, note: `${r} may hold secrets (passwords, keys), so StarkLLM does not read it. Ask the user if you need something from it.` };
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { note: `There is no file "${r}". Use list_files to see the files.` };
        if (fs.statSync(abs).size > MAX_FILE_BYTES) return { note: `${r} is larger than 2 MB and is not read.` };
        const buf = fs.readFileSync(abs);
        if (buf.subarray(0, 8000).includes(0)) return { note: `${r} is not a text file.` };
        const lines = buf.toString('utf8').split(/\r?\n/);
        const from = Math.max(1, Math.min(Number(a.start_line) || 1, lines.length));
        const to = Math.min(lines.length, from + MAX_READ_LINES - 1);
        const more = to < lines.length ? `\n(The file goes on: read_file with start_line ${to + 1} for more.)` : '';
        look(r);
        return { step: { action: 'readfile', detail: r }, output: `File ${r}, lines ${from}–${to} of ${lines.length}:\n${clip(redact(lines.slice(from - 1, to).join('\n')))}${more}` };
      }
      case 'edit_file':
      case 'write_file': {
        const abs = resolve(a.path);
        if (!abs) return { note: `"${String(a.path).slice(0, 80)}" is outside the project folder. Change files inside it only.` };
        const r = rel(abs);
        if (isSecretFile(r) || isSecretFile(realName(abs)) || inGitFolder(abs)) return { step: { action: 'secret', detail: r }, note: `StarkLLM does not change ${r} (secrets or the .git folder). Ask the user to do it.` };
        const exists = fs.existsSync(abs);
        if (exists && !fs.statSync(abs).isFile()) return { note: `${r} is a folder, not a file.` };
        let before = exists ? fs.readFileSync(abs, 'utf8') : '';
        let after;
        if (name === 'write_file') {
          after = String(a.content == null ? '' : a.content);
          if (after.length > MAX_WRITE_CHARS) return { note: 'The content is too long for one file change.' };
          if (exists && before.includes('\r\n') && !after.includes('\r\n')) after = after.replace(/\n/g, '\r\n'); // keep Windows line ends
        } else {
          if (!exists) return { note: `There is no file "${r}". Use write_file to create a new file.` };
          let oldText = String(a.old_text || '');
          let newText = String(a.new_text == null ? '' : a.new_text);
          if (!oldText) return { note: 'edit_file needs old_text: the exact text to replace. Read the file first.' };
          if (before.includes('\r\n') && !oldText.includes('\r\n')) { oldText = oldText.replace(/\n/g, '\r\n'); newText = newText.replace(/\n/g, '\r\n'); }
          const count = before.split(oldText).length - 1;
          if (count === 0) return { note: `The old_text was not found exactly in ${r}. Read the file again and copy the text exactly, with its spaces.` };
          if (count > 1) return { note: `The old_text appears ${count} times in ${r}. Include more lines so it appears only once.` };
          after = before.replace(oldText, () => newText);
        }
        if (exists && after === before) return { note: `That would not change ${r}.` };
        const diff = diffText(before, after);
        const ok = await change(abs, after, diff, !exists, ask);
        if (signal && signal.stopped) return {};
        if (!ok) return refusedEdit(r);
        before = null;
        look(r);
        return { step: { action: exists ? 'edit' : 'create', detail: r, extra: { diff } }, output: `${exists ? 'Changed' : 'Created'} ${r}.` };
      }
      case 'run_command': {
        const command = String(a.command || '').trim();
        if (!command) return { note: 'run_command needs a command.' };
        if (command.length > 2000) return { note: 'The command is too long.' };
        const c = classifyCommand(command, { root: realRoot, platform, offline: offline() });
        if (c.blocked) {
          return { step: { action: 'cmdblocked', detail: command, extra: { reason: c.reason } },
            note: `StarkLLM does not run "${command.slice(0, 80)}": ${c.reason}. Do the task another way, or finish and tell the user what they could do themselves.` };
        }
        if (!c.readOnly && !(allowedCommands.has(command) && !c.deletes)) {
          const res = refusedCommands.has(command) ? { ok: false, again: true }
            : await ask({ type: 'command', text: command, extra: { network: c.network, deletes: c.deletes, folder: folderName, offline: offline() } });
          if (signal && signal.stopped) return {};
          if (!res || !res.ok) {
            refusedCommands.add(command);
            return { refused: true, refusedKey: `command ${command}`, again: Boolean(res && res.again), step: { action: 'refused', detail: `the user did not allow the command ${command.slice(0, 80)}` },
              note: `The user did NOT allow the command "${command.slice(0, 80)}". Do not run it again. Do the task another way, or finish and say what is missing.` };
          }
          if (res.remember && !c.deletes) allowedCommands.add(command);
        }
        const r = await run(command, { cwd: realRoot, timeoutMs: commandSeconds * 1000, signal });
        if (!c.readOnly) state.version++; // a command can change files
        const head = r.timedOut ? `The command was stopped after ${commandSeconds} seconds.` : `Exit code ${r.code}.`;
        const shown = redact(r.output || '');
        const output = clip(shown || '(no output)');
        return { history: `run_command: ${command} -> ${r.timedOut ? 'stopped after the time limit' : 'exit code ' + r.code}`, step: { action: 'command', detail: command, extra: { code: r.code, timedOut: Boolean(r.timedOut), output: clip(shown, 3000) } },
          output: `Command: ${command}\n${head}\n${output}` };
      }
      default:
        return { note: `There is no tool "${String(name).slice(0, 30)}".` };
    }
  }

  // "Undo the file changes": every file the task changed back as it was, files it created removed.
  // (What commands did, for example npm install, is not undone: the card says so.)
  function undo() {
    const done = [];
    for (const [abs, content] of originals) {
      try {
        if (content == null) { if (fs.existsSync(abs)) fs.unlinkSync(abs); }
        else fs.writeFileSync(abs, content);
        done.push(rel(abs));
      } catch (e) { /* a file the user moved meanwhile stays as it is */ }
    }
    originals.clear();
    return done;
  }

  // "Files you looked at": each as it is now (whole files up to a size, newest first), at most maxChars together
  function memory(maxChars = 16000, skip = '') {
    const parts = [];
    let used = 0;
    for (const r of seen) {
      if (r === skip) continue;
      const abs = p.join(realRoot, ...r.split('/'));
      let text;
      try {
        if (!fs.existsSync(abs) || fs.statSync(abs).size > MAX_FILE_BYTES) continue;
        text = redact(fs.readFileSync(abs, 'utf8'));
      } catch (e) { continue; }
      const lines = text.split(/\r?\n/).length;
      const room = Math.min(7000, maxChars - used);
      if (room < 400) break;
      const body = text.length > room ? text.slice(0, room) + `\n… (more: read_file ${r} with a start_line)` : text;
      parts.push(`--- ${r} (${lines} lines, as it is now) ---\n${body}`);
      used += body.length;
    }
    return parts.join('\n');
  }

  return {
    tools: TERMINAL_TOOLS,
    memory,
    has: (name) => TERMINAL_TOOL_NAMES.has(name),
    folderName,
    shell: platform === 'win32' ? 'Windows PowerShell' : 'bash',
    get version() { return state.version; },
    changedFiles: () => [...originals.keys()].map(rel),
    overview: () => { try { return listing(realRoot, 60); } catch (e) { return '(the folder could not be read)'; } },
    call,
    undo,
  };
}

module.exports = { createTerminal, classifyCommand, isSecretFile, diffText, clip, redact, tool, TERMINAL_TOOLS, TERMINAL_TOOL_NAMES, COMMAND_SECONDS };
