// Tells the user when a newer StarkLLM version is published and, in the installed app, downloads and installs it
// without a new download from the website (electron-updater: only the changed parts of the installer are fetched).
// Nothing is checked before the user agreed once (first start), or when they pick "Check for updates" in the
// tray menu or in Settings > About; nothing is downloaded or installed without their click.
// The portable exe cannot replace itself: it gets the download page, as before.
// STARKLLM_UPDATE_CHECK=0 turns the automatic check off (for administrators and tests).
const fs = require('fs');
const path = require('path');

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

// What to do with a GitHub "latest release" answer.
function decide(release, current, settings) {
  if (!release || release.draft || release.prerelease) return { show: false };
  const latest = String(release.tag_name || '').replace(/^v/, '');
  if (!isNewer(latest, current)) return { show: false, latest };
  if (settings.skipVersion && settings.skipVersion === latest) return { show: false, latest, skipped: true };
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

function createUpdater({ app, dialog, shell, net, getWindow, autoUpdater = null, log = () => {}, onChange = () => {} }) {
  // Only the installed app can replace itself; the portable exe and runs from source cannot.
  const selfUpdate = Boolean(autoUpdater && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR);
  if (selfUpdate) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info: (m) => log(`updater: ${m}`), warn: (m) => log(`updater: ${m}`), error: (m) => log(`updater error: ${m}`), debug: () => {} };
  }
  let busy = false;
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
    const d = decide(release, current, manual ? {} : readSettings());
    log(`update check: current ${current}, latest ${d.latest || '?'}${d.show ? ' (newer)' : ''}`);
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
    };
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
      busy = false;
    }
    log(`update ${d.latest} downloaded`);
    const { response: restart } = await dialog.showMessageBox(parent(), {
      type: 'info', title: 'StarkLLM update', message: `StarkLLM ${d.latest} is ready to install.`,
      detail: 'Restart now to install it, or it is installed when you quit StarkLLM. The first start after the update prepares the new engine (a few minutes).',
      buttons: ['Restart now', 'When I quit'], defaultId: 0, cancelId: 1
    });
    backupDatabase(app.getPath('userData'), current, log);
    if (restart === 0) setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ...d, downloaded: true };
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
    isEnabled: () => readSettings().updateCheck === true,
    setEnabled: (on) => writeSettings({ updateCheck: !!on })
  };
}

module.exports = { createUpdater, parseVersion, isNewer, decide, backupDatabase, RELEASES_API, DOWNLOAD_PAGE };
