/**
 * Gera os ícones PNG 20×20 para os botões da thumbnail toolbar do Windows.
 * Execute com:  node scripts/gen-toolbar-icons.mjs
 */
import { writeFileSync } from 'fs';
import { deflateSync }   from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets');
const W = 20, H = 20;

// ─── PNG helpers ──────────────────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
  const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function buildPng(rgba) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.allocUnsafe(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: None
    for (let x = 0; x < W; x++) {
      const src = (y * W + x) * 4;
      const dst = y * (1 + W * 4) + 1 + x * 4;
      raw[dst] = rgba[src]; raw[dst+1] = rgba[src+1];
      raw[dst+2] = rgba[src+2]; raw[dst+3] = rgba[src+3];
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ─── Icon drawing ─────────────────────────────────────────────────────────────

const W_  = [255, 255, 255, 255]; // branco
const BG_ = [0,   0,   0,   0  ]; // transparente

function makeIcon(fn) {
  const buf = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      const i = (y * W + x) * 4;
      buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = a;
    }
  return buf;
}

// ▶ Play — triângulo apontando para a direita
const playIcon = makeIcon((x, y) => {
  const inside = x >= 5 && x <= 16
    && y >= 3 + (x - 5) * 7 / 11
    && y <= 17 - (x - 5) * 7 / 11;
  return inside ? W_ : BG_;
});

// ⏸ Pause — duas barras verticais
const pauseIcon = makeIcon((x, y) =>
  y >= 4 && y <= 16 && ((x >= 5 && x <= 8) || (x >= 11 && x <= 14))
    ? W_ : BG_
);

// ✓ Confirm — checkmark
const confirmIcon = makeIcon((x, y) => {
  const onLeft  = x >= 4  && x <= 7  && Math.abs(y - (12 + (x - 4))) <= 1.3;
  const onRight = x >= 7  && x <= 16 && Math.abs(y - (15 - (x - 7))) <= 1.3;
  return onLeft || onRight ? W_ : BG_;
});

// ─── Save ─────────────────────────────────────────────────────────────────────

for (const [name, rgba] of [
  ['toolbar-play',    playIcon],
  ['toolbar-pause',   pauseIcon],
  ['toolbar-confirm', confirmIcon],
]) {
  const p = join(ASSETS, `${name}.png`);
  writeFileSync(p, buildPng(rgba));
  console.log(`Gerado: ${name}.png`);
}
