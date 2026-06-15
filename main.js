'use strict';

const {
  app, BrowserWindow, ipcMain, screen,
  powerMonitor, Tray, Menu, Notification, globalShortcut,
} = require('electron');
const path = require('path');

// electron-updater é opcional — não quebra o app se não estiver instalado ainda
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch {}

// Deve ser definido antes de app.whenReady para notificações funcionarem no Windows
app.setAppUserModelId('com.weethub.timesheet');

const HORAS_URL        = 'https://dash.weethub.com.br/horas';
const PIP_URL          = 'https://dash.weethub.com.br/sw.js?pip=1';
const IDLE_THRESHOLD_S = 5 * 60; // 5 minutos

let mainWin  = null;
let pipWin   = null;
let tray     = null;
let quitting = false;

let timerState   = null; // último estado recebido do preload via IPC
let autoPausedAt = null; // não-nulo → auto-pause ativo (idle ou suspend)
let suspendedAt  = null; // não-nulo → sistema em suspend

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function formatMs(ms) {
  const s = Math.max(0, ms);
  const h   = Math.floor(s / 3_600_000);
  const m   = Math.floor((s % 3_600_000) / 60_000);
  const sec = Math.floor((s % 60_000) / 1_000);
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.ico') }).show();
  }
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function buildTrayMenu() {
  const s = timerState;
  const items = [];

  if (s && s.isRunning) {
    const elapsed = s.accumulatedMs + (Date.now() - s.startedAt);
    items.push(
      { label: `⏱  ${formatMs(elapsed)}  ·  ${(s.clienteNome || '').slice(0, 24)}`, enabled: false },
      { type: 'separator' },
      { label: '⏸  Pausar          Ctrl+Shift+P', click: () => mainWin?.webContents.send('shortcut-toggle')  },
      { label: '✓  Confirmar      Ctrl+Shift+C',  click: () => mainWin?.webContents.send('shortcut-confirm') },
    );
  } else if (s && !s.isRunning) {
    items.push(
      { label: `⏸  ${formatMs(s.accumulatedMs)}  ·  ${(s.clienteNome || '').slice(0, 24)}`, enabled: false },
      { type: 'separator' },
      { label: '▶  Retomar        Ctrl+Shift+P',  click: () => mainWin?.webContents.send('shortcut-toggle')  },
      { label: '✓  Confirmar      Ctrl+Shift+C',  click: () => mainWin?.webContents.send('shortcut-confirm') },
    );
  } else {
    items.push({ label: 'Nenhum timer ativo', enabled: false });
  }

  items.push(
    { type: 'separator' },
    { label: 'Abrir Weethub Timesheet', click: () => { mainWin?.show(); mainWin?.focus(); } },
    { type: 'separator' },
    { label: 'Fechar', click: () => { quitting = true; app.quit(); } },
  );

  return Menu.buildFromTemplate(items);
}

function updateTrayTooltip() {
  if (!tray || tray.isDestroyed()) return;
  const s = timerState;
  if (s && s.isRunning) {
    const elapsed = s.accumulatedMs + (Date.now() - s.startedAt);
    tray.setToolTip(`⏱ ${formatMs(elapsed)} · ${(s.clienteNome || '').slice(0, 28)}`);
  } else if (s && !s.isRunning) {
    tray.setToolTip(`⏸ Pausado · ${(s.clienteNome || '').slice(0, 28)}`);
  } else {
    tray.setToolTip('Weethub Timesheet');
  }
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
  tray.setToolTip('Weethub Timesheet');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => { mainWin?.show(); mainWin?.focus(); });
  // Atualiza o tempo exibido no tooltip a cada segundo
  setInterval(updateTrayTooltip, 1000);
}

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

  // Evita throttle do hook useHorasTimer quando a janela está em segundo plano
  mainWin.webContents.setBackgroundThrottling(false);
  mainWin.loadURL(HORAS_URL);

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

  // Com tray: fechar esconde a janela em vez de sair do app
  mainWin.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWin.hide();
    }
  });

  mainWin.on('closed', () => {
    mainWin = null;
    if (pipWin && !pipWin.isDestroyed()) pipWin.close();
  });
}

// ─── PiP window ───────────────────────────────────────────────────────────────

function createPipWindow() {
  if (pipWin && !pipWin.isDestroyed()) { pipWin.focus(); return; }
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
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('pip-closed');
  });
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.on('open-pip',  () => createPipWindow());
ipcMain.on('close-pip', () => { if (pipWin && !pipWin.isDestroyed()) pipWin.close(); });

ipcMain.on('pip-resize', (_event, height) => {
  if (pipWin && !pipWin.isDestroyed()) {
    const h = Math.max(120, Math.min(480, Number(height) || 180));
    const [w] = pipWin.getSize();
    pipWin.setSize(w, h);
  }
});

// Estado do timer enviado pelo preload — mantém o tray sincronizado
ipcMain.on('timer-state-update', (_event, state) => {
  timerState = state;
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
});

// Notificação solicitada pelo preload (ex: dialog de retorno respondido)
ipcMain.on('show-notification', (_event, { title, body }) => notify(title, body));

// ─── Idle + suspend detection ─────────────────────────────────────────────────

function triggerAutoPause() {
  if (autoPausedAt) return; // já pausado
  autoPausedAt = Date.now();
  mainWin?.webContents.send('idle-auto-pause');
  notify('Weethub Timesheet', 'Timer pausado por inatividade.');
}

function triggerReturn() {
  if (!autoPausedAt) return;
  const idleMs = Date.now() - autoPausedAt;
  autoPausedAt = null;
  mainWin?.webContents.send('idle-return', { idleMs });
}

function startIdleMonitor() {
  // Idle por falta de input (mouse/teclado)
  setInterval(() => {
    if (!mainWin || mainWin.isDestroyed()) return;
    const idleSec = powerMonitor.getSystemIdleTime();
    if (!autoPausedAt && !suspendedAt && idleSec >= IDLE_THRESHOLD_S) {
      triggerAutoPause();
    } else if (autoPausedAt && !suspendedAt && idleSec < 10) {
      triggerReturn();
    }
  }, 10_000);

  // Suspensão do sistema (fechar tampa, bloquear tela, modo sleep)
  powerMonitor.on('suspend', () => {
    suspendedAt = Date.now();
    triggerAutoPause();
  });

  powerMonitor.on('resume', () => {
    suspendedAt = null;
    triggerReturn();
  });
}

// ─── Global shortcuts ─────────────────────────────────────────────────────────

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    mainWin?.webContents.send('shortcut-toggle');
  });
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    mainWin?.webContents.send('shortcut-confirm');
  });
}

// ─── Auto updater ─────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload        = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', ({ version }) => {
    notify('Weethub Timesheet', `Versão ${version} disponível — baixando em segundo plano...`);
  });
  autoUpdater.on('update-downloaded', () => {
    notify('Weethub Timesheet', 'Atualização pronta! Será instalada ao fechar o app.');
  });
  autoUpdater.on('error', () => {}); // erros silenciosos (sem conexão, repo privado, etc.)
  autoUpdater.checkForUpdates().catch(() => {});
  // Re-verifica a cada 2 horas
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 2 * 60 * 60 * 1000);
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('before-quit', () => { quitting = true; });
app.on('will-quit',   () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  startIdleMonitor();
  registerShortcuts();
  setupAutoUpdater();
  app.on('activate', () => { mainWin ? mainWin.show() : createMainWindow(); });
});

// Com tray o app não fecha quando a janela some — só quando quitting=true
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && quitting) app.quit();
});
