// make-icon.mjs — draw the Scan Bridge icon and write every file that uses it:
//
//   packaging/icon/scan-bridge.ico   Windows exe icon (16-256 px)
//   packaging/icon/scan-bridge.png   256 px preview / macOS + Linux
//   server/icon.js                   the tray icon (PNG + ICO, base64)
//
// Pure Node (no image libraries): each pixel is computed from simple shapes and
// supersampled for smooth edges. Change the colours or shapes here, then run
//   node packaging/icon/make-icon.mjs
// and rebuild the exe.

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const BLUE_TOP = [37, 99, 235]; // tile gradient, top
const BLUE_BOTTOM = [23, 64, 168]; // tile gradient, bottom
const PAPER = [255, 255, 255];
const FOLD = [203, 219, 247];
const LINES = [148, 172, 214];
const BEAM = [34, 211, 238]; // scan line

// Shapes in a 0..1 unit square. Each returns true when (x, y) is inside.
const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

// The document: a page with its top-right corner folded over.
const PAGE = { x0: 0.27, y0: 0.17, x1: 0.73, y1: 0.83, fold: 0.15 };
const inPage = (x, y) =>
  roundRect(x, y, PAGE.x0, PAGE.y0, PAGE.x1, PAGE.y1, 0.035) && x - PAGE.x1 + PAGE.fold <= y - PAGE.y0;
const inFold = (x, y) => {
  const fx = x - (PAGE.x1 - PAGE.fold);
  const fy = y - PAGE.y0;
  return fx >= 0 && fy <= PAGE.fold && fx <= fy;
};

/** The colour at (x, y), as [r, g, b, a] with a in 0..1. */
function shade(x, y, size) {
  if (!roundRect(x, y, 0.03, 0.03, 0.97, 0.97, 0.2)) return [0, 0, 0, 0];
  // Scan beam across the page, with a soft glow on larger sizes.
  const beamY = 0.56;
  const beamHalf = size <= 24 ? 0.05 : 0.03;
  if (Math.abs(y - beamY) <= beamHalf && x >= 0.16 && x <= 0.84) return [...BEAM, 1];
  if (inFold(x, y)) return [...FOLD, 1];
  if (inPage(x, y)) {
    // Text lines (only drawn where there's room for them to read as lines).
    if (size >= 32) {
      for (const [ly, lx1] of [[0.35, 0.62], [0.44, 0.66], [0.68, 0.66], [0.75, 0.55]]) {
        if (Math.abs(y - ly) <= 0.018 && x >= 0.35 && x <= lx1) return [...LINES, 1];
      }
    }
    return [...PAPER, 1];
  }
  const t = y;
  return [...BLUE_TOP.map((c, i) => Math.round(c + (BLUE_BOTTOM[i] - c) * t)), 1];
}

/** RGBA pixels for one size, 4x4 supersampled. */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < S; sj++) {
        for (let si = 0; si < S; si++) {
          const [cr, cg, cb, ca] = shade((i + (si + 0.5) / S) / size, (j + (sj + 0.5) / S) / size, size);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const o = (j * size + i) * 4;
      px[o] = a ? Math.round(r / a) : 0;
      px[o + 1] = a ? Math.round(g / a) : 0;
      px[o + 2] = a ? Math.round(b / a) : 0;
      px[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return px;
}

// --- PNG / ICO encoding ----------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size) {
  const px = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico holding one PNG image per size (supported since Windows Vista). */
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, k) => {
    const e = 6 + 16 * k;
    header[e] = s >= 256 ? 0 : s; // 0 means 256
    header[e + 1] = s >= 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(images[k].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[k].length;
  });
  return Buffer.concat([header, ...images]);
}

writeFileSync(join(here, "scan-bridge.ico"), ico([16, 24, 32, 48, 64, 128, 256]));
writeFileSync(join(here, "scan-bridge.png"), png(256));
writeFileSync(
  join(root, "server", "icon.js"),
  `// Tray icon (generated by packaging/icon/make-icon.mjs — edit that, not this).
// PNG for mac/linux, ICO for Windows.
export const ICON_PNG="${png(32).toString("base64")}";
export const ICON_ICO="${ico([16, 32]).toString("base64")}";
`
);
console.log("✓ wrote packaging/icon/scan-bridge.ico, scan-bridge.png and server/icon.js");
