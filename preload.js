'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const LS_KEY = 'weethub_horas_timer';
const LS_IDLE_FLAG = 'weethub_idle_pause';

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

// ─── Audio ────────────────────────────────────────────────────────────────────

function playBeep(type) {
  try {
    const ctx = new AudioContext();
    const tones = type === 'pause'
      // Dois tons descendentes — sinaliza pausa
      ? [{ t: 0, freq: 560 }, { t: 0.22, freq: 380 }]
      // Dois tons ascendentes — chama atenção ao retorno
      : [{ t: 0, freq: 440 }, { t: 0.22, freq: 660 }];

    for (const { t, freq } of tones) {
      const osc = ctx.createOscillator();
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

// ─── Idle auto-pause ──────────────────────────────────────────────────────────

ipcRenderer.on('idle-auto-pause', () => {
  try {
    const raw = localStorage.getItem(LS_KEY);
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
    // Marca que a pausa foi automática — usado no retorno para exibir o dialog
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

    const raw = localStorage.getItem(LS_KEY);
    const state = raw ? JSON.parse(raw) : null;
    if (!state) return;

    playBeep('return');
    showIdleDialog(idleMs, state);
  } catch {}
});

function formatIdleTime(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function showIdleDialog(idleMs, pausedState) {
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
      const raw = localStorage.getItem(LS_KEY);
      const state = raw ? JSON.parse(raw) : null;
      if (state) {
        localStorage.setItem(LS_KEY, JSON.stringify({
          ...state,
          isRunning: true,
          startedAt: Date.now(),
          // Adiciona o tempo ausente ao acumulado
          accumulatedMs: state.accumulatedMs + idleMs,
          pendingSave: false,
        }));
      }
    } catch {}
    overlay.remove();
  });

  document.getElementById('__idle_nao').addEventListener('click', () => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const state = raw ? JSON.parse(raw) : null;
      if (state) {
        localStorage.setItem(LS_KEY, JSON.stringify({
          ...state,
          isRunning: true,
          startedAt: Date.now(),
          pendingSave: false,
        }));
      }
    } catch {}
    overlay.remove();
  });
}

// ─── Monitor localStorage for timer start → auto-open pip window ─────────────

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
