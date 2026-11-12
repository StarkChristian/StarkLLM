// Tells the user when a newer StarkLLM version is published and, in the installed app, downloads and installs it
// without a new download from the website (electron-updater: only the changed parts of the installer are fetched).
// Nothing is checked before the user agreed once (first start), or when they pick "Check for updates" in the
// tray menu or in Settings > About; nothing is downloaded or installed without their click.
// The portable exe (shipped until 2.0.12) cannot replace itself: it gets the download page, as before.
// STARKLLM_UPDATE_CHECK=0 turns the automatic check off (for administrators and tests).
const fs = require('fs');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');

const RELEASES_API = 'https://api.github.com/repos/StarkChristian/StarkLLM/releases/latest';
const DOWNLOAD_PAGE = 'https://www.starkllm.com/download';

// "v2.0.3" or "2.0.3-beta" -> [2, 0, 3]; anything else -> null
function parseVersion(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1, 4).map(Number) : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Windows Smart App Control holds back a new unsigned installer, and the program it installs, for a few hours
// (seen with 2.0.14 and 2.0.15 on 11 Nov 2026: the update needed an admin prompt, then the new StarkLLM.exe was
// blocked for hours). The automatic check therefore offers a release only once it is a day old; "Check for
// updates" in the menu still offers it at once.
const AUTO_MIN_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;

// What to do with a GitHub "latest release" answer. minAgeMs: offer a release only that long after it was published.
function decide(release, current, settings, { now = Date.now(), minAgeMs = 0 } = {}) {
  if (!release || release.draft || release.prerelease) return { show: false };
  const latest = String(release.tag_name || '').replace(/^v/, '');
  if (!isNewer(latest, current)) return { show: false, latest };
  if (settings.skipVersion && settings.skipVersion === latest) return { show: false, latest, skipped: true };
  const published = Date.parse(release.published_at || '');
  if (minAgeMs > 0 && Number.isFinite(published) && now - published < minAgeMs) {
    return { show: false, latest, tooNew: true, offerAfter: new Date(published + minAgeMs).toISOString() };
  }
  return { show: true, latest, url: release.html_url || DOWNLOAD_PAGE };
}

// Copies the database next to the app data before an update, keeping the newest five copies.
function backupDatabase(userData, version, log = () => {}) {
  const db = path.join(userData, 'data', 'starkllm.db');
  if (!fs.existsSync(db)) return null;
  const dir = path.join(userData, 'backups');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `starkllm-${version}-${stamp}.db`);
    fs.copyFileSync(db, target);
    const old = fs.readdirSync(dir).filter((f) => /^starkllm-.*\.db$/.test(f)).sort();
    old.slice(0, Math.max(0, old.length - 5)).forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));
    log(`database backed up to ${target}`);
    return target;
  } catch (e) {
    log(`database backup before the update failed: ${e.message}`);
    return null;
  }
}

// Starts the downloaded installer: { ok: true } once Windows started it, { ok: false, error } when Windows refused.
// Found on a Windows 11 PC with Smart App Control (2.0.14, 11 Nov 2026): a new, unsigned installer is held back for a
// few hours after a release; starting it hung about 10 s and failed with "spawn UNKNOWN". electron-updater then tried
// again through elevate.exe, which showed an admin prompt for an unknown program and still installed nothing (the
// block is not about admin rights). Three hours later the same file started at once. So: no second try with admin
// rights, the app keeps running and says what happened.
function startInstaller(file, args, spawn = nodeSpawn) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(file, args, { detached: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error });
      return;
    }
    p.once('error', (error) => resolve({ ok: false, error }));
    p.once('spawn', () => {
      p.unref();
      resolve({ ok: true });
    });
  });
}

// onStatus({ phase, percent }) tells the page what happens while the download runs: 'downloading' with a percent,
// then 'done'. Without it, Settings showed "Checking..." for the whole download (2.0.12 on Windows).
function createUpdater({ app, dialog, shell, net, getWindow, autoUpdater = null, log = () => {}, onChange = () => {}, onStatus = () => {},
  spawn = nodeSpawn, quit = () => app.quit() }) {
  // Only the installed app can replace itself; the portable exe and runs from source cannot.
  const selfUpdate = Boolean(autoUpdater && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR);
  if (selfUpdate) {
    autoUpdater.autoDownload = false;
    // StarkLLM starts the installer itself (installNow, installOnQuit), so a refused start never ends in elevate.exe
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = { info: (m) => log(`updater: ${m}`), warn: (m) => log(`updater: ${m}`), error: (m) => log(`updater error: ${m}`), debug: () => {} };
  }
  let busy = false;
  let pending = null; // the downloaded update that is not installed yet: { latest, current }
  const file = () => path.join(app.getPath('userData'), 'settings.json');

  function readSettings() {
    try {
      return JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
    } catch (e) {
      return {};
    }
  }

  function writeSettings(patch) {
    const s = { ...readSettings(), ...patch };
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(s, null, 2));
    } catch (e) {
      log(`could not save settings: ${e.message}`);
    }
    return s;
  }

  const parent = () => {
    const w = getWindow();
    return w && !w.isDestroyed() ? w : undefined;
  };

  async function fetchLatest() {
    const res = await net.fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `StarkLLM-Desktop/${app.getVersion()}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return res.json();
  }

  // manual: started from the tray menu, so also say "up to date" or why the check failed.
  async function check({ manual = false } = {}) {
    let release;
    try {
      release = await fetchLatest();
    } catch (e) {
      log(`update check failed: ${e.message}`);
      if (manual) {
        await dialog.showMessageBox(parent(), { type: 'warning', title: 'StarkLLM', message: 'Could not check for updates.', detail: `${e.message}\n\nYou can also look at ${DOWNLOAD_PAGE}.` });
      }
      return { error: e.message };
    }
    const current = app.getVersion();
    const d = decide(release, current, manual ? {} : readSettings(), { minAgeMs: manual ? 0 : AUTO_MIN_RELEASE_AGE_MS });
    log(`update check: current ${current}, latest ${d.latest || '?'}${d.show ? ' (newer)' : ''}${d.tooNew ? ` (published less than a day ago, offered after ${d.offerAfter})` : ''}`);
    if (!d.show) {
      if (manual) await dialog.showMessageBox(parent(), { type: 'info', title: 'StarkLLM', message: `StarkLLM ${current} is the newest version.` });
      return d;
    }
    if (selfUpdate) return offerSelfUpdate(d, current);
    const { response } = await dialog.showMessageBox(parent(), {
      type: 'info',
      title: 'StarkLLM update',
      message: `StarkLLM ${d.latest} is available.`,
      detail: `You have version ${current}. Download the new version and install it over this one; your chats and documents stay.`,
      buttons: ['Open download page', 'Later', 'Skip this version'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) shell.openExternal(DOWNLOAD_PAGE);
    if (response === 2) writeSettings({ skipVersion: d.latest });
    return d;
  }

  // Installed app: download in the background (progress on the taskbar button), then restart to install.
  async function offerSelfUpdate(d, current) {
    if (busy) return { ...d, busy: true };
    const { response } = await dialog.showMessageBox(parent(), {
      type: 'info',
      title: 'StarkLLM update',
      message: `StarkLLM ${d.latest} is available.`,
      detail: `You have version ${current}. StarkLLM can download and install it now; you can keep working while it downloads. Your chats and documents stay, and the database is backed up first.`,
      buttons: ['Download and install', 'Later', 'Skip this version'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 2) writeSettings({ skipVersion: d.latest });
    if (response !== 0) return d;
    busy = true;
    const onProgress = (p) => {
      const w = parent();
      if (w) w.setProgressBar(Math.max(0, Math.min(1, (p.percent || 0) / 100)));
      onStatus({ phase: 'downloading', percent: Math.round(p.percent || 0) });
    };
    onStatus({ phase: 'downloading', percent: 0 });
    autoUpdater.on('download-progress', onProgress);
    try {
      const info = await autoUpdater.checkForUpdates();
      if (!info || !info.updateInfo || !isNewer(info.updateInfo.version, current)) throw new Error('the release has no update files for this app');
      await autoUpdater.downloadUpdate();
    } catch (e) {
      log(`self-update failed: ${e.message}`);
      const { response: r } = await dialog.showMessageBox(parent(), {
        type: 'warning', title: 'StarkLLM update', message: 'The update could not be downloaded.',
        detail: `${e.message}\n\nYou can install it from the download page instead.`,
        buttons: ['Open download page', 'Close'], defaultId: 0, cancelId: 1
      });
      if (r === 0) shell.openExternal(DOWNLOAD_PAGE);
      return { ...d, error: e.message };
    } finally {
      autoUpdater.removeListener('download-progress', onProgress);
      const w = parent();
      if (w) w.setProgressBar(-1);
      onStatus({ phase: 'done' });
      busy = false;
    }
    log(`update ${d.latest} downloaded`);
    const { response: restart } = await dialog.showMessageBox(parent(), {
      type: 'info', title: 'StarkLLM update', message: `StarkLLM ${d.latest} is ready to install.`,
      detail: 'Restart now to install it, or it is installed when you quit StarkLLM. The first start after the update prepares the new engine (a few minutes).',
      buttons: ['Restart now', 'When I quit'], defaultId: 0, cancelId: 1
    });
    backupDatabase(app.getPath('userData'), current, log);
    pending = { latest: d.latest, current };
    if (restart !== 0) return { ...d, downloaded: true };
    const started = await runInstaller(true);
    if (started.ok) {
      pending = null;
      quit();
      return { ...d, downloaded: true, installing: true };
    }
    await showBlocked(d.latest, current);
    return { ...d, downloaded: true, blocked: true };
  }

  // runAfter: start StarkLLM again when the installer is done ("Restart now"); not when the user quit the app.
  async function runInstaller(runAfter) {
    const file = autoUpdater.installerPath;
    if (!file) return { ok: false, error: new Error('the downloaded installer is missing') };
    const args = ['--updated', '/S', ...(runAfter ? ['--force-run'] : [])];
    log(`starting the installer: ${file} ${args.join(' ')}`);
    const r = await startInstaller(file, args, spawn);
    if (!r.ok) log(`Windows did not start the installer (${r.error.code || 'no code'}: ${r.error.message}); not retried with admin rights`);
    return r;
  }

  async function showBlocked(latest, current) {
    const { response } = await dialog.showMessageBox(parent(), {
      type: 'warning',
      title: 'StarkLLM update',
      message: `Windows has not started the StarkLLM ${latest} installer yet.`,
      detail: `Windows checks a program it does not know yet before it lets it run (Smart App Control). StarkLLM is not signed yet, so a new version can be held back for a few hours after its release.\n\nStarkLLM keeps running with version ${current}; nothing was changed. StarkLLM tries again when you quit it, or try it later with "Check for updates" (the update is already downloaded).`,
      buttons: ['OK', 'Open download page'],
      defaultId: 0,
      cancelId: 0
    });
    if (response === 1) shell.openExternal(DOWNLOAD_PAGE);
  }

  // "When I quit", and after a refused start: start the installer while the app closes. If Windows refuses again, the
  // next start offers the update again (the file is already downloaded); there is no window left for a message.
  function installOnQuit() {
    if (!pending || !selfUpdate) return;
    pending = null;
    runInstaller(false).catch((e) => log(`installer on quit: ${e.message}`));
  }

  // On every start: ask once whether checking is OK, then check if the user agreed.
  async function onStart() {
    if (process.env.STARKLLM_UPDATE_CHECK === '0') return;
    let s = readSettings();
    if (typeof s.updateCheck !== 'boolean') {
      const { response } = await dialog.showMessageBox(parent(), {
        type: 'question',
        title: 'StarkLLM',
        message: 'Check for new StarkLLM versions when the app starts?',
        detail: 'StarkLLM then asks GitHub for the newest version number. No documents, chats or usage data are sent. You can change this in the tray menu.',
        buttons: ['Check for updates', "Don't check"],
        defaultId: 0,
        cancelId: 1
      });
      s = writeSettings({ updateCheck: response === 0 });
      log(`update check ${s.updateCheck ? 'allowed' : 'declined'} by the user`);
      onChange();
    }
    if (s.updateCheck) await check();
  }

  return {
    onStart,
    check,
    installOnQuit,
    isEnabled: () => readSettings().updateCheck === true,
    setEnabled: (on) => writeSettings({ updateCheck: !!on })
  };
}

module.exports = { createUpdater, startInstaller, parseVersion, isNewer, decide, backupDatabase, RELEASES_API, DOWNLOAD_PAGE, AUTO_MIN_RELEASE_AGE_MS };
