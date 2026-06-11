'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const HORAS_URL = 'https://dash.weethub.com.br/horas';
// A janela PiP precisa da MESMA ORIGEM (compartilhar localStorage com /horas),
// mas sem carregar o app Next — senão o React sobrescreve a UI do timer.
// /sw.js é servido como texto puro: documento vazio na origem certa.
const PIP_URL = 'https://dash.weethub.com.br/sw.js?pip=1';

let mainWin = null;
let pipWin = null;

// ─── Main window ──────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 800,
    height: 900,
    minWidth: 600,
    minHeight: 700,
    title: 'Weethub Timesheet',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWin.loadURL(HORAS_URL);

  // After page loads: override documentPictureInPicture so the web app's
  // requestWindow() throws. Our preload timer monitor handles opening the
  // native Electron pip window instead.
  mainWin.webContents.on('did-finish-load', () => {
    mainWin.webContents.executeJavaScript(`
      (function () {
        try {
          Object.defineProperty(window, 'documentPictureInPicture', {
            value: {
              window: null,
              requestWindow: function () {
                return Promise.reject(new Error('electron-pip'));
              },
            },
            writable: true,
            configurable: true,
          });
        } catch (_) {}
      })();
    `).catch(() => {});
  });

  mainWin.on('closed', () => {
    mainWin = null;
    if (pipWin && !pipWin.isDestroyed()) pipWin.close();
  });
}

// ─── PiP window ───────────────────────────────────────────────────────────────

function createPipWindow() {
  if (pipWin && !pipWin.isDestroyed()) {
    pipWin.focus();
    return;
  }

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  pipWin = new BrowserWindow({
    width: 320,
    height: 180,
    x: sw - 340,
    y: sh - 200,
    resizable: false,
    alwaysOnTop: true,
    frame: false,
    skipTaskbar: true,
    title: 'Weethub Timer',
    webPreferences: {
      preload: path.join(__dirname, 'preload-pip.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  pipWin.loadURL(PIP_URL);

  pipWin.on('closed', () => {
    pipWin = null;
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('pip-closed');
    }
  });
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.on('open-pip', () => createPipWindow());

ipcMain.on('close-pip', () => {
  if (pipWin && !pipWin.isDestroyed()) pipWin.close();
});

// A lista de clientes precisa de mais altura — o PiP pede resize ao abrir/fechar
ipcMain.on('pip-resize', (_event, height) => {
  if (pipWin && !pipWin.isDestroyed()) {
    const h = Math.max(120, Math.min(480, Number(height) || 180));
    const [w] = pipWin.getSize();
    pipWin.setSize(w, h);
  }
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (!mainWin) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
