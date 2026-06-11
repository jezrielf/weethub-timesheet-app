'use strict';

const { ipcRenderer } = require('electron');

const LS_KEY = 'weethub_horas_timer';
const LS_CLIENTES_KEY = 'weethub_horas_clientes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatMs(ms) {
  const safe = Math.max(0, ms);
  const h = Math.floor(safe / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = Math.floor((safe % 60_000) / 1_000);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function readState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function getElapsed(state) {
  if (!state) return 0;
  if (!state.isRunning) return state.accumulatedMs;
  return state.accumulatedMs + (Date.now() - state.startedAt);
}

function readClientes() {
  try {
    const raw = localStorage.getItem(LS_CLIENTES_KEY);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
// Escrevem flags no localStorage — o hook useHorasTimer na janela principal
// faz o polling (500ms) e processa os saves no Supabase.

function doToggle() {
  const state = readState();
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
  updatePip();
}

function doFinalizar() {
  if (closing) return;

  const state = readState();
  if (state) {
    closing = true;
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
    if (statusEl) statusEl.textContent = 'Salvando...';
    if (toggleBtn) toggleBtn.disabled = true;
    if (confirmBtn) confirmBtn.disabled = true;
    // 800ms dá tempo do hook da janela principal processar o pendingSave
    setTimeout(() => ipcRenderer.send('close-pip'), 800);
  } else {
    ipcRenderer.send('close-pip');
  }
}

// ─── Trocar cliente ───────────────────────────────────────────────────────────
// Mesma semântica do pipSelectCliente da web: salva o cliente anterior via
// flag pendingSave/trocar (processada pelo hook da janela principal) e
// inicia um timer zerado para o novo cliente.

function doSelectCliente(id, nome, servico) {
  const state = readState();
  const msTotais = state
    ? (state.isRunning
        ? state.accumulatedMs + (Date.now() - state.startedAt)
        : state.accumulatedMs)
    : 0;

  const novoState = {
    isRunning: true,
    clienteId: id,
    clienteNome: nome,
    clienteServico: servico,
    colaboradorId: state?.colaboradorId ?? '',
    startedAt: Date.now(),
    accumulatedMs: 0,
  };

  if (state && state.clienteId !== id && msTotais >= 10_000) {
    localStorage.setItem(LS_KEY, JSON.stringify({
      ...state,
      isRunning: false,
      accumulatedMs: msTotais,
      pendingSave: true,
      saveAction: 'trocar',
      savedAt: Date.now(),
    }));
    // Esperar o hook da janela principal processar o save (limpa pendingSave)
    // antes de iniciar o novo timer — evita que o cleanState do hook
    // sobrescreva o timer novo. Timeout de 3s como fallback.
    const t0 = Date.now();
    const waiter = setInterval(() => {
      const cur = readState();
      const processed = !cur || cur.pendingSave !== true;
      if (processed || Date.now() - t0 > 3000) {
        clearInterval(waiter);
        novoState.startedAt = Date.now();
        localStorage.setItem(LS_KEY, JSON.stringify(novoState));
        updatePip();
      }
    }, 100);
  } else {
    localStorage.setItem(LS_KEY, JSON.stringify(novoState));
  }

  closeList();
  updatePip();
}

// ─── DOM refs / estado ────────────────────────────────────────────────────────

let headerText, timerDisplay, dotEl, toggleBtn, confirmBtn, statusEl;
let trocarBtn, listWrap, searchInput, listEl;
let listOpen = false;
let initialized = false;
let closing = false;
let sawState = false;

// ─── Lista de clientes ────────────────────────────────────────────────────────

function renderList() {
  const q = (searchInput.value || '').toLowerCase();
  const clientes = readClientes();
  listEl.innerHTML = '';

  if (clientes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'Lista indisponível — abra a etapa de clientes no formulário';
    listEl.appendChild(empty);
    return;
  }

  const filtered = q
    ? clientes.filter((c) => (c.nome || '').toLowerCase().includes(q))
    : clientes;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'Nenhum cliente encontrado';
    listEl.appendChild(empty);
    return;
  }

  for (const c of filtered.slice(0, 50)) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.textContent = c.nome;
    const svc = document.createElement('span');
    svc.textContent = ` · ${c.servico ?? ''}`;
    svc.style.color = '#9B9B9B';
    item.appendChild(svc);
    item.addEventListener('click', () => doSelectCliente(c.id, c.nome, c.servico ?? ''));
    listEl.appendChild(item);
  }
}

function openList() {
  listOpen = true;
  listWrap.style.display = 'flex';
  searchInput.value = '';
  renderList();
  ipcRenderer.send('pip-resize', 380);
  setTimeout(() => searchInput.focus(), 50);
}

function closeList() {
  listOpen = false;
  listWrap.style.display = 'none';
  ipcRenderer.send('pip-resize', 180);
}

// ─── Update loop ──────────────────────────────────────────────────────────────

function updatePip() {
  if (!initialized || closing) return;
  const state = readState();

  if (!state) {
    // Timer cancelado/finalizado pela janela principal → fechar o PiP
    if (sawState) {
      closing = true;
      ipcRenderer.send('close-pip');
      return;
    }
    headerText.textContent = 'Weethub Timer';
    timerDisplay.textContent = '00:00:00';
    statusEl.textContent = 'Nenhum timer ativo';
    dotEl.style.background = '#9B9B9B';
    dotEl.style.animation = 'none';
    toggleBtn.disabled = true;
    confirmBtn.disabled = true;
    return;
  }

  sawState = true;
  toggleBtn.disabled = false;
  confirmBtn.disabled = false;

  headerText.textContent = (state.clienteNome || 'Timer').slice(0, 26);
  timerDisplay.textContent = formatMs(getElapsed(state));
  statusEl.textContent = state.isRunning
    ? 'Em andamento'
    : (state.pendingSave ? 'Pausado · salvando...' : 'Pausado');
  dotEl.style.background = state.isRunning ? '#16A34A' : '#D97706';
  dotEl.style.animation = state.isRunning ? 'pulse 1.5s infinite' : 'none';
  toggleBtn.textContent = state.isRunning ? '⏸ Pausar' : '▶ Retomar';
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function initPipUI() {
  // Documento /sw.js é texto puro (sem React) — substituir todo o conteúdo
  document.documentElement.innerHTML = '<head></head><body></body>';

  const style = document.createElement('style');
  style.textContent = `
    * { margin:0; padding:0; box-sizing:border-box;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    html, body { width:100%; height:100%; overflow:hidden; background:#fff; }
    body { display:flex; flex-direction:column; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    button { cursor:pointer; border:none; border-radius:7px;
             font-size:13px; font-weight:600; padding:8px 0; }
    button:disabled { opacity:.45; cursor:default; }
    button:not(:disabled):hover { filter:brightness(.92); }
    #hdr { display:flex; align-items:center; gap:6px; padding:6px 10px;
           background:#0F1117; color:#fff; font-size:11px; font-weight:600;
           -webkit-app-region:drag; user-select:none; flex-shrink:0; }
    #hdr-text { flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    #close { -webkit-app-region:no-drag; background:none; color:#9B9B9B;
             font-size:17px; line-height:1; padding:0 2px; }
    #close:hover { color:#fff; }
    #mid { flex:1; display:flex; flex-direction:column;
           align-items:center; justify-content:center; gap:2px; }
    #timer-row { display:flex; align-items:center; gap:8px; }
    #dot { width:8px; height:8px; border-radius:50%; background:#9B9B9B; }
    #timer { font-family:'Courier New',monospace; font-size:30px;
             font-weight:700; color:#191919; letter-spacing:2px; }
    #status { font-size:10px; color:#9B9B9B; }
    #btns { display:flex; gap:8px; padding:0 10px 10px; flex-shrink:0; }
    #toggle { flex:1; background:#2563EB; color:#fff; }
    #confirm { flex:1; background:#16A34A; color:#fff; }
    #trocar { width:42px; background:#F5F5F5; color:#191919;
              border:1px solid #E8E8E8; flex-shrink:0; }
    #list-wrap { display:none; flex-direction:column; flex:1; min-height:0;
                 border-top:1px solid #E8E8E8; }
    #search { border:none; border-bottom:1px solid #E8E8E8; padding:7px 10px;
              font-size:12px; outline:none; flex-shrink:0; width:100%; }
    #list { flex:1; overflow-y:auto; min-height:0; }
    .list-item { padding:7px 10px; font-size:12px; cursor:pointer;
                 border-bottom:1px solid #F5F5F5; white-space:nowrap;
                 overflow:hidden; text-overflow:ellipsis; }
    .list-item:hover { background:#F5F5F5; }
    .list-empty { padding:10px; font-size:11px; color:#9B9B9B; }
  `;
  document.head.appendChild(style);

  document.body.innerHTML = `
    <div id="hdr">
      <span>⏱</span>
      <span id="hdr-text">Weethub Timer</span>
      <button id="close" title="Fechar PiP">×</button>
    </div>
    <div id="mid">
      <div id="timer-row">
        <div id="dot"></div>
        <div id="timer">00:00:00</div>
      </div>
      <div id="status"></div>
    </div>
    <div id="btns">
      <button id="toggle">⏸ Pausar</button>
      <button id="confirm">✓ Confirmar</button>
      <button id="trocar" title="Trocar cliente">↔</button>
    </div>
    <div id="list-wrap">
      <input id="search" placeholder="Buscar cliente…" />
      <div id="list"></div>
    </div>
  `;

  headerText = document.getElementById('hdr-text');
  timerDisplay = document.getElementById('timer');
  dotEl = document.getElementById('dot');
  statusEl = document.getElementById('status');
  toggleBtn = document.getElementById('toggle');
  confirmBtn = document.getElementById('confirm');
  trocarBtn = document.getElementById('trocar');
  listWrap = document.getElementById('list-wrap');
  searchInput = document.getElementById('search');
  listEl = document.getElementById('list');

  toggleBtn.addEventListener('click', doToggle);
  confirmBtn.addEventListener('click', doFinalizar);
  trocarBtn.addEventListener('click', () => (listOpen ? closeList() : openList()));
  searchInput.addEventListener('input', renderList);
  document.getElementById('close')
    .addEventListener('click', () => ipcRenderer.send('close-pip'));

  initialized = true;
  updatePip();
  setInterval(updatePip, 500);
}

window.addEventListener('DOMContentLoaded', initPipUI);
