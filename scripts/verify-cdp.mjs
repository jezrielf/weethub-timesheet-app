/**
 * Verificação automatizada via Chrome DevTools Protocol.
 * Dirige o app Electron rodando com --remote-debugging-port=9222.
 *
 * Uso: node scripts/verify-cdp.mjs
 */

const CDP_BASE = 'http://127.0.0.1:9222';
const LS_KEY = 'weethub_horas_timer';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listTargets() {
  const res = await fetch(`${CDP_BASE}/json/list`);
  return res.json();
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('ws error'));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error('Eval exception: ' + JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text));
    }
    return res.result?.result?.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function connectTo(predicate, label, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await listTargets().catch(() => []);
    const t = targets.find(predicate);
    if (t) {
      const c = new CdpClient(t.webSocketDebuggerUrl);
      await c.connect();
      console.log(`[ok] conectado: ${label} (${t.url})`);
      return c;
    }
    await sleep(500);
  }
  throw new Error(`target não encontrado: ${label}`);
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const main = await connectTo(
  (t) => t.type === 'page' && t.url.includes('/horas'),
  'janela principal',
);

await sleep(3000);

// snapshot do estado real para restaurar no fim (não destruir timer do usuário)
const realState = await main.eval(`localStorage.getItem('${LS_KEY}')`);
if (realState) console.log('[info] timer real presente — será restaurado no fim');
const realClientes = await main.eval(`localStorage.getItem('weethub_horas_clientes')`);

// 1 — janela principal carregou o /horas
const title = await main.eval('document.title');
check('Janela principal carrega /horas', title.includes('Timesheet'), `title="${title}"`);

// 2 — electronAPI exposto
const hasApi = await main.eval('typeof window.electronAPI?.openPip === "function"');
check('electronAPI exposto via contextBridge', hasApi === true);

// 3 — documentPictureInPicture sobrescrito (deve rejeitar)
const pipOverride = await main.eval(`
  window.documentPictureInPicture.requestWindow()
    .then(() => 'resolved')
    .catch((e) => 'rejected:' + e.message)
`);
check('Document PiP nativo bloqueado', pipOverride === 'rejected:electron-pip', pipOverride);

// 4 — sessão persistida (informativo)
const session = await main.eval('localStorage.getItem("weethub_horas_session")');
console.log(`[info] sessão /horas: ${session ? 'presente' : 'ausente'}`);

// 5 — simular início de timer (mesmo formato que iniciarTimer escreve)
await main.eval(`
  localStorage.setItem('${LS_KEY}', JSON.stringify({
    isRunning: true,
    colaboradorId: 'teste-cdp-colab',
    clienteId: 'teste-cdp-cliente',
    clienteNome: 'Cliente Teste CDP',
    clienteServico: 'Teste',
    startedAt: Date.now(),
    accumulatedMs: 0,
  }));
  'written'
`);
console.log('[info] timer simulado escrito no localStorage');

// 6 — preload detecta isRunning e abre a janela pip (~500ms de poll)
await sleep(2500);
let pip;
try {
  pip = await connectTo(
    (t) => t.type === 'page' && t.url.includes('pip=1'),
    'janela PiP',
    8000,
  );
  check('Janela PiP abre automaticamente ao iniciar timer', true);
} catch (e) {
  check('Janela PiP abre automaticamente ao iniciar timer', false, e.message);
  await main.eval(`localStorage.removeItem('${LS_KEY}'); 'cleaned'`);
  process.exit(1);
}

await sleep(2500);

// 7 — PiP mostra nome do cliente e timer correndo
const pipHeader = await pip.eval('document.getElementById("hdr-text")?.textContent ?? null');
check('PiP exibe nome do cliente', pipHeader === 'Cliente Teste CDP', `hdr="${pipHeader}"`);

const pipTimer = await pip.eval('document.getElementById("timer")?.textContent ?? null');
check(
  'PiP exibe timer correndo (hh:mm:ss > 0)',
  /^\d{2}:\d{2}:\d{2}$/.test(pipTimer ?? '') && pipTimer !== '00:00:00',
  `timer="${pipTimer}"`,
);

// 8 — pausar via botão do PiP
await pip.eval(`document.getElementById('toggle').click(); 'clicked'`);
await sleep(1500);
const stateAfterPause = await main.eval(`JSON.parse(localStorage.getItem('${LS_KEY}') ?? 'null')`);
check(
  'Pausar no PiP reflete no estado compartilhado',
  stateAfterPause !== null && stateAfterPause.isRunning === false,
  `isRunning=${stateAfterPause?.isRunning}`,
);

// 8b — janela principal (React) refletiu a pausa
const mainShowsPaused = await pip.eval(`document.getElementById('toggle').textContent`);
check('Botão do PiP vira Retomar após pausa', mainShowsPaused.includes('Retomar'), mainShowsPaused);

// 9 — retomar
await pip.eval(`document.getElementById('toggle').click(); 'clicked'`);
await sleep(1500);
const stateAfterResume = await main.eval(`JSON.parse(localStorage.getItem('${LS_KEY}') ?? 'null')`);
check(
  'Retomar no PiP reflete no estado compartilhado',
  stateAfterResume !== null && stateAfterResume.isRunning === true,
  `isRunning=${stateAfterResume?.isRunning}`,
);

// 9b — trocar cliente: abrir lista, buscar, selecionar
await main.eval(`
  localStorage.setItem('weethub_horas_clientes', JSON.stringify([
    { id: 'cli-a', nome: 'Alpha Ltda', servico: 'E-commerce' },
    { id: 'cli-b', nome: 'Beta Corp', servico: 'Suporte' },
    { id: 'cli-c', nome: 'Gamma SA', servico: 'Marketing' },
  ]));
  'written'
`);
await pip.eval(`document.getElementById('trocar').click(); 'clicked'`);
await sleep(600);

const listVisible = await pip.eval(`document.getElementById('list-wrap').style.display`);
const listCount = await pip.eval(`document.querySelectorAll('.list-item').length`);
check('Botão ↔ abre lista de clientes', listVisible === 'flex' && listCount === 3, `display=${listVisible}, itens=${listCount}`);

const pipHeight = await pip.eval('window.outerHeight');
check('Janela PiP expande para a lista', pipHeight > 200, `height=${pipHeight}`);

await pip.eval(`
  const inp = document.getElementById('search');
  inp.value = 'beta';
  inp.dispatchEvent(new Event('input'));
  'typed'
`);
await sleep(300);
const filteredCount = await pip.eval(`document.querySelectorAll('.list-item').length`);
check('Busca filtra a lista', filteredCount === 1, `itens=${filteredCount}`);

await pip.eval(`document.querySelector('.list-item').click(); 'clicked'`);
await sleep(3500); // aguarda save do anterior (pendingSave/trocar) + novo timer

const stateAfterTroca = await main.eval(`JSON.parse(localStorage.getItem('${LS_KEY}') ?? 'null')`);
check(
  'Selecionar cliente troca o timer',
  stateAfterTroca?.clienteId === 'cli-b' && stateAfterTroca?.isRunning === true,
  `clienteId=${stateAfterTroca?.clienteId}, isRunning=${stateAfterTroca?.isRunning}`,
);

const listClosedAfter = await pip.eval(`document.getElementById('list-wrap').style.display`);
const pipHeaderTroca = await pip.eval(`document.getElementById('hdr-text').textContent`);
check('Lista fecha e header mostra novo cliente', listClosedAfter === 'none' && pipHeaderTroca === 'Beta Corp', `hdr="${pipHeaderTroca}"`);

// 10 — confirmar (finalizar): escreve pendingSave=finalizar; hook da janela
// principal processa (cliente fake → erro no Supabase é esperado, mas o
// fluxo de finalizar limpa o storage de qualquer forma)
await pip.eval(`document.getElementById('confirm').click(); 'clicked'`);
await sleep(300);
const stateAfterConfirm = await main.eval(`JSON.parse(localStorage.getItem('${LS_KEY}') ?? 'null')`);
check(
  'Confirmar escreve pendingSave=finalizar (ou já processado)',
  stateAfterConfirm === null ||
    (stateAfterConfirm.pendingSave === true && stateAfterConfirm.saveAction === 'finalizar'),
  stateAfterConfirm ? `saveAction=${stateAfterConfirm.saveAction}` : 'já limpo',
);

// 11 — hook da janela principal processa o finalizar e limpa o storage
await sleep(2000);
const stateProcessed = await main.eval(`localStorage.getItem('${LS_KEY}')`);
check('Janela principal processa o finalizar (storage limpo)', stateProcessed === null);

// 12 — PiP fecha após confirmar
const targetsAfter = await listTargets();
const pipStillOpen = targetsAfter.some((t) => t.url.includes('pip=1'));
check('Janela PiP fecha após confirmar', !pipStillOpen);

// restaurar estado real, se havia (sem estado real: garantir storage limpo)
if (realState) {
  await main.eval(`localStorage.setItem('${LS_KEY}', ${JSON.stringify(realState)}); 'restored'`);
  console.log('[info] timer real restaurado');
} else {
  await main.eval(`localStorage.removeItem('${LS_KEY}'); 'cleaned'`);
}
if (realClientes) {
  await main.eval(`localStorage.setItem('weethub_horas_clientes', ${JSON.stringify(realClientes)}); 'restored'`);
} else {
  await main.eval(`localStorage.removeItem('weethub_horas_clientes'); 'cleaned'`);
}

main.close();
pip?.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passaram`);
process.exit(failed.length > 0 ? 1 : 0);
