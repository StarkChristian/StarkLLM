const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { diagnose, buildErrorPage } = require('./diagnostics');
const { startEngine, userPaths, secretKey } = require('./engine');
const crypto = require('crypto');
const { createUpdater } = require('./updates');
const { installOllama } = require('./ollama-install');
const { autoUpdater } = require('electron-updater');

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

function initApp() {
  updater = createUpdater({ app, dialog, shell, net, autoUpdater, getWindow: () => mainWindow, log: logLine, onChange: () => refreshTrayMenu() });
  // Settings > About in the web UI (only the app's own page may ask)
  ipcMain.on('desktop:local-token', (event) => {
    event.returnValue = event.senderFrame && event.senderFrame.url.startsWith(APP_URL) ? localToken : null;
  });
  ipcMain.handle('updates:check', async (event) => {
    if (!event.senderFrame || !event.senderFrame.url.startsWith(APP_URL)) return { error: 'not allowed' };
    const r = await updater.check({ manual: true });
    return { latest: r && r.latest, error: r && r.error };
  });
  createMainWindow();
  createTray();
  // Also when the engine cannot start: an old version is often the reason.
  setTimeout(() => updater.onStart().catch((e) => logLine(`update check: ${e.message}`)), 3000);

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
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: true
    }
  });

  // Load splash screen first
  splashShownAt = Date.now();
  mainWindow.loadFile(path.join(__dirname, 'splash.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    startAndLoad();
  });

  // Handle external links safely in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      if (!url.includes('localhost:5173') && !url.includes('127.0.0.1:5173')) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:') && !url.endsWith('splash.html')) {
      // a file dropped outside the drop area must not replace the app
      event.preventDefault();
    } else if (url.startsWith('starkllm-install-ollama:')) {
      event.preventDefault();
      installOllamaThenStart();
    } else if (url.startsWith('starkllm-retry:')) {
      event.preventDefault();
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

function setSplashStatus(text) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents.getURL().startsWith('file:')) return;
  mainWindow.webContents
    .executeJavaScript(`(function (t, v) {
      var s = document.getElementById('statusMsg'); if (s) s.textContent = t;
      var b = document.getElementById('versionBadge'); if (b) b.textContent = 'Desktop v' + v;
    })(${JSON.stringify(text)}, ${JSON.stringify(app.getVersion())})`)
    .catch(() => {});
}

// Starts Docker, Ollama and the engine (see engine.js), then shows the app or a page that says what is missing.
async function startAndLoad() {
  if (starting) return;
  starting = true;
  let result;
  try {
    result = await startEngine(APP_URL, setSplashStatus);
  } catch (e) {
    result = { ok: false, stage: 'engine', detail: 'Unexpected error: ' + e.message };
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
const API_URL = `http://127.0.0.1:${process.env.STARKLLM_API_PORT || 8000}`;
let localToken = null;

async function fetchLocalSession() {
  try {
    const secret = process.env.SECRET_KEY || secretKey(userPaths().secret);
    const key = crypto.createHmac('sha256', secret).update('starkllm-desktop-session').digest('hex');
    const res = await net.fetch(`${API_URL}/api/v1/auth/desktop-session`, { method: 'POST', headers: { 'X-Desktop-Key': key }, signal: AbortSignal.timeout(8000) });
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

async function showApp() {
  await fetchLocalSession();
  const rest = SPLASH_MIN_MS - (Date.now() - splashShownAt);
  if (rest > 0) await wait(rest);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.webContents.executeJavaScript("document.body.classList.add('leaving')").catch(() => {});
  await wait(SPLASH_FADE_MS);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(APP_URL);
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
    await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'StarkLLM', message: 'Ollama could not be installed.', detail: e.message });
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

    tray.setToolTip('StarkLLM — Local AI Desktop');
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

// Rebuilt when a setting shown in it changes.
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open StarkLLM',
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
      label: 'Reload Application',
      click: () => {
        retryConnection();
      }
    },
    { type: 'separator' },
    {
      label: 'Check for Updates...',
      click: () => updater.check({ manual: true }).catch((e) => logLine(`update check: ${e.message}`))
    },
    {
      label: 'Check for Updates on Start',
      type: 'checkbox',
      checked: updater.isEnabled(),
      click: (item) => {
        updater.setEnabled(item.checked);
        refreshTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit StarkLLM',
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
});
