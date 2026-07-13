// Abhängigkeitsfreier PNG-Generator für die Familienkalender-Icons.
// Rendert die SVG-Form (Rechtecke) in echte PNGs — nur Node-Bordmittel (zlib).
// Aufruf:  node icons/gen-icons.js   (aus dem Kalender-Ordner)
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// Formen aus icon.svg (viewBox 0..100). [x,y,w,h,r,[R,G,B]]
const HEX = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
const BLUE = HEX('#4361ee'), DARK = HEX('#3a56d4'), WHITE = [255,255,255], RED = HEX('#e63946');

const SHAPES_CONTENT = [
  [16,26,68,58,8, WHITE],
  [16,26,68,22,8, DARK],
  [16,38,68,10,0, DARK],
  [32,16,10,20,5, WHITE],
  [58,16,10,20,5, WHITE],
  [24,60,12,10,3, BLUE],
  [44,60,12,10,3, BLUE],
  [64,60,12,10,3, RED],
  [24,76,12,10,3, BLUE],
  [44,76,12,10,3, BLUE],
];

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  if (r <= 0) return true;
  // Ecken-Zentren
  const cx = px < x + r ? x + r : (px > x + w - r ? x + w - r : px);
  const cy = py < y + r ? y + r : (py > y + h - r ? y + h - r : py);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// Liefert Farbe [R,G,B] oder null (transparent) für einen Punkt in Viewbox-Koordinaten
function sampleColor(px, py, maskable) {
  // Hintergrund
  if (maskable) {
    // volle Fläche (Plattform legt eigene Maske drüber)
    // -> content danach
  } else {
    if (!inRoundRect(px, py, 0, 0, 100, 100, 22)) return null;
  }
  // Inhalt von oben nach unten -> topmost gewinnt: rückwärts iterieren
  for (let i = SHAPES_CONTENT.length - 1; i >= 0; i--) {
    const s = SHAPES_CONTENT[i];
    if (inRoundRect(px, py, s[0], s[1], s[2], s[3], s[4])) return s[5];
  }
  // sonst Hintergrundblau
  return BLUE;
}

function renderRGBA(size, maskable) {
  const SS = 4; // Supersampling gegen Treppchen
  const scale = 100 / size;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) * scale;
          const py = (y + (sy + 0.5) / SS) * scale;
          const c = sampleColor(px, py, maskable);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      // Farben nur über abgedeckte Subpixel mitteln (saubere Kanten)
      const cov = a / 255;
      buf[o]   = cov ? Math.round(r / cov) : 0;
      buf[o+1] = cov ? Math.round(g / cov) : 0;
      buf[o+2] = cov ? Math.round(b / cov) : 0;
      buf[o+3] = Math.round(a / n);
    }
  }
  return buf;
}

// --- PNG-Encoder (RGBA, 8-bit) ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // Filter-Byte 0 pro Zeile
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const OUT = __dirname;
const jobs = [
  { size: 192, maskable: false, name: 'icon-192.png' },
  { size: 512, maskable: false, name: 'icon-512.png' },
  { size: 192, maskable: true,  name: 'icon-192-maskable.png' },
  { size: 512, maskable: true,  name: 'icon-512-maskable.png' },
  { size: 1024, maskable: false, name: 'icon-1024.png' }, // Store-Reserve / Quelle
];
for (const j of jobs) {
  const png = encodePNG(j.size, renderRGBA(j.size, j.maskable));
  fs.writeFileSync(path.join(OUT, j.name), png);
  console.log('geschrieben:', j.name, `(${png.length} Bytes)`);
}
console.log('fertig.');
