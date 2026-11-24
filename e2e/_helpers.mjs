import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_PATH = path.join(REPO_ROOT, "unkawaii_detector.mjs");
export const DEMO_HTML_PATH = path.join(REPO_ROOT, "bench", "yata_audition_demo.html");

export const V01_FEATURE_KEYS = Object.freeze([
  "sampleRate",
  "durationSec",
  "frameCount",
  "activeFrameCount",
  "peak",
  "clipRatio",
  "maxSampleJump",
  "maxAttackSlope",
  "maxAttackTimeSec",
  "meanHfRatio",
  "voicedRatio",
  "jitter",
  "shimmer",
  "commonCauseCoupling",
  "tailDecaySec",
  "tailStartSec",
]);

/**
 * Deterministic PRNG (Mulberry32) in [0, 1).
 */
export function mulberry32(seed = 2026) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Independent pure-JS RIFF/WAVE PCM16 encoder so test fixtures do not depend on SUT internals.
 * Accepts Float32Array (mono) or Float32Array[] (multi-channel).
 */
export function makeWavBuffer(samplesOrChannels, sampleRate = 24000) {
  const channels = Array.isArray(samplesOrChannels)
    ? samplesOrChannels
    : [samplesOrChannels];
  assert.ok(channels.length >= 1, "makeWavBuffer requires at least 1 channel");
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  for (let c = 1; c < numChannels; c++) {
    assert.equal(channels[c].length, numFrames, "All channels must have equal length");
  }

  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const raw = channels[c][i];
      const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, int16)), offset);
      offset += 2;
    }
  }
  return buf;
}

export function writeWavFile(filePath, samplesOrChannels, sampleRate = 24000) {
  const buf = makeWavBuffer(samplesOrChannels, sampleRate);
  fs.writeFileSync(filePath, buf);
  return buf;
}

/**
 * Isolated temporary directory helper with guaranteed cleanup.
 */
export async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yata-e2e-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Smooth raised-cosine fade envelope with gentle attack and natural tail.
 */
function smoothEnvelope(t, durationSec, attackSec = 0.06, releaseSec = 0.14) {
  let env = 1;
  if (t < attackSec && attackSec > 0) {
    env *= 0.5 - 0.5 * Math.cos((Math.PI * t) / attackSec);
  }
  const rem = durationSec - t;
  if (rem < releaseSec && releaseSec > 0) {
    env *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, rem)) / releaseSec);
  }
  return env;
}

/**
 * Pleasant warm harmonic tone with gentle organic pitch contour and soft tail.
 */
export function genPleasantWarmTone(sampleRate = 24000, durationSec = 0.65, seed = 101) {
  const n = Math.max(1, Math.round(sampleRate * durationSec));
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  let phase = 0;
  let breathState = 0;

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const u = t / durationSec;
    // Gentle natural rising-then-softly-falling prosody around 330-375 Hz
    const f0 = 335 + 32 * Math.sin(Math.PI * u) - 14 * u;
    phase += (2 * Math.PI * f0) / sampleRate;

    const env = smoothEnvelope(t, durationSec, 0.07, 0.16);
    // Warm harmonic rolloff
    const harm =
      0.62 * Math.sin(phase) +
      0.26 * Math.sin(2 * phase + 0.15) +
      0.10 * Math.sin(3 * phase + 0.3) +
      0.04 * Math.sin(4 * phase + 0.5);

    // Subtle low-passed organic breath
    const white = rand() * 2 - 1;
    breathState = 0.92 * breathState + 0.08 * white;
    out[i] = 0.42 * env * (harm + 0.015 * breathState);
  }
  return out;
}

/**
 * All-zero silence buffer.
 */
export function genSilence(sampleRate = 24000, durationSec = 0.4) {
  return new Float32Array(Math.max(1, Math.round(sampleRate * durationSec)));
}

/**
 * 15 ms ultra-short smooth pulse.
 */
export function genUltraShort(sampleRate = 24000, durationSec = 0.015) {
  const n = Math.max(1, Math.round(sampleRate * durationSec));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const win = Math.sin((Math.PI * i) / Math.max(1, n - 1));
    out[i] = 0.35 * win * Math.sin(2 * Math.PI * 440 * t);
  }
  return out;
}

/**
 * Hard-clipped flat-top wave.
 */
export function genHardClipped(sampleRate = 24000, durationSec = 0.6, clipLimit = 0.999) {
  const n = Math.max(1, Math.round(sampleRate * durationSec));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = smoothEnvelope(t, durationSec, 0.04, 0.08);
    const raw = 3.8 * env * (Math.sin(2 * Math.PI * 300 * t) + 0.3 * Math.sin(2 * Math.PI * 600 * t));
    out[i] = Math.max(-clipLimit, Math.min(clipLimit, raw));
  }
  return out;
}

/**
 * DC-biased wave (warm signal shifted by a steady DC offset without full-scale clipping).
 */
export function genDcBiased(sampleRate = 24000, durationSec = 0.65, dcOffset = 0.36) {
  const base = genPleasantWarmTone(sampleRate, durationSec, 202);
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    out[i] = Math.max(-0.95, Math.min(0.95, base[i] * 0.6 + dcOffset));
  }
  return out;
}

/**
 * Gentle warm audio with a sharp localized click/spike at clickTimeSec.
 */
export function genLocalizedClick(sampleRate = 24000, durationSec = 0.8, clickTimeSec = 0.4) {
  const out = genPleasantWarmTone(sampleRate, durationSec, 303);
  const idx = Math.min(out.length - 6, Math.max(4, Math.round(clickTimeSec * sampleRate)));
  out[idx] = 0.96;
  out[idx + 1] = -0.94;
  out[idx + 2] = 0.88;
  out[idx + 3] = -0.75;
  return out;
}

/**
 * Stereo phase-inverted pair (R = -L) with pleasant mono content in L.
 */
export function genStereoPhaseInverted(sampleRate = 24000, durationSec = 0.65) {
  const left = genPleasantWarmTone(sampleRate, durationSec, 404);
  const right = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    right[i] = -left[i];
  }
  return [left, right];
}

/**
 * Piercing narrowband ~4 kHz whistle.
 */
export function genPiercingWhistle(sampleRate = 24000, durationSec = 0.7, freqHz = 3950) {
  const n = Math.max(1, Math.round(sampleRate * durationSec));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = smoothEnvelope(t, durationSec, 0.05, 0.1);
    out[i] = 0.48 * env * Math.sin(2 * Math.PI * freqHz * t);
  }
  return out;
}

/**
 * Comb-filtered hollow metallic tone.
 */
export function genCombFiltered(sampleRate = 24000, durationSec = 0.7, delayMs = 4.2, seed = 505) {
  const n = Math.max(1, Math.round(sampleRate * durationSec));
  const delaySamples = Math.max(2, Math.round((delayMs / 1000) * sampleRate));
  const rand = mulberry32(seed);
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = smoothEnvelope(t, durationSec, 0.05, 0.12);
    const tone =
      0.35 * Math.sin(2 * Math.PI * 260 * t) +
      0.25 * Math.sin(2 * Math.PI * 520 * t) +
      0.18 * Math.sin(2 * Math.PI * 780 * t) +
      0.32 * (rand() * 2 - 1);
    src[i] = env * tone;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const delayed = i >= delaySamples ? out[i - delaySamples] : 0;
    out[i] = Math.max(-0.9, Math.min(0.9, 0.38 * src[i] + 0.78 * delayed));
  }
  return out;
}

/**
 * Clockwork metronomic pulses with zero timing variance.
 */
export function genMetronomicPulses(sampleRate = 24000, durationSec = 1.2, periodSec = 0.2) {
  const n = Math.max(1, Math.round(sampleRate * durationSec));
  const out = new Float32Array(n);
  const periodSamples = Math.round(periodSec * sampleRate);
  const pulseLen = Math.round(0.07 * sampleRate);
  for (let start = Math.round(0.04 * sampleRate); start + pulseLen < n; start += periodSamples) {
    for (let j = 0; j < pulseLen; j++) {
      const t = j / sampleRate;
      const env = Math.sin((Math.PI * j) / pulseLen) * Math.exp(-t * 28);
      out[start + j] += 0.55 * env * (Math.sin(2 * Math.PI * 520 * t) + 0.3 * Math.sin(2 * Math.PI * 1040 * t));
    }
  }
  return out;
}

/**
 * Non-vocal pleasant UI chime / electronic celesta pluck.
 */
export function genNonVocalChime(sampleRate = 24000, durationSec = 0.7) {
  const n = Math.max(1, Math.round(sampleRate * durationSec));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const attack = t < 0.018 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.018) : 1;
    const tail = Math.exp(-t * 4.5);
    const tailFade = smoothEnvelope(t, durationSec, 0.005, 0.08);
    const sig =
      0.58 * Math.sin(2 * Math.PI * 587.33 * t) +
      0.26 * Math.sin(2 * Math.PI * 880.0 * t + 0.2) * Math.exp(-t * 2.0) +
      0.14 * Math.sin(2 * Math.PI * 1174.66 * t + 0.4) * Math.exp(-t * 3.5);
    out[i] = 0.44 * attack * tail * tailFade * sig;
  }
  return out;
}

/**
 * Runs `node unkawaii_detector.mjs ...` via child_process.spawnSync.
 */
export function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    timeout: opts.timeout ?? 25000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (res.error) {
    throw res.error;
  }
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// Precomputed IEEE 802.3 CRC32 table for PNG chunk verification
const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

export function computeCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const COLOR_TYPE_CHANNELS = Object.freeze({
  0: 1, // Grayscale
  2: 3, // Truecolor RGB
  3: 1, // Indexed-color
  4: 2, // Grayscale + Alpha
  6: 4, // Truecolor RGBA
});

/**
 * Strict binary PNG validator:
 * - Verifies 8-byte PNG signature
 * - Parses all chunks and validates IEEE CRC32 on every chunk
 * - Asserts IHDR exists first with positive width & height, valid colorType, bitDepth, interlace
 * - Asserts IEND exists last
 * - Concatenates IDAT chunks, verifies zlib.inflateSync succeeds, and checks exact scanline length for 8-bit non-interlaced PNGs
 */
export function assertValidPng(input) {
  assert.ok(input instanceof Uint8Array, "PNG output must be a Buffer or Uint8Array");
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  assert.ok(buf.length >= 33, `PNG too small: ${buf.length} bytes`);
  assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC), "Invalid PNG magic header");

  let offset = 8;
  const chunks = [];
  const idatParts = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let channels = 0;
  let interlace = -1;
  let sawIhdr = false;
  let sawIend = false;

  while (offset < buf.length) {
    assert.ok(offset + 12 <= buf.length, `Truncated PNG chunk header at offset ${offset}`);
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    assert.ok(/^[A-Za-z]{4}$/.test(type), `Invalid PNG chunk type: ${JSON.stringify(type)}`);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= buf.length, `Truncated PNG chunk ${type} at offset ${offset}`);

    const crcInput = buf.subarray(offset + 4, dataEnd);
    const expectedCrc = computeCrc32(crcInput);
    const storedCrc = buf.readUInt32BE(dataEnd);
    assert.equal(
      storedCrc,
      expectedCrc,
      `PNG CRC32 mismatch in chunk ${type} (stored 0x${storedCrc.toString(16)}, expected 0x${expectedCrc.toString(16)})`
    );

    const data = buf.subarray(dataStart, dataEnd);
    chunks.push({ type, length });

    if (type === "IHDR") {
      assert.equal(chunks.length, 1, "IHDR must be the first PNG chunk");
      assert.equal(length, 13, "IHDR chunk length must be 13");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
      assert.ok(width > 0 && height > 0, `Invalid IHDR dimensions: ${width}x${height}`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(COLOR_TYPE_CHANNELS, colorType),
        `Unknown PNG colorType: ${colorType}`
      );
      channels = COLOR_TYPE_CHANNELS[colorType];
      sawIhdr = true;
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      assert.equal(length, 0, "IEND chunk length must be 0");
      sawIend = true;
    }

    offset = dataEnd + 4;
    if (sawIend) break;
  }

  assert.ok(sawIhdr, "PNG missing IHDR chunk");
  assert.ok(sawIend, "PNG missing IEND chunk");
  assert.equal(offset, buf.length, "Unexpected trailing bytes after PNG IEND");
  assert.ok(idatParts.length > 0, "PNG missing IDAT chunk(s)");

  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  assert.ok(inflated.length > 0, "Inflated PNG IDAT stream must be non-empty");
  if (bitDepth === 8 && interlace === 0) {
    const expectedLen = height * (1 + width * channels);
    assert.equal(
      inflated.length,
      expectedLen,
      `Inflated PNG IDAT payload length ${inflated.length} does not match expected ${expectedLen} (${width}x${height}, colorType=${colorType}, channels=${channels})`
    );
  }

  return { width, height, bitDepth, colorType, channels, interlace, chunks, inflatedLength: inflated.length };
}

/**
 * Strict SVG validator:
 * - Verifies <svg ...> root and </svg> closing tag
 * - Verifies zero NaN / Infinity tokens and no "undefined" attribute values
 * - Verifies compact size (< maxBytes, default 50 KB)
 */
export function assertValidSvg(svgStr, { maxBytes = 50 * 1024 } = {}) {
  assert.equal(typeof svgStr, "string", "SVG output must be a string");
  const trimmed = svgStr.trim();
  assert.ok(trimmed.length > 0, "SVG output must be non-empty");
  assert.match(trimmed, /^(<\?xml[^>]*>\s*)?<svg\b/i, "SVG must start with <svg root tag");
  assert.match(trimmed, /<\/svg>\s*$/i, "SVG must end with </svg> closing tag");
  const withoutDataUris = trimmed.replace(/data:[^"'\s)]+/gi, "data:STRIPPED");
  const badNumberRe = /(?:^|[^A-Za-z0-9_]|[MLHVCSQTAZmlhvcsqtaz])(NaN|Infinity)\b/;
  assert.ok(!badNumberRe.test(withoutDataUris), "SVG must not contain NaN or Infinity");
  assert.ok(
    !/=(?:"undefined"|'undefined')/.test(withoutDataUris),
    'SVG must not contain ="undefined" or =\'undefined\' attributes'
  );

  const openTags = (trimmed.match(/<svg\b/gi) ?? []).length;
  const closeTags = (trimmed.match(/<\/svg>/gi) ?? []).length;
  assert.equal(openTags, closeTags, "SVG <svg> and </svg> tag counts must match");

  const byteLen = Buffer.byteLength(svgStr, "utf8");
  assert.ok(
    byteLen < maxBytes,
    `SVG byte length ${byteLen} exceeds compact limit of ${maxBytes} bytes`
  );
  return { byteLen };
}

/**
 * Counts non-trailing-empty lines of text output.
 */
export function countLines(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (normalized.length === 0) return 0;
  return normalized.split("\n").length;
}

/**
 * Asserts every numeric property in an object is finite (no NaN/Infinity).
 */
export function assertAllNumericFinite(obj, context = "object") {
  assert.ok(obj && typeof obj === "object", `${context} must be an object`);
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number") {
      assert.ok(Number.isFinite(v), `${context}.${k} must be finite, got ${v}`);
    }
  }
}

async function tryImport(relPath) {
  const fullPath = path.join(REPO_ROOT, relPath);
  try {
    const mod = await import(pathToFileURL(fullPath).href);
    return { mod, error: null };
  } catch (error) {
    return { mod: null, error };
  }
}

/**
 * Loads documented public API exports from unkawaii_detector.mjs and documented src/ entrypoints
 * using dynamic import() so missing M1-M4 modules fail only their own tests cleanly.
 */
export async function loadPublicApi() {
  const sources = [
    "src/wav.mjs",
    "src/features.mjs",
    "src/falsifiers/index.mjs",
    "src/report.mjs",
    "src/visualize/index.mjs",
    "src/synth.mjs",
    "src/discovery.mjs",
    "unkawaii_detector.mjs",
  ];

  const api = {};
  const errors = {};

  for (const rel of sources) {
    const { mod, error } = await tryImport(rel);
    if (error) {
      errors[rel] = error;
    } else if (mod) {
      for (const [k, v] of Object.entries(mod)) {
        if (!(k in api)) {
          api[k] = v;
        }
      }
    }
  }
  api._importErrors = errors;
  return api;
}

export function requireExport(api, name) {
  if (typeof api[name] === "undefined") {
    const errSummary = Object.entries(api._importErrors ?? {})
      .map(([file, err]) => `${file}: ${err.code || err.message}`)
      .join("; ");
    assert.fail(
      `Documented public export "${name}" is not available yet.` +
        (errSummary ? ` (import errors: ${errSummary})` : "")
    );
  }
  return api[name];
}
