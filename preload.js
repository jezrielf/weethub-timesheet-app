'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const LS_KEY = 'weethub_horas_timer';
// Assinatura do timer ativo (clienteId:startedAt). Abre o PiP quando muda:
// timer novo, troca de cliente, retomada — e também timer já rodando na
// abertura do app. Não reabre sozinho se o usuário fechou o PiP sem mexer
// no timer.
let lastSig = null;

contextBridge.exposeInMainWorld('electronAPI', {
  openPip: () => ipcRenderer.send('open-pip'),
  closePip: () => ipcRenderer.send('close-pip'),
  onPipClosed: (cb) => ipcRenderer.on('pip-closed', (_event) => cb()),
});

// Monitor localStorage for timer start → auto-open pip window
window.addEventListener('DOMContentLoaded', () => {
  setInterval(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const state = raw ? JSON.parse(raw) : null;
      if (state && state.isRunning) {
        const sig = `${state.clienteId}:${state.startedAt}`;
        if (sig !== lastSig) {
          lastSig = sig;
          ipcRenderer.send('open-pip');
        }
      } else if (!state) {
        lastSig = null;
      }
    } catch {
      // ignore
    }
  }, 500);
});
