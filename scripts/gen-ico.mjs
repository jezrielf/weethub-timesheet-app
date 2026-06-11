/**
 * Gera assets/icon.ico (PNG-in-ICO, válido no Windows Vista+) e copia icon.png
 * a partir de public/icons/icon-512.png do dashboard.
 *
 * Uso: node scripts/gen-ico.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const dashboardIcons = resolve(__dir, '../../weethub-dashboard/public/icons');

mkdirSync(join(root, 'assets'), { recursive: true });

// 1 — Copy icon.png (512x512)
const src512 = join(dashboardIcons, 'icon-512.png');
const dst512 = join(root, 'assets', 'icon.png');
copyFileSync(src512, dst512);
console.log('Copied icon.png');

// 2 — Generate icon.ico using PNG-in-ICO format
//   ICO = ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + raw PNG bytes
//   Width/Height = 0 means 256 in ICO spec; for 512x512 PNGs Windows still
//   accepts it as a valid large-format ICO.

const pngData = readFileSync(src512);
const pngSize = pngData.length;
const imageOffset = 6 + 16; // ICONDIR + one ICONDIRENTRY

const buf = Buffer.alloc(imageOffset + pngSize);
let pos = 0;

// ICONDIR
buf.writeUInt16LE(0, pos); pos += 2;       // reserved
buf.writeUInt16LE(1, pos); pos += 2;       // type = 1 (ICO)
buf.writeUInt16LE(1, pos); pos += 2;       // image count = 1

// ICONDIRENTRY
buf.writeUInt8(0, pos); pos += 1;          // width  (0 = 256+)
buf.writeUInt8(0, pos); pos += 1;          // height (0 = 256+)
buf.writeUInt8(0, pos); pos += 1;          // color count
buf.writeUInt8(0, pos); pos += 1;          // reserved
buf.writeUInt16LE(1, pos); pos += 2;       // color planes
buf.writeUInt16LE(32, pos); pos += 2;      // bits per pixel
buf.writeUInt32LE(pngSize, pos); pos += 4; // size of image data
buf.writeUInt32LE(imageOffset, pos); pos += 4; // offset of image data

// PNG payload
pngData.copy(buf, pos);

const dstIco = join(root, 'assets', 'icon.ico');
writeFileSync(dstIco, buf);
console.log(`Generated icon.ico (${buf.length} bytes)`);
