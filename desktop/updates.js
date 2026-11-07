// Tells the user when a newer StarkLLM version is published. Nothing is installed automatically.
// The check asks GitHub for the newest release number only, and only after the user agreed once
// (first start), or when they pick "Check for updates" in the tray menu.
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

function createUpdater({ app, dialog, shell, net, getWindow, log = () => {}, onChange = () => {} }) {
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

module.exports = { createUpdater, parseVersion, isNewer, decide, RELEASES_API, DOWNLOAD_PAGE };
