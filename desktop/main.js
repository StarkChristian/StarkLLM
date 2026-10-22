const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('path');
const { probe, diagnose, buildErrorPage } = require('./diagnostics');

let mainWindow = null;
let tray = null;
let isQuitting = false;

const APP_URL = process.env.STARKLLM_URL || 'http://localhost:5173';
let pollInterval = null;

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
  createMainWindow();
  createTray();

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
    checkServicesAndLoad();
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
    if (url.startsWith('starkllm-retry:')) {
      event.preventDefault();
      retryConnection();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      // Allow standard close on Windows
      mainWindow = null;
    }
  });
}

function checkServicesAndLoad() {
  let attempts = 0;
  const maxAttempts = 60;
  let busy = false;

  clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    if (busy) return;
    busy = true;
    attempts++;

    const res = await probe(APP_URL);
    if (res.ok) {
      clearInterval(pollInterval);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(APP_URL);
      }
    } else if (attempts >= maxAttempts) {
      clearInterval(pollInterval);
      showEngineProblem();
    }
    busy = false;
  }, 1000);
}

async function showEngineProblem() {
  const diagnosis = await diagnose();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildErrorPage(diagnosis)));
  }
}

function retryConnection() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'splash.html'));
    checkServicesAndLoad();
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

    const contextMenu = Menu.buildFromTemplate([
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
        label: 'Quit StarkLLM',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('StarkLLM — Local AI Desktop');
    tray.setContextMenu(contextMenu);

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});
