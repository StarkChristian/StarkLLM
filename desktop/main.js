const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { diagnose, buildErrorPage } = require('./diagnostics');
const { startEngine, userPaths } = require('./engine');
const { createUpdater } = require('./updates');

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
  updater = createUpdater({ app, dialog, shell, net, getWindow: () => mainWindow, log: logLine, onChange: () => refreshTrayMenu() });
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
    backgroundColor: '#05070a',
    icon: iconPath,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true
    }
  });

  // Load splash screen first
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
    mainWindow.loadURL(APP_URL);
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

function retryConnection() {
  if (mainWindow && !mainWindow.isDestroyed()) {
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
