import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { extractAudioProfile, extractSegmentTimeline } from "../src/features.mjs";
import { encodeWavBuffer } from "../src/wav.mjs";
import { crc32 } from "../src/visualize/png_encoder.mjs";
import {
  renderPngDiff,
  renderPngVision,
  renderSvgDiff,
  renderSvgVision,
  renderTextDiff,
  renderTextVision,
  renderSegmentTimeline,
} from "../src/visualize/index.mjs";

const SR = 24000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function countLines(text) {
  const norm = String(text ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return norm.length === 0 ? 0 : norm.split("\n").length;
}

function genWarmTone(durationSec = 0.6) {
  const n = Math.round(SR * durationSec);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const u = t / durationSec;
    const f0 = 330 + 30 * Math.sin(Math.PI * u);
    phase += (2 * Math.PI * f0) / SR;
    const env = Math.sin(Math.PI * u);
    out[i] = 0.45 * env * (0.65 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase));
  }
  return out;
}

function genLocalizedClick(durationSec = 0.8, clickSec = 0.4) {
  const out = genWarmTone(durationSec);
  const idx = Math.round(clickSec * SR);
  out[idx] = 0.96;
  out[idx + 1] = -0.94;
  out[idx + 2] = 0.88;
  out[idx + 3] = -0.75;
  return out;
}

function makeMockReport({ label = "sample", triggeredCount = 0 } = {}) {
  const falsifiers = [];
  for (let i = 1; i <= 12; i++) {
    const trig = i <= triggeredCount;
    falsifiers.push({
      id: `F${i}_MOCK_AXIS_${i}`,
      domain: i % 2 === 0 ? "dynamics" : "aggression",
      name: `Mock Axis ${i}`,
      triggered: trig,
      score: trig ? Math.min(1, 0.55 + i * 0.03) : 0.12 + i * 0.01,
      threshold: 0.5,
      evidence: trig ? `Mock anomaly detected on axis ${i}` : `Within bounds on axis ${i}`,
      hint: trig ? `Reduce harshness or artifact on axis ${i}` : "No action needed",
      where: trig ? { startSec: 0.12, endSec: 0.28, freqHz: 1200 + i * 200 } : undefined,
    });
  }
  return {
    schema: "unkawaii_report/v0.2",
    label,
    verdict: triggeredCount > 0 ? "REJECTED_UNKAWAII" : "SURVIVED_KAWAII_CANDIDATE",
    triggeredCount,
    totalFalsifiers: falsifiers.length,
    mirrorSummary: triggeredCount > 0 ? "Rejected by mock axes" : "Survived all mock axes",
    features: { peak: 0.45, medianF0: 345, meanVoicedHnrDb: 22.5, meanHfRatio: 0.08 },
    falsifiers,
  };
}

function verifyPngBuffer(buf) {
  assert.ok(Buffer.isBuffer(buf), "PNG must be a Buffer");
  assert.ok(buf.length >= 33, "PNG too small");
  assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC), "Invalid PNG signature");

  let off = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;
  const idats = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const storedCrc = buf.readUInt32BE(off + 8 + len);
    const expectedCrc = crc32(buf.subarray(off + 4, off + 8 + len));
    assert.equal(storedCrc, expectedCrc, `CRC32 mismatch on chunk ${type}`);

    if (type === "IHDR") {
      sawIhdr = true;
      assert.equal(len, 13);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.ok(width >= 100 && height >= 100, `Unexpected PNG size: ${width}x${height}`);
      assert.equal(data[8], 8); // 8-bit
      assert.equal(data[9], 6); // RGBA
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      sawIend = true;
      assert.equal(len, 0);
    }
    off += 12 + len;
  }

  assert.ok(sawIhdr, "Missing IHDR");
  assert.ok(sawIend, "Missing IEND");
  assert.equal(off, buf.length, "Trailing bytes after IEND");
  assert.ok(idats.length > 0, "Missing IDAT");

  const inflated = zlib.inflateSync(Buffer.concat(idats));
  assert.equal(inflated.length, height * (1 + width * 4), "Inflated scanline byte length mismatch");
  return { width, height };
}

function verifySvgString(svg, maxBytes = 50 * 1024) {
  assert.equal(typeof svg, "string");
  const trimmed = svg.trim();
  assert.match(trimmed, /^<svg\b/);
  assert.match(trimmed, /<\/svg>$/);
  const withoutDataUris = trimmed.replace(/data:[^"'\s)]+/gi, "data:STRIPPED");
  assert.ok(!/(?:^|[^A-Za-z0-9_])(NaN|Infinity)\b/.test(withoutDataUris), "SVG contains NaN/Infinity");
  assert.ok(!/=(?:"undefined"|'undefined')/.test(withoutDataUris), "SVG contains undefined attr");
  assert.equal((trimmed.match(/<svg\b/g) ?? []).length, (trimmed.match(/<\/svg>/g) ?? []).length);
  const bytes = Buffer.byteLength(svg, "utf8");
  assert.ok(bytes < maxBytes, `SVG ${bytes} bytes exceeds ${maxBytes}`);
  return { bytes };
}

describe("M3: LLM Audio Vision (Text / SVG / PNG)", () => {
  const warmSamples = genWarmTone(0.6);
  const clickSamples = genLocalizedClick(0.8, 0.4);
  const warmProfile = extractAudioProfile(warmSamples, SR);
  const clickProfile = extractAudioProfile(clickSamples, SR);
  const cleanReport = makeMockReport({ label: "warm_clean", triggeredCount: 0 });
  const rejectedReport = makeMockReport({ label: "heavy_reject", triggeredCount: 10 });

  it("enforces micro <= 15 lines and compact <= 32 lines for both clean and heavily rejected audio", () => {
    for (const rep of [cleanReport, rejectedReport]) {
      const micro = renderTextVision(warmProfile, rep, { mode: "micro" });
      const microN = countLines(micro);
      assert.ok(microN > 0 && microN <= 15, `micro lines=${microN} for ${rep.label}`);

      const compact = renderTextVision(warmProfile, rep, { mode: "compact" });
      const compactN = countLines(compact);
      assert.ok(compactN > 0 && compactN <= 32, `compact lines=${compactN} for ${rep.label}`);

      const full = renderTextVision(warmProfile, rep, { mode: "full" });
      assert.ok(countLines(full) > compactN, "full mode should be more detailed than compact");
      assert.notEqual(micro, full);
    }
  });

  it("supports ascii vs unicode charsets distinctly", () => {
    const asciiOut = renderTextVision(warmProfile, cleanReport, { mode: "compact", charset: "ascii" });
    const unicodeOut = renderTextVision(warmProfile, cleanReport, { mode: "compact", charset: "unicode" });
    assert.notEqual(asciiOut, unicodeOut);
    assert.ok(!/[^\x00-\x7f]/.test(asciiOut), "ascii mode should only contain 7-bit ASCII");
    assert.ok(/[^\x00-\x7f]/.test(unicodeOut), "unicode mode should contain non-ASCII glyphs");
  });

  it("supports zoom: 'auto' on localized click (t=0.40s) and explicit zoom windows", () => {
    const base = renderTextVision(clickProfile, cleanReport, { mode: "compact", zoom: null });
    const autoZoom = renderTextVision(clickProfile, cleanReport, { mode: "compact", zoom: "auto" });
    const strZoom = renderTextVision(clickProfile, cleanReport, { mode: "compact", zoom: "0.10..0.40" });
    const objZoom = renderTextVision(clickProfile, cleanReport, {
      mode: "compact",
      zoom: { startSec: 0.2, endSec: 0.5 },
    });

    assert.ok(countLines(autoZoom) <= 32);
    assert.notEqual(autoZoom, base);
    assert.notEqual(strZoom, base);
    assert.notEqual(objZoom, base);
    assert.match(autoZoom, /ZOOM:/);
    // Verify auto-zoom references a time near 0.40s
    const matches = [...autoZoom.matchAll(/(\d+\.\d{1,3})s/g)].map((m) => Number.parseFloat(m[1]));
    assert.ok(
      matches.some((t) => t >= 0.2 && t <= 0.6),
      `autoZoom should reference window near 0.40s, got ${JSON.stringify(matches)}`
    );
    assert.match(strZoom, /0\.10s\.\.0\.40s/);
    assert.match(objZoom, /0\.20s\.\.0\.50s/);
  });

  it("renders valid compact SVG (< 50 KB) with embedded PNG spectrogram for vision and diff", () => {
    const specialReport = makeMockReport({ label: 'a<b>&"c\'', triggeredCount: 4 });
    const svg = renderSvgVision(warmProfile, specialReport);
    verifySvgString(svg, 50 * 1024);
    assert.match(svg, /data:image\/png;base64,/);

    const diffSvg = renderSvgDiff(warmProfile, clickProfile, cleanReport, rejectedReport);
    verifySvgString(diffSvg, 50 * 1024);
    assert.match(diffSvg, /data:image\/png;base64,/);
  });

  it("renders valid binary PNG buffers for vision and diff", () => {
    const png = renderPngVision(warmProfile, rejectedReport);
    const meta = verifyPngBuffer(png);
    assert.equal(meta.width, 960);
    assert.equal(meta.height, 640);

    const diffPng = renderPngDiff(warmProfile, clickProfile, cleanReport, rejectedReport);
    const diffMeta = verifyPngBuffer(diffPng);
    assert.equal(diffMeta.width, 960);
    assert.equal(diffMeta.height, 640);
  });

  it("renders A/B text diff with falsifier deltas in ascii and unicode", () => {
    const diffAscii = renderTextDiff(warmProfile, clickProfile, cleanReport, rejectedReport, {
      charset: "ascii",
    });
    const diffUnicode = renderTextDiff(warmProfile, clickProfile, cleanReport, rejectedReport, {
      charset: "unicode",
    });
    assert.match(diffAscii, /NEW IN B/);
    assert.match(diffAscii, /F1_MOCK_AXIS_1/);
    assert.notEqual(diffAscii, diffUnicode);
    assert.ok(/[^\x00-\x7f]/.test(diffUnicode));
  });

  it("handles silence, ultra-short audio, and null report gracefully without NaN", () => {
    const silenceProf = extractAudioProfile(new Float32Array(SR * 0.2), SR);
    const shortProf = extractAudioProfile(new Float32Array(Math.round(SR * 0.015)), SR);

    for (const prof of [silenceProf, shortProf]) {
      const txt = renderTextVision(prof, null, { mode: "compact", zoom: "auto" });
      assert.ok(countLines(txt) > 0 && countLines(txt) <= 32);
      assert.ok(!/\bNaN\b/.test(txt));
      verifySvgString(renderSvgVision(prof, null));
      verifyPngBuffer(renderPngVision(prof, null));
    }
  });

  it("v0.4: 8-row compact text MEL spectrogram covers down to ~60 Hz within 32-line budget", () => {
    const compact = renderTextVision(warmProfile, cleanReport, { mode: "compact", charset: "ascii" });
    assert.ok(countLines(compact) <= 32, `compact exceeded 32 lines: ${countLines(compact)}`);
    const lines = compact.split("\n");
    const melHeaderIdx = lines.findIndex((l) => l.startsWith("MEL ("));
    assert.ok(melHeaderIdx >= 0, "Expected MEL header in compact vision");
    const lowestRow = lines[melHeaderIdx + 8];
    assert.ok(lowestRow, "Expected 8th MEL row");
    const m = /^\s*(\d+)\s*\|/.exec(lowestRow);
    assert.ok(m, `Expected numeric low-frequency label on lowest MEL row, got: ${lowestRow}`);
    const lowestHz = Number.parseInt(m[1], 10);
    assert.ok(
      lowestHz >= 45 && lowestHz <= 90,
      `Expected lowest MEL row label around ~60 Hz (45..90 Hz), got ${lowestHz} Hz`
    );
  });

  it("v0.5: surfaces MPS30-150 and SUBH in compact/micro headers within line budgets", () => {
    const richRep = {
      ...cleanReport,
      features: { ...cleanReport.features, mpsRoughness30_150: 0.24, subharmonicRatio: 0.31 },
    };
    const micro = renderTextVision(warmProfile, richRep, { mode: "micro", charset: "ascii" });
    const compact = renderTextVision(warmProfile, richRep, { mode: "compact", charset: "ascii" });
    assert.ok(countLines(micro) <= 15);
    assert.ok(countLines(compact) <= 32);
    assert.match(micro, /MPS30-150=0\.24/);
    assert.match(micro, /SUBH=0\.31/);
    assert.match(compact, /MPS30-150=0\.24/);
    assert.match(compact, /SUBH=0\.31/);
  });

  it("v0.5: extractSegmentTimeline, renderSegmentTimeline, and CLI --timeline distinguish clean first half vs rough 70 Hz AM second half", () => {
    const dur = 2.0;
    const n = Math.round(SR * dur);
    const half = n >> 1;
    const mixed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      if (i < half) {
        // Clean warm voice modulated gently at 4 Hz (speech rhythm)
        const env = 0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t);
        mixed[i] = 0.45 * env * (0.7 * Math.sin(2 * Math.PI * 330 * t) + 0.25 * Math.sin(2 * Math.PI * 660 * t));
      } else {
        // Rough 70 Hz AM scream/alarm roughness in second half
        const am = 0.5 * (1 + 0.95 * Math.sin(2 * Math.PI * 70 * t));
        mixed[i] = 0.55 * am * (0.6 * Math.sin(2 * Math.PI * 820 * t) + 0.4 * Math.sin(2 * Math.PI * 1240 * t));
      }
    }

    const prof = extractAudioProfile(mixed, SR);
    const tl = extractSegmentTimeline(prof, mixed, SR, { windowSec: 0.5 });
    assert.equal(tl.segments.length, 4);

    const firstHalfMps = 0.5 * (tl.segments[0].mpsRoughness30_150 + tl.segments[1].mpsRoughness30_150);
    const secondHalfMps = 0.5 * (tl.segments[2].mpsRoughness30_150 + tl.segments[3].mpsRoughness30_150);
    assert.ok(
      secondHalfMps > firstHalfMps * 4 && secondHalfMps > 0.12,
      `Expected rough second half MPS (${secondHalfMps}) >> clean first half MPS (${firstHalfMps})`
    );

    const rendered = renderSegmentTimeline(tl, { charset: "ascii" });
    assert.equal(countLines(rendered), 4, "Segment timeline should be ultra-compact 4 lines");
    assert.match(rendered, /\[YATA TIMELINE\]/);
    assert.match(rendered, /PRES/);
    assert.match(rendered, /MPS30-150/);

    // Verify CLI --timeline flag
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yata-tl-"));
    try {
      const wavPath = path.join(tmpDir, "two_half.wav");
      fs.writeFileSync(wavPath, encodeWavBuffer(mixed, SR));
      const cliPath = path.resolve("unkawaii_detector.mjs");
      const out = execFileSync(process.execPath, [cliPath, wavPath, "--timeline"], { encoding: "utf8" });
      assert.match(out, /\[YATA TIMELINE\]/);
      assert.match(out, /MPS30-150/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
