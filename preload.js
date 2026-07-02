'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const LS_KEY       = 'weethub_horas_timer';
const LS_IDLE_FLAG = 'weethub_idle_pause';

let lastSig      = null; // assinatura do timer ativo — reabre o PiP quando muda
let lastStateSig = null; // assinatura para detectar mudanças e atualizar o tray

contextBridge.exposeInMainWorld('electronAPI', {
  openPip:     () => ipcRenderer.send('open-pip'),
  closePip:    () => ipcRenderer.send('close-pip'),
  onPipClosed: (cb) => ipcRenderer.on('pip-closed', (_event) => cb()),
});

// ─── Audio ────────────────────────────────────────────────────────────────────

function playBeep(type) {
  try {
    const ctx = new AudioContext();
    // pause: dois tons descendentes  |  return: dois tons ascendentes
    const tones = type === 'pause'
      ? [{ t: 0, freq: 560 }, { t: 0.22, freq: 380 }]
      : [{ t: 0, freq: 440 }, { t: 0.22, freq: 660 }];

    for (const { t, freq } of tones) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + t);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + t + 0.16);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.16);
    }
    setTimeout(() => ctx.close(), 1500);
  } catch {}
}

// ─── Timer toggle (shortcut Ctrl+Shift+P / tray) ──────────────────────────────

ipcRenderer.on('shortcut-toggle', () => {
  try {
    const raw   = localStorage.getItem(LS_KEY);
    const state = raw ? JSON.parse(raw) : null;
    if (!state) return;

    if (state.isRunning) {
      const msTotais = state.accumulatedMs + (Date.now() - state.startedAt);
      localStorage.setItem(LS_KEY, JSON.stringify({
        ...state,
        isRunning: false,
        accumulatedMs: msTotais,
        pendingSave: true,
        saveAction: 'pausar',
        savedAt: Date.now(),
      }));
    } else {
      localStorage.setItem(LS_KEY, JSON.stringify({
        ...state,
        isRunning: true,
        startedAt: Date.now(),
        pendingSave: false,
      }));
    }
  } catch {}
});

// ─── Timer confirm (shortcut Ctrl+Shift+C / tray) ─────────────────────────────

ipcRenderer.on('shortcut-confirm', () => {
  try {
    const raw   = localStorage.getItem(LS_KEY);
    const state = raw ? JSON.parse(raw) : null;
    if (!state) return;

    const msTotais = state.isRunning
      ? state.accumulatedMs + (Date.now() - state.startedAt)
      : state.accumulatedMs;

    localStorage.setItem(LS_KEY, JSON.stringify({
      ...state,
      isRunning: false,
      accumulatedMs: msTotais,
      pendingSave: true,
      saveAction: 'finalizar',
      savedAt: Date.now(),
    }));
  } catch {}
});

// ─── Fechar o PiP = pausar o timer ─────────────────────────────────────────────
// Quando a janela PiP nativa é fechada com o timer rodando, o main envia
// 'pip-closed'. Escrevemos a flag de pausa (o hook useHorasTimer da janela
// principal grava o delta no banco). Não pausa se o timer já foi finalizado.

ipcRenderer.on('pip-closed', () => {
  try {
    const raw   = localStorage.getItem(LS_KEY);
    const state = raw ? JSON.parse(raw) : null;
    if (!state || !state.isRunning) return;

    const msTotais = state.accumulatedMs + (Date.now() - state.startedAt);
    localStorage.setItem(LS_KEY, JSON.stringify({
      ...state,
      isRunning: false,
      accumulatedMs: msTotais,
      lastHeartbeatAt: Date.now(),
      pendingSave: true,
      saveAction: 'pausar',
      savedAt: Date.now(),
    }));
  } catch {}
});

// ─── Idle auto-pause ──────────────────────────────────────────────────────────

ipcRenderer.on('idle-auto-pause', () => {
  try {
    const raw   = localStorage.getItem(LS_KEY);
    const state = raw ? JSON.parse(raw) : null;
    if (!state || !state.isRunning) return;

    const msTotais = state.accumulatedMs + (Date.now() - state.startedAt);
    localStorage.setItem(LS_KEY, JSON.stringify({
      ...state,
      isRunning: false,
      accumulatedMs: msTotais,
      pendingSave: true,
      saveAction: 'pausar',
      savedAt: Date.now(),
    }));
    // Marca a pausa como automática — exibe o dialog no retorno
    localStorage.setItem(LS_IDLE_FLAG, 'true');
    playBeep('pause');
  } catch {}
});

// ─── Idle return dialog ───────────────────────────────────────────────────────

ipcRenderer.on('idle-return', (_event, { idleMs }) => {
  try {
    const wasIdle = localStorage.getItem(LS_IDLE_FLAG) === 'true';
    if (!wasIdle) return;
    localStorage.removeItem(LS_IDLE_FLAG);

    const raw   = localStorage.getItem(LS_KEY);
    const state = raw ? JSON.parse(raw) : null;
    if (!state) return;

    playBeep('return');
    showIdleDialog(idleMs);
  } catch {}
});

function formatIdleTime(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function showIdleDialog(idleMs) {
  const existing = document.getElementById('__weethub_idle_dialog');
  if (existing) existing.remove();

  const idleStr = formatIdleTime(idleMs);

  const overlay = document.createElement('div');
  overlay.id = '__weethub_idle_dialog';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:999999',
    'background:rgba(0,0,0,0.55)', 'backdrop-filter:blur(4px)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  ].join(';');

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:28px 24px;width:320px;
                box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center;">
      <div style="font-size:36px;margin-bottom:14px;">⏸</div>
      <h3 style="margin:0 0 8px;font-size:16px;font-weight:700;color:#111;">
        Você ainda está neste projeto?
      </h3>
      <p style="margin:0 0 22px;font-size:13px;color:#666;line-height:1.6;">
        Timer pausado por inatividade.<br/>
        Ficou ausente por <strong>${idleStr}</strong>.
      </p>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button id="__idle_sim"
          style="padding:12px;border-radius:8px;border:none;cursor:pointer;
                 background:#2563EB;color:#fff;font-size:14px;font-weight:600;">
          Sim, estava trabalhando — incluir ${idleStr}
        </button>
        <button id="__idle_nao"
          style="padding:12px;border-radius:8px;border:none;cursor:pointer;
                 background:#F5F5F5;color:#374151;font-size:14px;font-weight:600;
                 border:1px solid #E5E7EB;">
          Não, retomar daqui em diante
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('__idle_sim').addEventListener('click', () => {
    try {
      const raw   = localStorage.getItem(LS_KEY);
      const state = raw ? JSON.parse(raw) : null;
      if (state) {
        localStorage.setItem(LS_KEY, JSON.stringify({
          ...state,
          isRunning: true,
          startedAt: Date.now(),
          accumulatedMs: state.accumulatedMs + idleMs,
          pendingSave: false,
        }));
      }
      ipcRenderer.send('show-notification', {
        title: 'Timer retomado',
        body:  `${idleStr} adicionados ao registro.`,
      });
    } catch {}
    overlay.remove();
  });

  document.getElementById('__idle_nao').addEventListener('click', () => {
    try {
      const raw   = localStorage.getItem(LS_KEY);
      const state = raw ? JSON.parse(raw) : null;
      if (state) {
        localStorage.setItem(LS_KEY, JSON.stringify({
          ...state,
          isRunning: true,
          startedAt: Date.now(),
          pendingSave: false,
        }));
      }
      ipcRenderer.send('show-notification', {
        title: 'Timer retomado',
        body:  'Retomando do ponto atual.',
      });
    } catch {}
    overlay.remove();
  });
}

// ─── Monitor de localStorage ──────────────────────────────────────────────────
// • Detecta timer iniciado → abre PiP automaticamente
// • Detecta mudanças de estado → atualiza tray via IPC

window.addEventListener('DOMContentLoaded', () => {
  setInterval(() => {
    try {
      const raw   = localStorage.getItem(LS_KEY);
      const state = raw ? JSON.parse(raw) : null;

      // Abre PiP quando o timer inicia ou troca de cliente
      if (state && state.isRunning) {
        const sig = `${state.clienteId}:${state.startedAt}`;
        if (sig !== lastSig) {
          lastSig = sig;
          ipcRenderer.send('open-pip');
        }
      } else if (!state) {
        lastSig = null;
      }

      // Atualiza tray quando o estado muda
      const stateSig = state
        ? `${state.isRunning}:${state.clienteId}:${state.accumulatedMs}`
        : null;
      if (stateSig !== lastStateSig) {
        lastStateSig = stateSig;
        ipcRenderer.send('timer-state-update', state);
      }
    } catch {}
  }, 500);
});
