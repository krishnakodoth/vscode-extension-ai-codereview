// Generates media/icon.png matching the icon.svg design
// Run: node media/gen-icon.js
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const W = 128, H = 128;

// RGBA pixel buffer
const px = Buffer.alloc(W * H * 4, 0);

// Icon color (#89b4fa) on transparent background
const [IR, IG, IB] = [0x89, 0xb4, 0xfa];

function blend(x, y, alpha) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H || alpha <= 0) return;
  const i = (y * W + x) * 4;
  const a1 = Math.min(1, alpha), a0 = px[i + 3] / 255;
  const aO = a1 + a0 * (1 - a1);
  if (aO === 0) return;
  px[i]     = Math.round((IR * a1 + px[i]     * a0 * (1 - a1)) / aO);
  px[i + 1] = Math.round((IG * a1 + px[i + 1] * a0 * (1 - a1)) / aO);
  px[i + 2] = Math.round((IB * a1 + px[i + 2] * a0 * (1 - a1)) / aO);
  px[i + 3] = Math.round(aO * 255);
}

// Anti-aliased circle stroke
function circle(cx, cy, r, lw) {
  const r1 = r - lw / 2, r2 = r + lw / 2;
  for (let py = Math.floor(cy - r2 - 1); py <= Math.ceil(cy + r2 + 1); py++) {
    for (let px2 = Math.floor(cx - r2 - 1); px2 <= Math.ceil(cx + r2 + 1); px2++) {
      const d = Math.hypot(px2 - cx, py - cy);
      const a = Math.max(0, Math.min(1, Math.min(r2 + 0.5 - d, d - r1 + 0.5)));
      blend(px2, py, a);
    }
  }
}

// Anti-aliased thick line with round caps
function line(x0, y0, x1, y1, lw) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  if (len === 0) return;
  const nx = -dy / len, ny = dx / len, hw = lw / 2;
  const steps = Math.ceil(len) * 4;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, mx = x0 + dx * t, my = y0 + dy * t;
    for (let p = Math.floor(-hw - 1); p <= Math.ceil(hw + 1); p++) {
      const a = Math.max(0, Math.min(1, hw + 0.5 - Math.abs(p)));
      blend(mx + nx * p, my + ny * p, a);
    }
  }
  // Round end caps
  for (const [cx, cy] of [[x0, y0], [x1, y1]]) {
    for (let qy = Math.floor(cy - hw - 1); qy <= Math.ceil(cy + hw + 1); qy++) {
      for (let qx = Math.floor(cx - hw - 1); qx <= Math.ceil(cx + hw + 1); qx++) {
        const a = Math.max(0, Math.min(1, hw + 0.5 - Math.hypot(qx - cx, qy - cy)));
        blend(qx, qy, a);
      }
    }
  }
}

// Filled polygon (scanline)
function fillPoly(pts) {
  const ys = pts.map(p => p[1]);
  const minY = Math.floor(Math.min(...ys)), maxY = Math.ceil(Math.max(...ys));
  for (let sy = minY; sy <= maxY; sy++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= sy && y2 > sy) || (y2 <= sy && y1 > sy))
        xs.push(x1 + (sy - y1) * (x2 - x1) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let j = 0; j < xs.length - 1; j += 2) {
      for (let sx = Math.floor(xs[j]); sx <= Math.ceil(xs[j + 1]); sx++) {
        const a = Math.max(0, Math.min(1, Math.min(sx - xs[j] + 0.5, xs[j + 1] - sx + 0.5)));
        blend(sx, sy, a);
      }
    }
  }
}

// Scale factor: SVG 24x24 → PNG 128x128
const S = 128 / 24;
const s = v => v * S;

// 1. Magnifying glass lens: circle cx=10 cy=10 r=6.5 stroke-width=1.5
circle(s(10), s(10), s(6.5), S * 1.5);

// 2. Handle: (14.6,14.6)→(20.5,20.5) stroke-width=2
line(s(14.6), s(14.6), s(20.5), s(20.5), S * 2);

// 3. < bracket: (9.5,7.5)→(7,10)→(9.5,12.5) stroke-width=1.5
line(s(9.5), s(7.5), s(7), s(10), S * 1.5);
line(s(7), s(10), s(9.5), s(12.5), S * 1.5);

// 4. > bracket: (10.5,7.5)→(13,10)→(10.5,12.5) stroke-width=1.5
line(s(10.5), s(7.5), s(13), s(10), S * 1.5);
line(s(13), s(10), s(10.5), s(12.5), S * 1.5);

// 5. 4-point sparkle (filled polygon)
// M20 1.5 L20.6 3.4 L22.5 4 L20.6 4.6 L20 6.5 L19.4 4.6 L17.5 4 L19.4 3.4 Z
fillPoly([
  [20, 1.5], [20.6, 3.4], [22.5, 4], [20.6, 4.6],
  [20, 6.5], [19.4, 4.6], [17.5, 4], [19.4, 3.4]
].map(([x, y]) => [s(x), s(y)]));

// ── Encode PNG ──────────────────────────────────────────────────────────────
// Build raw filtered image data (filter byte 0 per row)
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter None
  px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}
const comp = zlib.deflateSync(raw, { level: 9 });

// CRC table
const crcTbl = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTbl[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4), cr = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  cr.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, cr]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', comp),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = `${__dirname}/icon.png`;
fs.writeFileSync(out, png);
console.log(`icon.png created (${png.length} bytes)`);
