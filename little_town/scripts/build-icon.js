// Town Inbox — generate the app icon (a cute house) as PNG + ICO.
//
// Stdlib-only: no canvas / sharp / cairo dependency. We composite
// the icon ourselves into an RGBA buffer, then emit a PNG (zlib +
// CRC) and an ICO file (icon directory + 256×256 PNG payload, which
// modern Windows accepts as an icon entry).
//
// Output:
//   build/icon.png — used by electron-packager's --icon on mac/linux
//                    and as the BrowserWindow icon
//   build/icon.ico — used by electron-packager's --icon on Windows
//                    (sets the .exe icon shown in Explorer + taskbar)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'build');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SIZE = 256;
const buf = Buffer.alloc(SIZE * SIZE * 4);

// ---------- drawing primitives ----------
function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}
function fillRect(x0, y0, w, h, r, g, b, a = 255) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(x, y, r, g, b, a);
}
function fillRoundedRect(x0, y0, w, h, radius, r, g, b, a = 255) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = x < x0 + radius ? x0 + radius - x : x >= x0 + w - radius ? x - (x0 + w - radius - 1) : 0;
      const dy = y < y0 + radius ? y0 + radius - y : y >= y0 + h - radius ? y - (y0 + h - radius - 1) : 0;
      if (dx * dx + dy * dy <= radius * radius) setPx(x, y, r, g, b, a);
    }
  }
}
// Filled triangle by scanline. Vertices CW or CCW, doesn't matter.
function fillTri(ax, ay, bx, by, cx, cy, r, g, b, a = 255) {
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by, cy)));
  for (let y = minY; y <= maxY; y++) {
    const intersections = [];
    const edges = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]];
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 > y) === (y2 > y)) continue;
      const t = (y - y1) / (y2 - y1);
      intersections.push(x1 + t * (x2 - x1));
    }
    if (intersections.length < 2) continue;
    intersections.sort((p, q) => p - q);
    const xMin = Math.max(0, Math.floor(intersections[0]));
    const xMax = Math.min(SIZE - 1, Math.ceil(intersections[1]));
    for (let x = xMin; x <= xMax; x++) setPx(x, y, r, g, b, a);
  }
}
function fillCircle(cx, cy, radius, r, g, b, a = 255) {
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(SIZE - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(SIZE - 1, Math.ceil(cy + radius));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) setPx(x, y, r, g, b, a);
    }
  }
}

// ---------- house composition ----------
// Soft mint background circle so the icon reads against any taskbar.
fillCircle(SIZE / 2, SIZE / 2, SIZE / 2 - 4, 110, 200, 170);

// Roof — orange triangle covering top half.
fillTri(28, 130, SIZE - 28, 130, SIZE / 2, 38, 230, 110, 60);

// Roof underline (slightly darker)
for (let x = 28; x < SIZE - 28; x++) setPx(x, 130, 170, 70, 30);
for (let x = 28; x < SIZE - 28; x++) setPx(x, 131, 170, 70, 30);

// Body — cream rounded rect.
fillRoundedRect(56, 122, SIZE - 112, 108, 12, 250, 235, 200);

// Door — brown rounded rect.
fillRoundedRect(108, 156, 40, 74, 6, 130, 80, 40);
// Door knob
fillCircle(140, 198, 4, 250, 220, 100);

// Two square windows with mullion.
function window(x0, y0, size) {
  fillRect(x0, y0, size, size, 130, 200, 240);
  // Frame
  for (let i = 0; i < size; i++) {
    setPx(x0 + i, y0, 80, 60, 40);
    setPx(x0 + i, y0 + size - 1, 80, 60, 40);
    setPx(x0, y0 + i, 80, 60, 40);
    setPx(x0 + size - 1, y0 + i, 80, 60, 40);
  }
  // Cross
  for (let i = 1; i < size - 1; i++) {
    setPx(x0 + Math.floor(size / 2), y0 + i, 80, 60, 40);
    setPx(x0 + i, y0 + Math.floor(size / 2), 80, 60, 40);
  }
}
window(72, 152, 26);
window(160, 152, 26);

// Chimney peeking from the roof.
fillRect(166, 60, 22, 50, 200, 90, 50);
// Chimney cap
fillRect(162, 58, 30, 6, 150, 60, 30);

// ---------- PNG encoder (RGBA8 + zlib + CRC) ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // 8-bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // Raw IDAT — filter byte 0 (None) at the start of each scanline.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const png = encodePNG();
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
console.log(`[icon] wrote build/icon.png (${png.length} bytes)`);

// ---------- ICO encoder (PNG payload inside an ICONDIR entry) ----------
// Windows since Vista accepts a PNG-encoded image directly as an ICO
// entry — we just wrap our 256x256 PNG with a tiny 6-byte header + a
// 16-byte directory entry.
function encodeICO(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);  // reserved
  header.writeUInt16LE(1, 2);  // type 1 = icon
  header.writeUInt16LE(1, 4);  // image count
  const entry = Buffer.alloc(16);
  // Width/height: 0 means 256 (max).
  entry[0] = 0; entry[1] = 0;
  entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4);                   // colour planes
  entry.writeUInt16LE(32, 6);                  // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8);       // image data size
  entry.writeUInt32LE(6 + 16, 12);             // offset to image data
  return Buffer.concat([header, entry, pngBuf]);
}
const ico = encodeICO(png);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
console.log(`[icon] wrote build/icon.ico (${ico.length} bytes)`);

// Also drop the PNG into public/ as the renderer's favicon. Vite copies
// public/ into dist/ at build time, so the in-window tab icon picks
// this up too without extra config.
const FAVICON_DEST = path.resolve(__dirname, '..', 'public', 'favicon.png');
fs.writeFileSync(FAVICON_DEST, png);
console.log(`[icon] wrote public/favicon.png (${png.length} bytes)`);
