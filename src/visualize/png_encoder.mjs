// Pure-JS zero-dependency PNG encoder, RGBA Canvas, colormaps, 5x7 ASCII bitmap font,
// and shared defensive profile/report normalizers for yata visualizers.

import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// IEEE 802.3 CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG Binary Encoder (8-bit RGBA, filter byte 0 per scanline)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = data.length;
  const out = Buffer.alloc(12 + len);
  out.writeUInt32BE(len >>> 0, 0);
  typeBuf.copy(out, 4);
  if (len > 0) data.copy(out, 8);
  const crc = crc32(out.subarray(4, 8 + len));
  out.writeUInt32BE(crc >>> 0, 8 + len);
  return out;
}

export function encodePng(width, height, rgba) {
  const w = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
  const h = Math.max(1, Math.floor(Number.isFinite(height) ? height : 1));
  const stride = w * 4;
  const expected = stride * h;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w >>> 0, 0);
  ihdr.writeUInt32BE(h >>> 0, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = Buffer.alloc((stride + 1) * h);
  const src = rgba instanceof Uint8Array ? rgba : new Uint8Array(expected);
  for (let y = 0; y < h; y++) {
    const dstOff = y * (stride + 1);
    raw[dstOff] = 0; // filter type None
    const srcOff = y * stride;
    if (srcOff + stride <= src.length) {
      raw.set(src.subarray(srcOff, srcOff + stride), dstOff + 1);
    } else if (srcOff < src.length) {
      raw.set(src.subarray(srcOff), dstOff + 1);
    }
  }

  const compressed = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Colormaps
// ---------------------------------------------------------------------------

const MAGMA_STOPS = [
  [0, 0, 4],
  [28, 16, 68],
  [79, 18, 123],
  [129, 37, 129],
  [181, 54, 122],
  [229, 80, 100],
  [251, 135, 97],
  [252, 253, 191],
];

export function magmaColor(t) {
  const v = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const pos = v * (MAGMA_STOPS.length - 1);
  const i = Math.min(MAGMA_STOPS.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = MAGMA_STOPS[i];
  const b = MAGMA_STOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
    255,
  ];
}

export function signedDiffColor(t) {
  const v = Number.isFinite(t) ? Math.max(-1, Math.min(1, t)) : 0;
  const base = [245, 244, 240];
  if (v < 0) {
    const f = -v;
    const neg = [37, 99, 235];
    return [
      Math.round(base[0] + (neg[0] - base[0]) * f),
      Math.round(base[1] + (neg[1] - base[1]) * f),
      Math.round(base[2] + (neg[2] - base[2]) * f),
      255,
    ];
  }
  const f = v;
  const pos = [220, 38, 38];
  return [
    Math.round(base[0] + (pos[0] - base[0]) * f),
    Math.round(base[1] + (pos[1] - base[1]) * f),
    Math.round(base[2] + (pos[2] - base[2]) * f),
    255,
  ];
}

export function encodeHeatmapPng(cols, rows, valueAt, colorFn = magmaColor, outW = 144, outH = 48) {
  const w = Math.max(1, Math.floor(Number.isFinite(outW) ? outW : 144));
  const h = Math.max(1, Math.floor(Number.isFinite(outH) ? outH : 48));
  const rgba = new Uint8Array(w * h * 4);
  const emptyColor = colorFn(0);

  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      rgba[o] = emptyColor[0];
      rgba[o + 1] = emptyColor[1];
      rgba[o + 2] = emptyColor[2];
      rgba[o + 3] = emptyColor[3] ?? 255;
    }
    return encodePng(w, h, rgba);
  }

  for (let py = 0; py < h; py++) {
    const row = Math.max(0, Math.min(rows - 1, rows - 1 - Math.floor((py * rows) / h)));
    for (let px = 0; px < w; px++) {
      const col = Math.max(0, Math.min(cols - 1, Math.floor((px * cols) / w)));
      const val = valueAt(col, row);
      const c = colorFn(val);
      const o = (py * w + px) * 4;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = c[3] ?? 255;
    }
  }
  return encodePng(w, h, rgba);
}

// ---------------------------------------------------------------------------
// Complete 5x7 ASCII Bitmap Font (0x20 .. 0x7E)
// Each glyph has 7 rows; bits 4..0 represent columns left..right.
// ---------------------------------------------------------------------------

const FONT_5X7 = {
  32: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // ' '
  33: [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04], // '!'
  34: [0x0a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00], // '"'
  35: [0x0a, 0x1f, 0x0a, 0x0a, 0x1f, 0x0a, 0x00], // '#'
  36: [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04], // '$'
  37: [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03], // '%'
  38: [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d], // '&'
  39: [0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00], // '''
  40: [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], // '('
  41: [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08], // ')'
  42: [0x00, 0x0a, 0x04, 0x1f, 0x04, 0x0a, 0x00], // '*'
  43: [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00], // '+'
  44: [0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x08], // ','
  45: [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00], // '-'
  46: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04], // '.'
  47: [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10], // '/'
  48: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], // '0'
  49: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e], // '1'
  50: [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f], // '2'
  51: [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e], // '3'
  52: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], // '4'
  53: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e], // '5'
  54: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], // '6'
  55: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08], // '7'
  56: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], // '8'
  57: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c], // '9'
  58: [0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x00], // ':'
  59: [0x00, 0x04, 0x00, 0x00, 0x04, 0x04, 0x08], // ';'
  60: [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02], // '<'
  61: [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00], // '='
  62: [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08], // '>'
  63: [0x0e, 0x11, 0x01, 0x06, 0x04, 0x00, 0x04], // '?'
  64: [0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0e], // '@'
  65: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], // 'A'
  66: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e], // 'B'
  67: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], // 'C'
  68: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c], // 'D'
  69: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], // 'E'
  70: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10], // 'F'
  71: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], // 'G'
  72: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], // 'H'
  73: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], // 'I'
  74: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c], // 'J'
  75: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], // 'K'
  76: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f], // 'L'
  77: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], // 'M'
  78: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11], // 'N'
  79: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], // 'O'
  80: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10], // 'P'
  81: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], // 'Q'
  82: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11], // 'R'
  83: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], // 'S'
  84: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04], // 'T'
  85: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], // 'U'
  86: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04], // 'V'
  87: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11], // 'W'
  88: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11], // 'X'
  89: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04], // 'Y'
  90: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f], // 'Z'
  91: [0x0e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0e], // '['
  92: [0x10, 0x10, 0x08, 0x04, 0x02, 0x01, 0x01], // '\'
  93: [0x0e, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0e], // ']'
  94: [0x04, 0x0a, 0x11, 0x00, 0x00, 0x00, 0x00], // '^'
  95: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f], // '_'
  96: [0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00], // '`'
  97: [0x00, 0x00, 0x0e, 0x01, 0x0f, 0x11, 0x0f], // 'a'
  98: [0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x1e], // 'b'
  99: [0x00, 0x00, 0x0e, 0x10, 0x10, 0x11, 0x0e], // 'c'
  100: [0x01, 0x01, 0x0f, 0x11, 0x11, 0x11, 0x0f], // 'd'
  101: [0x00, 0x00, 0x0e, 0x11, 0x1f, 0x10, 0x0e], // 'e'
  102: [0x06, 0x08, 0x1e, 0x08, 0x08, 0x08, 0x08], // 'f'
  103: [0x00, 0x00, 0x0f, 0x11, 0x0f, 0x01, 0x0e], // 'g'
  104: [0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x11], // 'h'
  105: [0x04, 0x00, 0x0c, 0x04, 0x04, 0x04, 0x0e], // 'i'
  106: [0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0c], // 'j'
  107: [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12], // 'k'
  108: [0x0c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], // 'l'
  109: [0x00, 0x00, 0x1a, 0x15, 0x15, 0x11, 0x11], // 'm'
  110: [0x00, 0x00, 0x1e, 0x11, 0x11, 0x11, 0x11], // 'n'
  111: [0x00, 0x00, 0x0e, 0x11, 0x11, 0x11, 0x0e], // 'o'
  112: [0x00, 0x00, 0x1e, 0x11, 0x1e, 0x10, 0x10], // 'p'
  113: [0x00, 0x00, 0x0f, 0x11, 0x0f, 0x01, 0x01], // 'q'
  114: [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10], // 'r'
  115: [0x00, 0x00, 0x0f, 0x10, 0x0e, 0x01, 0x1e], // 's'
  116: [0x08, 0x08, 0x1e, 0x08, 0x08, 0x09, 0x06], // 't'
  117: [0x00, 0x00, 0x11, 0x11, 0x11, 0x13, 0x0d], // 'u'
  118: [0x00, 0x00, 0x11, 0x11, 0x11, 0x0a, 0x04], // 'v'
  119: [0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0a], // 'w'
  120: [0x00, 0x00, 0x11, 0x0a, 0x04, 0x0a, 0x11], // 'x'
  121: [0x00, 0x00, 0x11, 0x11, 0x0f, 0x01, 0x0e], // 'y'
  122: [0x00, 0x00, 0x1f, 0x02, 0x04, 0x08, 0x1f], // 'z'
  123: [0x02, 0x04, 0x04, 0x08, 0x04, 0x04, 0x02], // '{'
  124: [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04], // '|'
  125: [0x08, 0x04, 0x04, 0x02, 0x04, 0x04, 0x08], // '}'
  126: [0x00, 0x00, 0x08, 0x15, 0x02, 0x00, 0x00], // '~'
};

// ---------------------------------------------------------------------------
// RGBA Software Canvas
// ---------------------------------------------------------------------------

export class Canvas {
  constructor(width, height, bg = [250, 248, 245, 255]) {
    this.width = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
    this.height = Math.max(1, Math.floor(Number.isFinite(height) ? height : 1));
    this.data = new Uint8Array(this.width * this.height * 4);
    const r = bg[0] ?? 250;
    const g = bg[1] ?? 248;
    const b = bg[2] ?? 245;
    const a = bg[3] ?? 255;
    for (let i = 0; i < this.width * this.height; i++) {
      const o = i * 4;
      this.data[o] = r;
      this.data[o + 1] = g;
      this.data[o + 2] = b;
      this.data[o + 3] = a;
    }
  }

  setPixel(x, y, rgba) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || ix >= this.width || iy < 0 || iy >= this.height) return;
    const sr = rgba[0] ?? 0;
    const sg = rgba[1] ?? 0;
    const sb = rgba[2] ?? 0;
    const sa = rgba[3] ?? 255;
    if (sa <= 0) return;
    const o = (iy * this.width + ix) * 4;
    if (sa >= 255) {
      this.data[o] = sr;
      this.data[o + 1] = sg;
      this.data[o + 2] = sb;
      this.data[o + 3] = 255;
      return;
    }
    const alpha = sa / 255;
    const inv = 1 - alpha;
    this.data[o] = Math.round(sr * alpha + this.data[o] * inv);
    this.data[o + 1] = Math.round(sg * alpha + this.data[o + 1] * inv);
    this.data[o + 2] = Math.round(sb * alpha + this.data[o + 2] * inv);
    this.data[o + 3] = Math.min(255, Math.round(sa + this.data[o + 3] * inv));
  }

  fillRect(x, y, w, h, rgba) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      return;
    }
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        this.setPixel(px, py, rgba);
      }
    }
  }

  strokeRect(x, y, w, h, rgba, thickness = 1) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      return;
    }
    const t = Math.max(1, Math.floor(thickness));
    this.fillRect(x, y, w, t, rgba);
    this.fillRect(x, y + h - t, w, t, rgba);
    this.fillRect(x, y, t, h, rgba);
    this.fillRect(x + w - t, y, t, h, rgba);
  }

  drawLine(x0, y0, x1, y1, rgba, thickness = 1) {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
      return;
    }
    let ix0 = Math.round(x0);
    let iy0 = Math.round(y0);
    const ix1 = Math.round(x1);
    const iy1 = Math.round(y1);
    const dx = Math.abs(ix1 - ix0);
    const dy = Math.abs(iy1 - iy0);
    const sx = ix0 < ix1 ? 1 : -1;
    const sy = iy0 < iy1 ? 1 : -1;
    let err = dx - dy;
    const t = Math.max(1, Math.floor(thickness));
    const half = Math.floor(t / 2);

    while (true) {
      if (t === 1) {
        this.setPixel(ix0, iy0, rgba);
      } else {
        for (let oy = -half; oy < t - half; oy++) {
          for (let ox = -half; ox < t - half; ox++) {
            this.setPixel(ix0 + ox, iy0 + oy, rgba);
          }
        }
      }
      if (ix0 === ix1 && iy0 === iy1) break;
      const e2 = err * 2;
      if (e2 > -dy) {
        err -= dy;
        ix0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        iy0 += sy;
      }
    }
  }

  drawCircle(cx, cy, r, rgba, fill = true) {
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || r <= 0) return;
    const icx = Math.round(cx);
    const icy = Math.round(cy);
    const ir = Math.ceil(r);
    const r2 = r * r;
    const inner2 = Math.max(0, (r - 1.2) * (r - 1.2));
    for (let oy = -ir; oy <= ir; oy++) {
      for (let ox = -ir; ox <= ir; ox++) {
        const d2 = ox * ox + oy * oy;
        if (fill ? d2 <= r2 : d2 <= r2 && d2 >= inner2) {
          this.setPixel(icx + ox, icy + oy, rgba);
        }
      }
    }
  }

  drawPolyline(points, rgba, thickness = 1) {
    if (!Array.isArray(points) || points.length === 0) return;
    let prev = null;
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
        prev = null;
        continue;
      }
      if (prev) {
        this.drawLine(prev[0], prev[1], pt[0], pt[1], rgba, thickness);
      } else if (points.length === 1) {
        this.setPixel(pt[0], pt[1], rgba);
      }
      prev = pt;
    }
  }

  blitHeatmap(x, y, w, h, cols, rows, valueAt, colorFn = magmaColor) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      return;
    }
    const iw = Math.floor(w);
    const ih = Math.floor(h);
    if (iw <= 0 || ih <= 0 || !Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      return;
    }
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    for (let py = 0; py < ih; py++) {
      const row = Math.max(0, Math.min(rows - 1, rows - 1 - Math.floor((py * rows) / ih)));
      for (let px = 0; px < iw; px++) {
        const col = Math.max(0, Math.min(cols - 1, Math.floor((px * cols) / iw)));
        const val = valueAt(col, row);
        this.setPixel(ix + px, iy + py, colorFn(val));
      }
    }
  }

  drawText(x, y, text, rgba, scale = 1, align = "left") {
    if (!Number.isFinite(x) || !Number.isFinite(y) || text == null) return;
    const str = String(text);
    if (str.length === 0) return;
    const s = Math.max(1, Math.floor(Number.isFinite(scale) ? scale : 1));
    const adv = 6 * s;
    const totalW = str.length * adv - s;
    let cursorX = Math.round(x);
    if (align === "center") cursorX = Math.round(x - totalW / 2);
    else if (align === "right") cursorX = Math.round(x - totalW);
    const baseY = Math.round(y);

    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      const glyph = FONT_5X7[code] ?? (code < 0x20 ? FONT_5X7[32] : FONT_5X7[63]);
      for (let row = 0; row < 7; row++) {
        const bits = glyph[row];
        if (bits === 0) continue;
        for (let col = 0; col < 5; col++) {
          if ((bits & (1 << (4 - col))) !== 0) {
            if (s === 1) {
              this.setPixel(cursorX + col, baseY + row, rgba);
            } else {
              this.fillRect(cursorX + col * s, baseY + row * s, s, s, rgba);
            }
          }
        }
      }
      cursorX += adv;
    }
  }

  toPngBuffer() {
    return encodePng(this.width, this.height, this.data);
  }
}

// ---------------------------------------------------------------------------
// Shared Defensive Normalization Helpers (internal to src/visualize/*)
// ---------------------------------------------------------------------------

export function finite(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function clamp(v, lo, hi) {
  const n = finite(v, lo);
  return n < lo ? lo : n > hi ? hi : n;
}

export function normalizeProfile(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const sampleRate = finite(p.sampleRate, 24000) > 0 ? finite(p.sampleRate, 24000) : 24000;
  const rawFrames = Array.isArray(p.frames) ? p.frames : [];
  const frames = rawFrames.map((f, idx) => {
    const o = f && typeof f === "object" ? f : {};
    return {
      timeSec: Math.max(0, finite(o.timeSec, idx * 0.01)),
      rms: clamp(o.rms, 0, 10),
      rmsDb: clamp(o.rmsDb, -120, 6),
      peakPos: clamp(o.peakPos, -10, 10),
      peakNeg: clamp(o.peakNeg, -10, 10),
      zcrRate: clamp(o.zcrRate, 0, 1),
      hfRatio: clamp(o.hfRatio, 0, 1),
      f0: Math.max(0, finite(o.f0, 0)),
      domHz: Math.max(0, finite(o.domHz, 0)),
      periodicity: clamp(o.periodicity, 0, 1),
      voiced: Boolean(o.voiced),
      hnrDb: clamp(o.hnrDb, -20, 40),
      spectralCentroidHz: Math.max(0, finite(o.spectralCentroidHz, 0)),
      spectralRolloffHz: Math.max(0, finite(o.spectralRolloffHz, 0)),
      spectralFlatness: clamp(o.spectralFlatness, 0, 1),
      harshnessRatio: clamp(o.harshnessRatio, 0, 1),
      spectralFlux: clamp(o.spectralFlux, 0, 1),
      envelopeCurvature: Math.max(0, finite(o.envelopeCurvature, 0)),
      clipped: Boolean(o.clipped),
    };
  });

  let durationSec = Math.max(0, finite(p.durationSec, 0));
  if (durationSec <= 0 && frames.length > 0) {
    durationSec = Math.max(0, frames[frames.length - 1].timeSec);
  }

  const sp = p.spectrogram && typeof p.spectrogram === "object" ? p.spectrogram : {};
  const times = Array.isArray(sp.times) ? sp.times.map((t) => Math.max(0, finite(t, 0))) : frames.map((f) => f.timeSec);
  const freqsHz = Array.isArray(sp.freqsHz) ? sp.freqsHz.map((hz) => Math.max(0, finite(hz, 0))) : [];
  const dbMatrix = Array.isArray(sp.dbMatrix) ? sp.dbMatrix : [];
  const minDb = finite(sp.minDb, -100);
  const maxDb = finite(sp.maxDb, dbMatrix.length > 0 ? -100 : 0);
  const dbSpan = maxDb - minDb > 1e-3 ? maxDb - minDb : 1;

  const sl = p.spectralSlice && typeof p.spectralSlice === "object" ? p.spectralSlice : {};
  const slFreqs = Array.isArray(sl.freqsHz) ? sl.freqsHz.map((hz) => Math.max(0, finite(hz, 0))) : [];
  const slMean = Array.isArray(sl.meanDb) ? sl.meanDb.map((d) => finite(d, -100)) : [];
  const slPeak = Array.isArray(sl.peakDb) ? sl.peakDb.map((d) => finite(d, -100)) : [];
  const slPeaks = Array.isArray(sl.peaks)
    ? sl.peaks
        .filter((pk) => pk && Number.isFinite(pk.hz) && Number.isFinite(pk.db))
        .map((pk) => ({ hz: pk.hz, db: pk.db }))
    : [];

  const mk = p.markers && typeof p.markers === "object" ? p.markers : {};
  const numArr = (a) => (Array.isArray(a) ? a.filter((v) => Number.isFinite(v)) : []);
  const tw = mk.tailWindow && typeof mk.tailWindow === "object" ? mk.tailWindow : {};
  const tailWindow = {
    startSec: Math.max(0, finite(tw.startSec, 0)),
    endSec: Math.max(0, finite(tw.endSec, 0)),
  };
  const hotspots = Array.isArray(mk.hotspots)
    ? mk.hotspots
        .filter((h) => h && Number.isFinite(h.startSec) && Number.isFinite(h.endSec))
        .map((h) => ({
          startSec: Math.max(0, h.startSec),
          endSec: Math.max(0, h.endSec),
          reason: typeof h.reason === "string" && h.reason ? h.reason : "hotspot",
          severity: clamp(h.severity, 0, 1),
        }))
    : [];

  const phaseLoop = Array.isArray(p.phaseLoop)
    ? p.phaseLoop
        .filter((pt) => pt && typeof pt === "object")
        .map((pt, idx) => ({
          t: Math.max(0, finite(pt.t, idx * 0.01)),
          tension: clamp(pt.tension, 0, 1),
          breath: clamp(pt.breath, 0, 1),
        }))
    : [];

  return {
    sampleRate,
    durationSec,
    fftSize: Math.max(256, Math.floor(finite(p.fftSize, 1024))),
    hopSize: Math.max(128, Math.floor(finite(p.hopSize, 240))),
    frames,
    spectrogram: { times, freqsHz, dbMatrix, minDb, maxDb, dbSpan },
    spectralSlice: { freqsHz: slFreqs, meanDb: slMean, peakDb: slPeak, peaks: slPeaks },
    markers: {
      onsets: numArr(mk.onsets),
      curvatureSpikes: numArr(mk.curvatureSpikes),
      valleys: numArr(mk.valleys),
      clips: numArr(mk.clips),
      tailWindow,
      hotspots,
    },
    phaseLoop,
  };
}

export function normalizeReport(report) {
  if (!report || typeof report !== "object") {
    return {
      hasReport: false,
      label: "untitled",
      verdict: "NO_REPORT",
      triggeredCount: 0,
      totalFalsifiers: 0,
      mirrorSummary: "",
      features: {},
      falsifiers: [],
      triggered: [],
    };
  }

  const rawFals = Array.isArray(report.falsifiers) ? report.falsifiers : [];
  const falsifiers = rawFals.map((f, idx) => {
    const o = f && typeof f === "object" ? f : {};
    let where = null;
    if (o.where && typeof o.where === "object") {
      const w = {};
      if (Number.isFinite(o.where.startSec)) w.startSec = o.where.startSec;
      if (Number.isFinite(o.where.endSec)) w.endSec = o.where.endSec;
      if (Number.isFinite(o.where.freqHz)) w.freqHz = o.where.freqHz;
      if (Object.keys(w).length > 0) where = w;
    }
    return {
      id: typeof o.id === "string" && o.id ? o.id : `F${idx + 1}`,
      domain: typeof o.domain === "string" && o.domain ? o.domain : "unknown",
      name: typeof o.name === "string" && o.name ? o.name : (typeof o.id === "string" ? o.id : `F${idx + 1}`),
      triggered: Boolean(o.triggered),
      score: clamp(o.score, 0, 1),
      threshold: finite(o.threshold, 0.5),
      evidence: typeof o.evidence === "string" ? o.evidence : "",
      hint: typeof o.hint === "string" ? o.hint : "",
      where,
    };
  });

  const triggered = falsifiers
    .filter((f) => f.triggered)
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));

  const totalFalsifiers = Number.isFinite(report.totalFalsifiers)
    ? Math.max(0, Math.floor(report.totalFalsifiers))
    : falsifiers.length;

  const triggeredCount = Number.isFinite(report.triggeredCount)
    ? Math.max(0, Math.floor(report.triggeredCount))
    : triggered.length;

  let verdict = typeof report.verdict === "string" && report.verdict ? report.verdict : "";
  if (!verdict) {
    if (totalFalsifiers === 0 && falsifiers.length === 0) verdict = "UNKNOWN";
    else verdict = triggeredCount > 0 ? "REJECTED_UNKAWAII" : "SURVIVED_KAWAII_CANDIDATE";
  }

  const features = report.features && typeof report.features === "object" ? report.features : {};

  return {
    hasReport: true,
    label: typeof report.label === "string" && report.label ? report.label : "untitled",
    verdict,
    triggeredCount,
    totalFalsifiers,
    mirrorSummary: typeof report.mirrorSummary === "string" ? report.mirrorSummary : "",
    features,
    falsifiers,
    triggered,
  };
}
