# Weethub Timesheet (Electron)

App Windows instalável que empacota o [/horas](https://dash.weethub.com.br/horas) com duas janelas:

- **Janela principal** (800×900): o formulário completo do `/horas`, com sessão persistida entre aberturas (localStorage no userData do Electron).
- **Janela PiP** (320×180, sempre por cima, sem moldura): timer flutuante com Pausar/Retomar, Confirmar (salva as horas) e Fechar.

## Como funciona

O `/horas` usa `localStorage["weethub_horas_timer"]` como fonte de verdade do timer, e o hook `useHorasTimer` da janela principal processa flags `pendingSave` (polling de 500ms) para gravar no Supabase.

- `main.js` — cria as janelas; sobrescreve `documentPictureInPicture` na página para bloquear o Document PiP do navegador.
- `preload.js` — monitora o localStorage; quando um timer inicia (`isRunning: true`), pede ao processo principal para abrir a janela PiP (IPC `open-pip`). Expõe `window.electronAPI.openPip/closePip/onPipClosed`.
- `preload-pip.js` — a janela PiP carrega `/sw.js?pip=1` (mesma origem → mesmo localStorage, sem React) e o preload constrói a UI do timer, lendo/escrevendo o mesmo estado que a janela principal processa.

## Desenvolvimento

```bash
npm install
npm start
```

## Build do instalador

```bash
npm run build
```

Gera `dist/Weethub Timesheet Setup 1.0.0.exe` (NSIS, com atalhos de desktop e menu iniciar).

## Verificação automatizada

Com o app rodando com `--remote-debugging-port=9222`:

```bash
node scripts/verify-cdp.mjs
```

Dirige o app via Chrome DevTools Protocol e valida: carga do /horas, bloqueio do PiP nativo, abertura automática da janela PiP, sincronização pausar/retomar/confirmar e fechamento do PiP.

## Ícones

`npm run gen-assets` copia/gera `assets/icon.png` e `assets/icon.ico` a partir de `../weethub-dashboard/public/icons/icon-512.png`.
