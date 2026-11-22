const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, net, session, safeStorage, Notification } = require('electron');
const { sameOrigin, isWebLink, permissionAllowed } = require('./window-security');
const fs = require('fs');
const path = require('path');
const { diagnose, buildErrorPage } = require('./diagnostics');
const { startEngine, userPaths, secretKey, forgetFailedUpdate, apiUrl, stopNativeEngine, engineSettingsFile } = require('./engine');
const nativeEngine = require('./native-engine');
const integratedGpu = require('./igpu');
const { DataKeyManager, DataKeyError, createSafeStorageKeyStore, deliverKey, lockEngine } = require('./data-key');
const { createUnlockFlow } = require('./unlock-flow');
const { pathToFileURL } = require('url');
const { BackupScheduler } = require('./backup-schedule');
const { createUpdater } = require('./updates');
const { installOllama } = require('./ollama-install');
const { autoUpdater } = require('electron-updater');
const i18n = require('./i18n');
const { t } = i18n;
const { initShared } = require('./netguard');
const webtask = require('./webtask');
const { askOfflineChoice } = require('./offline-choice');
const { desktopKey, setEngineOffline, switchOffline } = require('./engine-offline');
const { createPhoneLink } = require('./phonelink');
const { qrMatrix } = require('./qr');
const exportPdf = require('./export-pdf');
const mcp = require('./mcp');

let mainWindow = null;
let tray = null;
let isQuitting = false;

const APP_URL = process.env.STARKLLM_URL || `http://localhost:${process.env.STARKLLM_UI_PORT || 5173}`;
let starting = false;
let updater = null;

function logLine(line) {
  try {
    fs.appendFileSync(userPaths().log, `[${new Date().toISOString()}] ${line}\n`);
  } catch (e) {
    // logging must never stop the app
  }
}

// Ensure single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(initApp);
}

// The network layer (netguard.js): records every connection of the main process and of the window, and holds the
// "fully offline" switch. Created first, so that nothing below can connect before it exists.
let guard = null;

// The first-start question "stay online or go fully offline" comes before the update check: the update check asks its
// own question on the first start, and two questions at once (or an update check before the answer "offline") must
// not happen. Resolved when the question was answered, or was not needed.
let offlineQuestionDone = null;
const offlineQuestionAnswered = new Promise((resolve) => { offlineQuestionDone = resolve; });

// What the switch changes besides the rules of the network layer: Chromium downloads spell-check dictionaries from
// Google's servers on Windows, which is a connection the page's request hook does not see, so spell check is off while
// the app is fully offline.
function applyOffline() {
  try {
    session.defaultSession.setSpellCheckerEnabled(!guard.isOffline());
  } catch (e) {
    logLine(`spell check setting: ${e.message}`);
  }
}

function initApp() {
  i18n.init(app.getPath('userData'), app.getLocale());  // the language the user chose in Settings, else Windows's
  guard = initShared(app.getPath('userData'));
  guard.attachSession(session.defaultSession);
  applyOffline();
  updater = createUpdater({ app, dialog, shell, net, autoUpdater, getWindow: () => mainWindow, log: logLine, onChange: () => refreshTrayMenu(),
    onStatus: (s) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:status', s); } });
  // The web UI tells the desktop app which language the user chose (Settings > Language), for dialogs and the tray menu
  ipcMain.on('desktop:set-language', (event, code) => {
    if (!fromAppPage(event) || !i18n.supported(code) || i18n.supported(code) === i18n.language()) return;
    i18n.save(app.getPath('userData'), code);
    i18n.setLanguage(code);
    if (tray) tray.setToolTip(t('StarkLLM — Local AI Desktop'));
    refreshTrayMenu();
  });
  // Settings > About in the web UI (only the app's own page may ask)
  ipcMain.on('desktop:local-token', (event) => {
    event.returnValue = event.senderFrame && sameOrigin(event.senderFrame.url, APP_URL) ? localToken : null;
  });
  // Knowledge Base > "Open folder": only the app's own page, and only the knowledge-base folder (no path from the page)
  ipcMain.handle('kb:open-folder', async (event) => {
    if (!event.senderFrame || !sameOrigin(event.senderFrame.url, APP_URL)) return { error: 'not allowed' };
    const dir = userPaths().kb;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { error: e.message };
    }
    const err = await shell.openPath(dir);
    return err ? { error: err } : { ok: true };
  });
  // Settings > Privacy: the fully offline switch and the list of connections of the app (only the app's own page may ask)
  const fromApp = (event) => Boolean(event.senderFrame && sameOrigin(event.senderFrame.url, APP_URL));
  exportPdf.register(ipcMain, { fromApp }); // chats and answers as PDF (docs/roadmap-2026-12.md, R1)
  // tool servers (MCP) the user added: started by the desktop app, each call after a yes in the chat (docs/roadmap-2026-12.md, R6)
  mcp.register(ipcMain, { fromApp, offline: () => require('./netguard').getShared().isOffline(), log: logLine });
  app.on('will-quit', () => mcp.stopAll());
  const privacyState = () => ({ offline: guard.isOffline(), localCounts: guard.localCounts() });
  ipcMain.handle('privacy:get', (event) => (fromApp(event) ? privacyState() : { error: 'not allowed' }));
  // sets the app and the engine (engine-offline.js); the answer says what the engine did
  ipcMain.handle('privacy:set-offline', async (event, on) => {
    if (!fromApp(event)) return { error: 'not allowed' };
    const r = await switchAppAndEngineOffline(Boolean(on), 'settings');
    return { ...privacyState(), engine: r.engine, engineError: r.engineError, engineDetail: r.engineDetail };
  });
  ipcMain.handle('privacy:log', (event, limit) => (fromApp(event) ? guard.list(Math.min(Number(limit) || 500, 5000)) : { error: 'not allowed' }));
  ipcMain.handle('privacy:clear-log', (event) => {
    if (!fromApp(event)) return { error: 'not allowed' };
    guard.clear();
    return { ok: true };
  });
  registerPhoneLinkHandlers();
  webtask.register(ipcMain, { fromApp, log: logLine });
  app.on("will-quit", () => webtask.stopCommands()); // commands of a web task end with StarkLLM
  registerProtectionHandlers();
  registerUnlockHandlers();
  lockEngineOnQuit();
  registerBackupHandlers();
  ipcMain.handle('updates:check', async (event) => {
    if (!event.senderFrame || !sameOrigin(event.senderFrame.url, APP_URL)) return { error: 'not allowed' };
    const r = await updater.check({ manual: true });
    return { latest: r && r.latest, error: r && r.error, upToDate: Boolean(r && !r.error && !r.show) };
  });
  // Electron grants every permission to every page unless told otherwise: only the app's own page, only what it uses
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permissionAllowed(permission, (details && details.requestingUrl) || wc.getURL(), APP_URL, details || {}));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
    permissionAllowed(permission, requestingOrigin || (wc && wc.getURL()) || '', APP_URL, details || {}));
  createMainWindow();
  createTray();
  // Also when the engine cannot start: an old version is often the reason.
  // After the offline question of the first start (see offlineQuestionAnswered).
  offlineQuestionAnswered
    .then(() => new Promise((resolve) => setTimeout(resolve, 3000)))
    .then(() => updater.onStart())
    .catch((e) => logLine(`update check: ${e.message}`));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createMainWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: 'StarkLLM',
    backgroundColor: '#07060b',
    icon: iconPath,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: true
    }
  });
  // a scheduled web task runs in a hidden window: it ends with the main window, so StarkLLM does not stay open unseen
  mainWindow.on('closed', () => webtask.shutdown());

  // Load splash screen first
  splashShownAt = Date.now();
  mainWindow.loadFile(path.join(__dirname, 'splash.html'));

  // The engine starts at 'ready-to-show', or after 5 s if that never comes (seen on the MSI test with a locked
  // session: the start screen stayed at "Starting..." and nothing happened).
  let begun = false;
  const begin = async () => {
    if (begun || !mainWindow || mainWindow.isDestroyed()) return;
    begun = true;
    mainWindow.show();
    // once, at the first start: stay online (default) or go fully offline; the engine starts with the answer
    try {
      if (await askOfflineChoice({ dialog, guard, parent: mainWindow, locale: i18n.language(), log: logLine })) {
        applyOffline();
        refreshTrayMenu();
      }
    } catch (e) {
      logLine(`offline question: ${e.message}`);
    }
    offlineQuestionDone();
    startAndLoad();
  };
  mainWindow.once('ready-to-show', begin);
  setTimeout(begin, 5000);

  // No new app windows: a new window would get the desktop bridge (and with it the session token). Links to web sites
  // open in the user's browser; anything else is refused. (Before, a link whose text merely contained
  // "localhost:5173", or any non-web link, opened inside the app.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url) && !sameOrigin(url, APP_URL)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isWebLink(url) && !sameOrigin(url, APP_URL)) {
      // a link in an answer or a document: the browser opens it, the app stays where it is
      event.preventDefault();
      shell.openExternal(url);
    } else if (url.startsWith('file:') && !url.endsWith('splash.html')) {
      // a file dropped outside the drop area must not replace the app
      event.preventDefault();
    } else if (url.startsWith('starkllm-install-ollama:')) {
      event.preventDefault();
      installOllamaThenStart();
    } else if (url.startsWith('starkllm-retry:')) {
      event.preventDefault();
      // Retry also tries a new engine again at once, instead of a day after it failed
      forgetFailedUpdate();
      retryConnection();
    } else if (url.startsWith('starkllm-continue:')) {
      event.preventDefault();
      mainWindow.loadURL(APP_URL);
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      // Allow standard close on Windows
      mainWindow = null;
    }
  });
}

// fraction: 0..1 for a download with a known size (the bar then shows it), otherwise the bar is an animation.
function setSplashStatus(text, fraction) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents.getURL().startsWith('file:')) return;
  const f = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : null;
  mainWindow.webContents
    .executeJavaScript(`(function (t, v, f) {
      var s = document.getElementById('statusMsg'); if (s) s.textContent = t;
      var b = document.getElementById('versionBadge'); if (b) b.textContent = ${JSON.stringify(t('Desktop'))} + ' v' + v;
      var g = document.querySelector('.tagline'); if (g) g.textContent = ${JSON.stringify(t('Private, local-first AI for your documents'))};
      if (window.setProgress) window.setProgress(f);
    })(${JSON.stringify(text)}, ${JSON.stringify(app.getVersion())}, ${JSON.stringify(f)})`)
    .catch(() => {});
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(f == null ? -1 : f);
}

// Starts Docker, Ollama and the engine (see engine.js), then shows the app or a page that says what is missing.
async function startAndLoad() {
  if (starting) return;
  starting = true;
  let result;
  try {
    result = await startEngine(APP_URL, setSplashStatus);
  } catch (e) {
    result = { ok: false, stage: 'engine', detail: t('Unexpected error: {error}', { error: e.message }) };
  }
  starting = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (result.ok && result.ollama && !result.warnings.length) {
    await showApp();
  } else {
    showEngineProblem(result);
  }
}

async function showEngineProblem(result) {
  const diagnosis = await diagnose({ ...result, logFile: userPaths().log });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildErrorPage(diagnosis)));
  }
}

// The start screen stays at least this long, so the logo is seen even when the engine is already running,
// and fades out instead of jumping to the app.
const SPLASH_MIN_MS = 1600;
const SPLASH_FADE_MS = 350;
let splashShownAt = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Single user on this PC: the backend signs in a "local" user when it gets the key derived from the engine's
// SECRET_KEY (see backend/app/api/auth.py, desktop-session). Refused (409) once other accounts exist.
let localToken = null;
// The phone link: the session of each account signed in in this window (account -> session), in memory only. A phone
// paired while an account was signed in here uses that account (Settings > Phone; several accounts on one PC).
const phoneSessions = new Map();

async function accountOf(token) {
  if (!token) return '';
  try {
    const res = await guard.wrapFetch((u, o) => net.fetch(u, o), 'local_engine', 'Which account is signed in, for the phone link')(`${apiUrl()}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return '';
    const me = await res.json();
    return typeof me.username === 'string' ? me.username : '';
  } catch (e) {
    return '';
  }
}

async function keepPhoneSession(token) {
  const user = await accountOf(String(token || ''));
  if (user) phoneSessions.set(user, String(token));
  return user;
}

async function fetchLocalSession() {
  try {
    const key = desktopKey(engineSecret());
    const res = await guard.wrapFetch((u, o) => net.fetch(u, o), 'local_engine', 'Sign-in of the local user at the engine on this PC')(`${apiUrl()}/api/v1/auth/desktop-session`, { method: 'POST', headers: { 'X-Desktop-Key': key }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      localToken = (await res.json()).access_token || null;
      logLine('signed in as the local user');
    } else {
      localToken = null;
      logLine(`local session not used (${res.status}): accounts exist, the login is shown`);
    }
  } catch (e) {
    logLine(`local session failed: ${e.message}`);
  }
}

// Protection at rest (docs/encryption-design.md): the data key lives wrapped in the Windows key store, in the user's
// profile next to the data folder. The engine gets it in memory after it started; it never writes it down.
let dataKeys = null;
let engineUnlocked = false;      // the key has been handed to the engine in this run of the app
function keyManager() {
  if (!dataKeys) {
    dataKeys = new DataKeyManager({ dir: path.join(app.getPath('userData'), 'protection'), keyStore: createSafeStorageKeyStore(safeStorage) });
  }
  return dataKeys;
}

function engineSecret() {
  return process.env.SECRET_KEY || secretKey(userPaths().secret);
}

// Hands the key to the engine (if protection was set up on this PC). Returns { ok } or { error, message }.
async function unlockEngine(passphrase) {
  const keys = keyManager();
  if (!keys.status().hasKey) return { ok: true, skipped: true };
  try {
    const key = keys.load(passphrase);
    const r = await deliverKey({ apiUrl: apiUrl(), secret: engineSecret(), key });
    key.fill(0);
    if (!r.ok) {
      logLine(`protection: the engine refused the key (${r.status})`);
      return { error: 'engine-refused', message: r.detail || `The engine refused the key (${r.status}).` };
    }
    logLine('protection: engine unlocked');
    engineUnlocked = true;
    return { ok: true };
  } catch (e) {
    logLine(`protection: key not available (${e.code || e.message})`);
    return { error: e.code || 'failed', message: e.message };
  }
}

function fromAppPage(event) {
  return event.senderFrame && sameOrigin(event.senderFrame.url, APP_URL);
}

// Settings > Protection. Only the app's own page may ask, and the key itself never goes to the page (the recovery
// key does, once, to be shown to the user).
function registerProtectionHandlers() {
  const guard = (fn) => async (event, ...args) => {
    if (!fromAppPage(event)) return { error: 'not-allowed' };
    try {
      return await fn(...args);
    } catch (e) {
      return { error: e instanceof DataKeyError ? e.code : 'failed', message: e.message };
    }
  };
  ipcMain.handle('protection:status', guard(() => keyManager().status()));
  ipcMain.handle('protection:create-key', guard(async () => {
    const { recoveryKey } = keyManager().create();
    const unlocked = await unlockEngine();
    return unlocked.error ? unlocked : { recoveryKey };
  }));
  ipcMain.handle('protection:unlock', guard((passphrase) => unlockEngine(passphrase)));
  ipcMain.handle('protection:recover', guard(async (recoveryKey) => {
    keyManager().recover(recoveryKey);
    return unlockEngine();
  }));
  // After a restore of a protected backup: the backup's key becomes this PC's key (the engine already has it).
  ipcMain.handle('protection:store-key', guard((keyBase64) => {
    const key = Buffer.from(String(keyBase64 || ''), 'base64');
    return keyManager().install(key);
  }));
  ipcMain.handle('protection:set-passphrase', guard(async (passphrase) => {
    const keys = keyManager();
    keys.enablePassphrase(passphrase, keys.load());
    return { ok: true };
  }));
  ipcMain.handle('protection:remove-passphrase', guard((passphrase) => {
    keyManager().disablePassphrase(passphrase);
    return { ok: true };
  }));
  // Protection switched off for good: remove the key (documents are plain again, nothing needs it).
  ipcMain.handle('protection:forget-key', guard(() => {
    keyManager().forget();
    return { ok: true };
  }));
}

// The start-up passphrase (optional): the engine is locked again first, so that a container that kept running does not
// stay open, and the passphrase page is shown instead of the app until the key has been handed over.
const UNLOCK_PAGE = path.join(__dirname, 'unlock.html');
let unlockFlow = null;

function fromUnlockPage(event) {
  return event.senderFrame && event.senderFrame.url.split('?')[0] === pathToFileURL(UNLOCK_PAGE).href;  // ?lang=.. says the language
}

function registerUnlockHandlers() {
  unlockFlow = createUnlockFlow({ keys: keyManager(), unlockEngine, onUnlocked: () => showApp() });
  ipcMain.handle('unlock:submit', async (event, passphrase) => (fromUnlockPage(event) ? unlockFlow.submit(passphrase) : { error: 'not-allowed' }));
  ipcMain.handle('unlock:recover', async (event, recoveryKey) => (fromUnlockPage(event) ? unlockFlow.recover(recoveryKey) : { error: 'not-allowed' }));
}

let quitLocked = false;
function lockEngineOnQuit() {
  app.on('before-quit', (event) => {
    if (quitLocked || !keyManager().status().passphrase) return;
    event.preventDefault();                       // wait (briefly) until the engine has forgotten the key
    quitLocked = true;
    lockEngine({ apiUrl: apiUrl(), secret: engineSecret() }).finally(() => app.quit());
  });
}

// Automatic encrypted backup (backup-schedule.js): the desktop app drives it because the engine may not see the user's folders.
let scheduler = null;
function backupScheduler() {
  if (!scheduler) {
    scheduler = new BackupScheduler({
      dir: path.join(app.getPath('userData'), 'protection'),
      keyStore: keyManager().keyStore,
      getApi: () => (localToken ? { url: apiUrl(), token: localToken } : null),
      notify: (title, body) => {
        try {
          if (Notification.isSupported()) new Notification({ title, body }).show();
        } catch (e) {
          // a missing notification must not matter
        }
      },
      log: logLine
    });
  }
  return scheduler;
}

function registerBackupHandlers() {
  const guard = (fn) => async (event, ...args) => {
    if (!fromAppPage(event)) return { error: 'not-allowed' };
    try {
      return await fn(...args);
    } catch (e) {
      return { error: e.code || 'failed', message: e.message };
    }
  };
  ipcMain.handle('backup:status', guard(() => backupScheduler().status()));
  ipcMain.handle('backup:choose-folder', guard(async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? { canceled: true } : { folder: r.filePaths[0] };
  }));
  ipcMain.handle('backup:configure', guard((settings) => backupScheduler().configure(settings || {})));
  ipcMain.handle('backup:run-now', guard(() => backupScheduler().runNow()));
  ipcMain.handle('backup:disable', guard(() => backupScheduler().disable()));
}

// Settings > Phone (phonelink.js): the Android app on the home network. Off until the user turns it on; it starts once
// the engine runs and stops while the app is fully offline.
let phoneLink = null;
function phone() {
  if (!phoneLink) {
    phoneLink = createPhoneLink({
      dir: path.join(app.getPath('userData'), 'phone'),
      guard,
      getApi: () => ({ url: apiUrl(), token: localToken }),
      refreshToken: fetchLocalSession,
      sessionFor: (user) => phoneSessions.get(user) || null,
      sessionExpired: (user) => phoneSessions.delete(user),
      log: logLine,
      version: app.getVersion(),
      onChange: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('phone:changed');
      },
      // what the phone's "This PC" page shows; no paths, keys or file names
      pcStatus: () => {
        const b = backupScheduler().status();
        const p = keyManager().status();
        return {
          backup: { enabled: Boolean(b.enabled), running: Boolean(b.running), lastSuccess: b.lastSuccess || null, nextDue: b.nextDue || null,
            lastError: b.lastError ? { code: b.lastError.code || 'failed', at: b.lastError.at || null } : null },
          protection: { enabled: Boolean(p.hasKey), passphrase: Boolean(p.passphrase) },
          offline: guard.isOffline()
        };
      },
      // phones at the level "manage" (Settings > Phone)
      actions: {
        'backup-now': async () => {
          const r = await backupScheduler().runNow();
          return r && r.ok === false ? { ok: false, code: r.code || 'failed' } : { ok: true };
        },
        'go-offline': () => switchAppAndEngineOffline(true, 'phone')
      }
    });
  }
  return phoneLink;
}

function registerPhoneLinkHandlers() {
  const allowed = (fn) => async (event, ...args) => {
    if (!fromAppPage(event)) return { error: 'not-allowed' };
    try {
      return await fn(...args);
    } catch (e) {
      return { error: 'failed', message: e.message };
    }
  };
  ipcMain.handle('phone:status', allowed(() => phone().status()));
  ipcMain.handle('phone:enable', allowed((on) => phone().setEnabled(Boolean(on))));
  ipcMain.handle('phone:user-session', allowed(async (token) => ({ ok: Boolean(await keepPhoneSession(token)) })));
  ipcMain.handle('phone:pair', allowed(async (token) => {
    const user = await keepPhoneSession(token);
    const p = phone().startPairing({ user });
    return p.error ? p : { ...p, qr: qrMatrix(p.uri) };
  }));
  ipcMain.handle('phone:cancel-pair', allowed(() => phone().cancelPairing()));
  ipcMain.handle('phone:remove', allowed((id) => phone().removeDevice(String(id || ''))));
  ipcMain.handle('phone:set-level', allowed((id, level) => phone().setLevel(String(id || ''), String(level || ''))));
}

let backupTimer = null;
function startBackupSchedule() {
  if (backupTimer) return;
  const tick = () => backupScheduler().tick().catch((e) => logLine(`backup schedule: ${e.message}`));
  setTimeout(tick, 2 * 60 * 1000);                      // not while the app is still starting
  backupTimer = setInterval(tick, 30 * 60 * 1000);
}

async function showApp() {
  if (!engineUnlocked) {
    if (keyManager().status().passphrase) {
      await lockEngine({ apiUrl: apiUrl(), secret: engineSecret() });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(UNLOCK_PAGE, { query: { lang: i18n.language() } });
      return;                                     // the passphrase page calls showApp() again once the key is handed over
    }
    await unlockEngine();
  }
  await fetchLocalSession();
  const rest = SPLASH_MIN_MS - (Date.now() - splashShownAt);
  if (rest > 0) await wait(rest);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.webContents.executeJavaScript("document.body.classList.add('leaving')").catch(() => {});
  await wait(SPLASH_FADE_MS);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(APP_URL);
  startBackupSchedule();
  phone().start().catch((e) => logLine(`phone link: ${e.message}`));
}

// "Install Ollama for me" on the what-is-missing page: download, check the signature, install, start again.
async function installOllamaThenStart() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  splashShownAt = Date.now();
  await mainWindow.loadFile(path.join(__dirname, 'splash.html'));
  try {
    await installOllama({ onStatus: setSplashStatus, log: logLine });
  } catch (e) {
    logLine(`Ollama install failed: ${e.message}`);
    await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'StarkLLM', message: t('Ollama could not be installed.'), detail: e.message });
  }
  startAndLoad();
}

function retryConnection() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    splashShownAt = Date.now();
    mainWindow.loadFile(path.join(__dirname, 'splash.html')).then(startAndLoad);
  }
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    let trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'Logo.png')).resize({ width: 16, height: 16 });
    }
    tray = new Tray(trayIcon);

    tray.setToolTip(t('StarkLLM — Local AI Desktop'));
    refreshTrayMenu();

    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn('System tray creation non-fatal error:', err.message);
  }
}

// The switch lives in the app and in the engine; Settings and the tray menu set both (engine-offline.js: "offline"
// wins, and the engine accepts the desktop app with the key derived from its SECRET_KEY, whoever is signed in).
async function switchAppAndEngineOffline(on, from) {
  if (on) webtask.stopForOffline(); // a web task that runs ends with the switch
  if (on) mcp.stopAll(); // tool servers end with the offline switch
  const setEngine = (value) => setEngineOffline({
    fetchFn: guard.wrapFetch((u, o) => net.fetch(u, o), 'local_engine', 'Fully offline switch of the engine on this PC'),
    apiUrl: apiUrl(), key: desktopKey(engineSecret()), on: value
  });
  const r = await switchOffline({ guard, on, setEngine });
  logLine(`fully offline: ${r.offline ? 'on' : 'off'} (${from}); engine: ${r.engineError ? `${r.engineError} ${r.engineDetail || ''}`.trim() : (r.engine ? 'on' : 'off')}`);
  applyOffline();
  refreshTrayMenu();
  // fully offline closes the phone link; back online, it opens again if the user turned it on
  if (phoneLink) phoneLink.start().catch((e) => logLine(`phone link: ${e.message}`));
  return r;
}

// Changing the engine needs a restart: the running engine is stopped and the other one started. Chats and documents
// stay the same (both use the same data folder).
async function chooseEngine(choice) {
  const { response } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: 'question',
    title: 'StarkLLM',
    message: t('Restart StarkLLM to change the engine?'),
    detail: t('The engine without Docker is the default and needs nothing else. Docker Desktop is for advanced users who already run it. Your chats and documents stay the same: both engines use the same data folder.'),
    buttons: [t('Restart now'), t('Later')],
    defaultId: 0,
    cancelId: 1
  });
  if (response !== 0) {
    refreshTrayMenu();
    return;
  }
  nativeEngine.writeEngineChoice(engineSettingsFile(), choice);
  logLine(`engine choice: ${choice} (tray menu), restarting`);
  isQuitting = true;
  app.relaunch();
  app.quit();
}

// Integrated graphics for the AI models (igpu.js): on by default where Ollama would leave them out; off from here.
// Ollama is restarted with the new setting at the next start of StarkLLM.
async function chooseIntegratedGpu(on) {
  const { response } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: 'question',
    title: 'StarkLLM',
    message: t('Restart StarkLLM to change this?'),
    detail: t('StarkLLM restarts Ollama (the local AI runtime) with the new setting. Your chats and documents are not affected.'),
    buttons: [t('Restart now'), t('Later')],
    defaultId: 0,
    cancelId: 1
  });
  if (response !== 0) {
    refreshTrayMenu();
    return;
  }
  integratedGpu.writeSetting(engineSettingsFile(), { mode: on ? 'auto' : 'off' });
  logLine(`integrated graphics: ${on ? 'on' : 'off'} (tray menu), restarting`);
  isQuitting = true;
  app.relaunch();
  app.quit();
}

// Rebuilt when a setting shown in it changes.
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: t('Open StarkLLM'),
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createMainWindow();
        }
      }
    },
    {
      label: t('Reload Application'),
      click: () => {
        retryConnection();
      }
    },
    { type: 'separator' },
    {
      label: guard && guard.isOffline() ? t('Fully offline: on (no connections)') : t('Fully offline: off'),
      type: 'checkbox',
      checked: Boolean(guard && guard.isOffline()),
      click: (item) => {
        switchAppAndEngineOffline(item.checked, 'tray menu').catch((e) => logLine(`fully offline (tray menu): ${e.message}`));
      }
    },
    ...(process.platform === 'win32' ? [{
      // the engine without Docker is the default; Docker Desktop is for people who already run it (advanced)
      label: t('Use Docker Desktop for the engine (advanced)'),
      type: 'checkbox',
      checked: nativeEngine.engineMode({ choice: nativeEngine.readEngineChoice(engineSettingsFile()) }) === 'docker',
      enabled: !process.env.STARKLLM_ENGINE,
      click: (item) => chooseEngine(item.checked ? 'docker' : 'native').catch((e) => logLine(`engine choice: ${e.message}`))
    }] : []),
    // shown once StarkLLM has seen integrated graphics on this PC
    ...(process.platform === 'win32' && integratedGpu.readSetting(engineSettingsFile()).name ? [{
      label: t('Use the integrated graphics for AI'),
      type: 'checkbox',
      checked: integratedGpu.readSetting(engineSettingsFile()).mode !== 'off',
      click: (item) => chooseIntegratedGpu(item.checked).catch((e) => logLine(`integrated graphics: ${e.message}`))
    }] : []),
    {
      label: t('Check for Updates...'),
      enabled: !(guard && guard.isOffline()),
      click: () => updater.check({ manual: true }).catch((e) => logLine(`update check: ${e.message}`))
    },
    {
      label: t('Check for Updates on Start'),
      type: 'checkbox',
      checked: updater.isEnabled(),
      click: (item) => {
        updater.setEnabled(item.checked);
        refreshTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: t('Quit StarkLLM'),
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (updater) updater.installOnQuit();
  if (phoneLink) phoneLink.stop();
  // the engine without Docker is a child of the app; Docker's engine keeps running as before
  stopNativeEngine();
});
