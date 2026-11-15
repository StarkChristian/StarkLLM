// Automatic encrypted backup (docs/encryption-design.md, "Scheduled backup").
//
// The desktop app drives it, not the engine, because the engine may run in a container that cannot see the user's
// folders (a USB drive, a NAS share, OneDrive). Every run:
//   1. checks the folder (exists, can be written to),
//   2. asks the engine for a backup (it is tested inside the engine by restoring it into a temporary folder),
//   3. saves it into the folder under a temporary name and renames it when complete,
//   4. sends the saved copy back to the engine for a second restore test (the folder or drive may be faulty),
//   5. only then removes the oldest copies beyond "keep". Only files that this program named
//      (starkllm-YYYY-MM-DD_HH-MM[-n].starkbackup) are ever removed; everything else in the folder is left alone.
// The backup passphrase is kept wrapped by the Windows key store (the same KeyStore as the data key), never in plain text.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { cloudSync } = require('./cloud-folder');

const MIN_PASSPHRASE = 12;
const BACKUP_NAME = /^starkllm-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(-\d+)?\.starkbackup$/;
const HOUR = 3600 * 1000;
const RETRY_AFTER_FAILURE_MS = 6 * HOUR;
const DEFAULTS = { enabled: false, folder: '', keep: 4, intervalDays: 7 };

class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MESSAGES = {
  'no-folder': 'Choose a folder for the backups first.',
  'folder-missing': 'The backup folder cannot be found. Is the USB drive or network folder connected?',
  'folder-not-writable': 'StarkLLM cannot write into the backup folder. Choose another folder or check its permissions.',
  'disk-full': 'There is not enough free space in the backup folder.',
  'weak-passphrase': 'Use a passphrase of at least 12 characters.',
  'no-passphrase': 'The backup passphrase is not available on this PC. Enter it again in Settings.',
  'engine-not-ready': 'StarkLLM is not ready yet. The backup will be tried again later.',
  busy: 'Documents are still being processed. The backup will be tried again later.',
  locked: 'StarkLLM is locked. Unlock it in Settings > Protection; the backup will be tried again later.',
  'copy-failed': 'The backup copy in the folder did not pass the restore test. The drive or folder may be faulty; older copies were kept.',
  failed: 'The backup could not be made.'
};

const pad = (n) => String(n).padStart(2, '0');
function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

class BackupScheduler {
  // dir: where config and the wrapped passphrase live. keyStore: see data-key.js. getApi() -> { url, token } | null.
  constructor({ dir, keyStore, getApi, fetchImpl = fetch, now = () => Date.now(), notify = () => {}, log = () => {}, fsImpl = fs }) {
    Object.assign(this, { dir, keyStore, getApi, fetchImpl, now, notify, log, fs: fsImpl });
    this.running = false;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  load() {
    try {
      return { ...DEFAULTS, ...JSON.parse(this.fs.readFileSync(this.file('backup-schedule.json'), 'utf8')) };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  save(cfg) {
    this.fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file('backup-schedule.json.tmp');
    this.fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    this.fs.renameSync(tmp, this.file('backup-schedule.json'));
  }

  passphrase() {
    try {
      return this.keyStore.unwrap(this.fs.readFileSync(this.file('backup-passphrase.wrapped'))).toString('utf8');
    } catch (e) {
      return null;
    }
  }

  // What the Settings page shows.
  status() {
    const c = this.load();
    return {
      enabled: c.enabled, folder: c.folder, keep: c.keep, intervalDays: c.intervalDays,
      cloud: c.folder ? cloudSync(c.folder) : null,
      hasPassphrase: this.fs.existsSync(this.file('backup-passphrase.wrapped')),
      keyStoreAvailable: this.keyStore.isAvailable(),
      running: this.running,
      lastSuccess: c.lastSuccess || null, lastFile: c.lastFile || null, lastReport: c.lastReport || null,
      lastError: c.lastError || null, lastAttempt: c.lastAttempt || null, nextDue: this.nextDue(c)
    };
  }

  nextDue(c = this.load()) {
    if (!c.enabled) return null;
    const base = c.lastSuccess ? c.lastSuccess + c.intervalDays * 24 * HOUR : 0;
    const retry = c.lastError && c.nextTry ? c.nextTry : 0;
    return Math.max(base, retry) || this.now();
  }

  configure({ folder, keep, intervalDays, passphrase }) {
    const c = this.load();
    if (folder !== undefined) {
      if (!folder) throw new BackupError('no-folder', MESSAGES['no-folder']);
      c.folder = folder;
    }
    if (keep !== undefined) c.keep = Math.max(1, Math.min(52, Math.floor(Number(keep)) || DEFAULTS.keep));
    if (intervalDays !== undefined) c.intervalDays = Math.max(1, Math.min(90, Math.floor(Number(intervalDays)) || DEFAULTS.intervalDays));
    if (!c.folder) throw new BackupError('no-folder', MESSAGES['no-folder']);   // check everything before storing anything
    if (passphrase) {
      if (String(passphrase).length < MIN_PASSPHRASE) throw new BackupError('weak-passphrase', MESSAGES['weak-passphrase']);
      if (!this.keyStore.isAvailable()) throw new BackupError('no-key-store', 'This PC has no safe place for the passphrase (the Windows key store is not available).');
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.fs.writeFileSync(this.file('backup-passphrase.wrapped'), this.keyStore.wrap(Buffer.from(String(passphrase), 'utf8')), { mode: 0o600 });
    }
    if (this.passphrase() == null) throw new BackupError('no-passphrase', MESSAGES['no-passphrase']);
    c.enabled = true;
    c.lastError = null;
    c.nextTry = 0;
    this.save(c);
    return this.status();
  }

  disable({ forgetPassphrase = true } = {}) {
    const c = this.load();
    c.enabled = false;
    this.save(c);
    if (forgetPassphrase) {
      try {
        this.fs.unlinkSync(this.file('backup-passphrase.wrapped'));
      } catch (e) {
        // not there
      }
    }
    return this.status();
  }

  // Called at start and then every half hour or so: runs a backup when one is due.
  async tick() {
    const c = this.load();
    if (!c.enabled || this.running || this.now() < this.nextDue(c)) return null;
    return this.runNow();
  }

  async runNow() {
    if (this.running) return { ok: false, code: 'running', message: 'A backup is already running.' };
    this.running = true;
    const c = this.load();
    const attempt = this.now();
    try {
      const result = await this.backup(c);
      Object.assign(c, { lastSuccess: attempt, lastAttempt: attempt, lastError: null, nextTry: 0, lastFile: result.file, lastReport: result.report });
      this.save(c);
      this.log(`backup: ${result.file} saved and tested`);
      return { ok: true, ...result };
    } catch (e) {
      const code = e.code || 'failed';
      const message = e instanceof BackupError ? e.message : `${MESSAGES.failed} (${e.message})`;
      Object.assign(c, { lastAttempt: attempt, lastError: { code, message, at: attempt }, nextTry: attempt + (code === 'folder-missing' ? HOUR : RETRY_AFTER_FAILURE_MS) });
      this.save(c);
      this.log(`backup failed (${code}): ${message}`);
      // a missing drive is normal for a while; a real failure is shown to the user
      if (!['busy', 'engine-not-ready', 'folder-missing'].includes(code)) this.notify('StarkLLM backup failed', message);
      return { ok: false, code, message };
    } finally {
      this.running = false;
    }
  }

  async checkFolder(folder) {
    if (!folder) throw new BackupError('no-folder', MESSAGES['no-folder']);
    try {
      if (!(await this.fs.promises.stat(folder)).isDirectory()) throw new Error('not a folder');
    } catch (e) {
      throw new BackupError('folder-missing', MESSAGES['folder-missing']);
    }
    const probe = path.join(folder, `.starkllm-write-test-${process.pid}-${this.now()}`);
    try {
      await this.fs.promises.writeFile(probe, 'x');
      await this.fs.promises.unlink(probe);
    } catch (e) {
      throw new BackupError(e.code === 'ENOSPC' ? 'disk-full' : 'folder-not-writable', MESSAGES[e.code === 'ENOSPC' ? 'disk-full' : 'folder-not-writable']);
    }
  }

  async engine(path_, options = {}) {
    const api = this.getApi();
    if (!api || !api.token) throw new BackupError('engine-not-ready', MESSAGES['engine-not-ready']);
    let res;
    try {
      res = await this.fetchImpl(api.url + path_, { ...options, headers: { Authorization: `Bearer ${api.token}`, ...(options.headers || {}) } });
    } catch (e) {
      throw new BackupError('engine-not-ready', MESSAGES['engine-not-ready']);
    }
    if (!res.ok) {
      let detail = null;
      try {
        detail = (await res.json()).detail;
      } catch (e) {
        // no body
      }
      const code = detail && detail.code;
      throw new BackupError(MESSAGES[code] ? code : 'failed', (code && MESSAGES[code]) || (detail && detail.message) || `${MESSAGES.failed} (${res.status})`);
    }
    return res;
  }

  async backup(cfg) {
    await this.checkFolder(cfg.folder);
    const passphrase = this.passphrase();
    if (passphrase == null) throw new BackupError('no-passphrase', MESSAGES['no-passphrase']);
    const base = '/api/v1/system/backup';
    const made = await (await this.engine(`${base}/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase })
    })).json();

    const name = this.freeName(cfg.folder, new Date(this.now()));
    const final = path.join(cfg.folder, name);
    const part = final + '.part';
    try {
      const res = await this.engine(`${base}/download/${made.id}`);
      await pipeline(Readable.fromWeb(res.body), this.fs.createWriteStream(part));
      await this.fs.promises.rename(part, final);
    } catch (e) {
      await this.fs.promises.rm(part, { force: true }).catch(() => {});
      if (e.code === 'ENOSPC') throw new BackupError('disk-full', MESSAGES['disk-full']);
      throw e;
    }

    // a second restore test, of the copy that now lies in the user's folder
    const form = new FormData();
    form.append('file', await this.fs.openAsBlob(final), name);
    form.append('passphrase', passphrase);
    try {
      var report = await (await this.engine(`${base}/verify`, { method: 'POST', body: form })).json();
    } catch (e) {
      await this.fs.promises.rm(final, { force: true }).catch(() => {});
      throw new BackupError('copy-failed', MESSAGES['copy-failed']);
    }
    await this.prune(cfg.folder, cfg.keep, name);
    return { file: name, report: { documents: report.documents, rows: report.rows, protected: !!report.protected, size: report.size } };
  }

  freeName(folder, date) {
    const base = `starkllm-${stamp(date)}`;
    let name = `${base}.starkbackup`;
    for (let n = 2; this.fs.existsSync(path.join(folder, name)); n++) name = `${base}-${n}.starkbackup`;
    return name;
  }

  // Keeps the newest `keep` copies that this program made; touches nothing else.
  async prune(folder, keep, justMade) {
    const names = (await this.fs.promises.readdir(folder)).filter((n) => BACKUP_NAME.test(n)).sort().reverse();
    const doomed = names.filter((n) => n !== justMade).slice(Math.max(0, keep - 1));
    for (const n of doomed) await this.fs.promises.rm(path.join(folder, n), { force: true });
    return doomed;
  }
}

module.exports = { BackupScheduler, BackupError, BACKUP_NAME, MESSAGES, DEFAULTS };
