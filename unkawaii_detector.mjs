#!/usr/bin/env node
/**
 * unkawaii_detector.mjs — LLM-Friendly Multidimensional "Unkawaii" Falsifier (v0.1)
 *
 * Philosophy:
 *   "Kawaii" cannot be written completely; "Unkawaii" (signatures of something
 *   you do not want to be with) can be detected across multiple dimensions.
 *   Whatever survives every falsifier without triggering is a Kawaii Candidate.
 *
 * Zero dependencies. Pure JavaScript (ES Module + Node.js CLI).
 *
 * Usage:
 *   node unkawaii_detector.mjs sample.wav
 *   node unkawaii_detector.mjs sample.wav --format json
 *   node unkawaii_detector.mjs --compare natta.wav natta_kata.wav
 *
 * Programmatic API:
 *   import { analyzeSamples, compareReports, formatForLLM, DEFAULT_FALSIFIERS } from "./unkawaii_detector.mjs";
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// 1. Minimal Zero-Dependency WAV Reader (PCM 16-bit / IEEE Float 32-bit)
// ============================================================================
export function decodeWavBuffer(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const str = (off, len) =>
    String.fromCharCode(...new Uint8Array(buffer.buffer, buffer.byteOffset + off, len));

  if (str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") {
    throw new Error("Invalid WAV header: expected RIFF/WAVE");
  }

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const id = str(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error("WAV data chunk not found");

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (bytesPerSample * numChannels));
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const pos = dataOffset + (i * numChannels + ch) * bytesPerSample;
      if (audioFormat === 3 && bitsPerSample === 32) {
        sum += view.getFloat32(pos, true);
      } else if (audioFormat === 1 && bitsPerSample === 16) {
        sum += view.getInt16(pos, true) / 32768;
      } else if (audioFormat === 1 && bitsPerSample === 8) {
        sum += (view.getUint8(pos) - 128) / 128;
      } else {
        throw new Error(`Unsupported WAV format=${audioFormat}, bits=${bitsPerSample}`);
      }
    }
    samples[i] = sum / numChannels;
  }

  return { samples, sampleRate, durationSec: frameCount / sampleRate, numChannels, bitsPerSample };
}

// ============================================================================
// 2. Frame-Level Acoustic & Presence Feature Extractor
// ============================================================================
export function extractFeatures(samples, sampleRate) {
  const n = samples.length;
  const durationSec = n / sampleRate;
  const frameSize = Math.max(256, Math.round(sampleRate * 0.025)); // 25ms
  const hopSize = Math.max(128, Math.round(sampleRate * 0.010));   // 10ms

  let peak = 0;
  let clipCount = 0;
  let maxSampleJump = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a >= 0.995) clipCount++;
    if (i > 0) {
      const jump = Math.abs(samples[i] - samples[i - 1]);
      if (jump > maxSampleJump) maxSampleJump = jump;
    }
  }

  // Normalize copy for scale-invariant envelope & spectral analysis
  const norm = new Float32Array(n);
  const invPeak = peak > 1e-6 ? 1 / peak : 1;
  for (let i = 0; i < n; i++) norm[i] = samples[i] * invPeak;

  const frames = [];
  const minLag = Math.max(2, Math.floor(sampleRate / 650)); // up to 650 Hz
  const maxLag = Math.min(frameSize - 2, Math.floor(sampleRate / 75)); // down to 75 Hz

  for (let start = 0; start + frameSize <= n; start += hopSize) {
    let sumSq = 0;
    let zcr = 0;
    let diffSq = 0; // high-frequency proxy (first difference energy)
    for (let j = 0; j < frameSize; j++) {
      const x = norm[start + j];
      sumSq += x * x;
      if (j > 0) {
        const prev = norm[start + j - 1];
        if ((x >= 0 && prev < 0) || (x < 0 && prev >= 0)) zcr++;
        const d = x - prev;
        diffSq += d * d;
      }
    }
    const rms = Math.sqrt(sumSq / frameSize);
    const zcrRate = zcr / frameSize;
    // Normalized spectral tilt proxy: high-frequency energy ratio
    const hfRatio = sumSq > 1e-8 ? Math.min(1, diffSq / (sumSq * 2.0)) : 0;

    // Autocorrelation for periodicity (voicedness) and F0
    let bestCorr = 0;
    let bestLag = 0;
    if (rms > 0.04) {
      for (let lag = minLag; lag <= maxLag; lag++) {
        let num = 0;
        let denA = 0;
        let denB = 0;
        const limit = frameSize - lag;
        for (let j = 0; j < limit; j++) {
          const a = norm[start + j];
          const b = norm[start + j + lag];
          num += a * b;
          denA += a * a;
          denB += b * b;
        }
        const denom = Math.sqrt(denA * denB);
        const c = denom > 1e-8 ? num / denom : 0;
        if (c > bestCorr) {
          bestCorr = c;
          bestLag = lag;
        }
      }
    }

    const voiced = bestCorr >= 0.55 && rms > 0.05;
    const f0 = voiced && bestLag > 0 ? sampleRate / bestLag : 0;

    frames.push({
      timeSec: (start + frameSize * 0.5) / sampleRate,
      rms,
      zcrRate,
      hfRatio,
      periodicity: bestCorr,
      voiced,
      f0
    });
  }

  // Active frames (above 8% of max RMS)
  const maxRms = frames.reduce((m, f) => Math.max(m, f.rms), 0);
  const activeThresh = Math.max(0.03, maxRms * 0.12);
  const activeIndices = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].rms >= activeThresh) activeIndices.push(i);
  }

  // 1. Envelope attack sharpness (max positive 10ms RMS jump)
  let maxAttackSlope = 0;
  let maxAttackTimeSec = 0;
  for (let i = 1; i < frames.length; i++) {
    const slope = (frames[i].rms - frames[i - 1].rms) / Math.max(maxRms, 1e-6);
    if (slope > maxAttackSlope) {
      maxAttackSlope = slope;
      maxAttackTimeSec = frames[i].timeSec;
    }
  }

  // 2. Mean HF ratio on active frames
  const meanHfRatio = activeIndices.length
    ? activeIndices.reduce((s, idx) => s + frames[idx].hfRatio, 0) / activeIndices.length
    : 0;

  // 3. Voiced ratio & micro-variation (jitter / shimmer)
  const voicedFrames = activeIndices.map(i => frames[i]).filter(f => f.voiced);
  const voicedRatio = activeIndices.length ? voicedFrames.length / activeIndices.length : 0;

  let jitterSum = 0;
  let shimmerSum = 0;
  let pairCount = 0;
  for (let i = 1; i < voicedFrames.length; i++) {
    const prev = voicedFrames[i - 1];
    const curr = voicedFrames[i];
    if (curr.timeSec - prev.timeSec <= 0.025) {
      jitterSum += Math.abs(curr.f0 - prev.f0) / Math.max(prev.f0, 1);
      shimmerSum += Math.abs(curr.rms - prev.rms) / Math.max(prev.rms, 1e-6);
      pairCount++;
    }
  }
  const jitter = pairCount ? jitterSum / pairCount : 0;
  const shimmer = pairCount ? shimmerSum / pairCount : 0;

  // 4. Cross-channel coupling (Common Cause proxy: |corr(rms, hfRatio)| and |corr(rms, f0)|)
  const corrRmsHf = Math.abs(pearson(activeIndices.map(i => frames[i].rms), activeIndices.map(i => frames[i].hfRatio)));
  const corrRmsF0 = voicedFrames.length >= 4
    ? Math.abs(pearson(voicedFrames.map(f => f.rms), voicedFrames.map(f => f.f0)))
    : 0;
  const commonCauseCoupling = Math.max(corrRmsHf, corrRmsF0);

  // 5. Tail decay smoothness (time from last 70% peak down to 12% peak)
  let tailDecaySec = 0;
  let tailStartSec = 0;
  if (activeIndices.length >= 3) {
    const lastActive = activeIndices[activeIndices.length - 1];
    let highIdx = lastActive;
    for (let i = lastActive; i >= activeIndices[0]; i--) {
      if (frames[i].rms >= maxRms * 0.65) {
        highIdx = i;
        break;
      }
    }
    tailStartSec = frames[highIdx].timeSec;
    tailDecaySec = Math.max(0, frames[lastActive].timeSec - frames[highIdx].timeSec);
  }

  return {
    sampleRate,
    durationSec: +durationSec.toFixed(3),
    frameCount: frames.length,
    activeFrameCount: activeIndices.length,
    peak: +peak.toFixed(4),
    clipRatio: +(clipCount / Math.max(n, 1)).toFixed(5),
    maxSampleJump: +maxSampleJump.toFixed(4),
    maxAttackSlope: +maxAttackSlope.toFixed(4),
    maxAttackTimeSec: +maxAttackTimeSec.toFixed(3),
    meanHfRatio: +meanHfRatio.toFixed(4),
    voicedRatio: +voicedRatio.toFixed(4),
    jitter: +jitter.toFixed(5),
    shimmer: +shimmer.toFixed(5),
    commonCauseCoupling: +commonCauseCoupling.toFixed(4),
    tailDecaySec: +tailDecaySec.toFixed(3),
    tailStartSec: +tailStartSec.toFixed(3)
  };
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx;
    const ay = ys[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  const den = Math.sqrt(dx * dy);
  return den > 1e-9 ? num / den : 0;
}

// ============================================================================
// 3. Extensible Multidimensional "Unkawaii" Falsifiers
//    Add new dimensions via falsifiers.push({ id, domain, name, detect(f) })
// ============================================================================
export const DEFAULT_FALSIFIERS = [
  {
    id: "F1_HARSH_EDGE",
    domain: "aggression",
    name: "Sharp Edge / High-Freq Aggression",
    detect(f) {
      const score = +(f.maxAttackSlope * 0.60 + f.meanHfRatio * 0.40).toFixed(3);
      const threshold = 0.42;
      const triggered = score > threshold || f.maxAttackSlope > 0.38;
      return {
        triggered,
        score,
        threshold,
        evidence: `attackSlope=${f.maxAttackSlope} @ ${f.maxAttackTimeSec}s, hfRatio=${f.meanHfRatio}`,
        hint: "Soften glottal attack curvature and deepen high-frequency spectral tilt."
      };
    }
  },
  {
    id: "F2_PURE_ROBOT",
    domain: "absence_of_presence",
    name: "Mechanical Rigidity (Zero Micro-Variation)",
    detect(f) {
      const triggered = f.voicedRatio >= 0.4 && (f.jitter < 0.0005 || (f.jitter < 0.0015 && f.shimmer < 0.012));
      const score = f.voicedRatio >= 0.4 ? +(1 - Math.min(1, f.jitter * 200 + f.shimmer * 25)).toFixed(3) : 0;
      return {
        triggered,
        score,
        threshold: 0.70,
        evidence: `voicedRatio=${f.voicedRatio}, jitter=${f.jitter}, shimmer=${f.shimmer}`,
        hint: "Introduce physical inertia, lung-pressure drift, or 1/f micro-fluctuation."
      };
    }
  },
  {
    id: "F3_PURE_NOISE",
    domain: "absence_of_presence",
    name: "Unstructured Noise (Wind / Static)",
    detect(f) {
      const triggered = f.activeFrameCount === 0 || f.voicedRatio < 0.22;
      const score = +(1 - f.voicedRatio).toFixed(3);
      return {
        triggered,
        score,
        threshold: 0.78,
        evidence: `voicedRatio=${f.voicedRatio} (activeFrames=${f.activeFrameCount})`,
        hint: "Establish coherent periodic vocal-fold / resonant body structure."
      };
    }
  },
  {
    id: "F4_NO_COMMON_CAUSE",
    domain: "absence_of_presence",
    name: "Uncoupled Channels (Hollow / Stitched)",
    detect(f) {
      const triggered = f.activeFrameCount >= 8 && f.commonCauseCoupling < 0.22;
      const score = +(1 - f.commonCauseCoupling).toFixed(3);
      return {
        triggered,
        score,
        threshold: 0.78,
        evidence: `crossChannelCoupling=${f.commonCauseCoupling}`,
        hint: "Couple pitch, breathiness, and amplitude to a single latent physical state (e.g., lung air reservoir)."
      };
    }
  },
  {
    id: "F5_ABRUPT_TAIL",
    domain: "no_arrow_of_time",
    name: "Abrupt Cut-Off Tail (Symbolic / Katakana)",
    detect(f) {
      const triggered = f.activeFrameCount >= 5 && f.tailDecaySec < 0.055;
      const score = +(1 - Math.min(1, f.tailDecaySec / 0.14)).toFixed(3);
      return {
        triggered,
        score,
        threshold: 0.61,
        evidence: `tailDecay=${f.tailDecaySec}s (from ${f.tailStartSec}s)`,
        hint: "Allow phrase tail to release gradually with breath/tension decay instead of hard cut-off."
      };
    }
  },
  {
    id: "F6_PHYSICAL_GLITCH",
    domain: "mechanical_failure",
    name: "Physical Discontinuity / Clipping",
    detect(f) {
      const triggered = f.clipRatio > 0.005 || f.maxSampleJump > 0.85;
      const score = +(Math.min(1, f.clipRatio * 50 + Math.max(0, f.maxSampleJump - 0.5))).toFixed(3);
      return {
        triggered,
        score,
        threshold: 0.35,
        evidence: `clipRatio=${f.clipRatio}, maxSampleJump=${f.maxSampleJump}`,
        hint: "Check waveguide stability, clicks, or output gain normalization."
      };
    }
  }
];

// ============================================================================
// 4. Main Analysis, Comparison & LLM-Friendly Formatter
// ============================================================================
export function analyzeSamples(samples, sampleRate, options = {}) {
  const label = options.label || "untitled";
  const falsifiers = options.falsifiers || DEFAULT_FALSIFIERS;
  const features = extractFeatures(samples, sampleRate);

  const results = falsifiers.map(fn => {
    const out = fn.detect(features);
    return {
      id: fn.id,
      domain: fn.domain,
      name: fn.name,
      ...out
    };
  });

  const triggered = results.filter(r => r.triggered);
  const survived = triggered.length === 0;

  return {
    schema: "unkawaii_report/v0.1",
    label,
    verdict: survived ? "SURVIVED_KAWAII_CANDIDATE" : "REJECTED_UNKAWAII",
    triggeredCount: triggered.length,
    totalFalsifiers: results.length,
    mirrorSummary: survived
      ? "Mirror clear: failed to detect any 'do-not-want-to-be-with' signature across all dimensions."
      : `Mirror reflects: ${triggered.map(t => `${t.id} (${t.name})`).join("; ")}.`,
    features,
    falsifiers: results
  };
}

export function compareReports(reportA, reportB) {
  const deltas = reportA.falsifiers.map((fa, i) => {
    const fb = reportB.falsifiers[i];
    return {
      id: fa.id,
      name: fa.name,
      aScore: fa.score,
      bScore: fb ? fb.score : null,
      deltaBMinusA: fb ? +(fb.score - fa.score).toFixed(3) : null,
      aTriggered: fa.triggered,
      bTriggered: fb ? fb.triggered : null
    };
  });
  return {
    schema: "unkawaii_compare/v0.1",
    a: { label: reportA.label, verdict: reportA.verdict, triggeredCount: reportA.triggeredCount },
    b: { label: reportB.label, verdict: reportB.verdict, triggeredCount: reportB.triggeredCount },
    deltas
  };
}

export function formatForLLM(report) {
  const lines = [
    `[UNKAWAII REPORT] ${report.label}`,
    `VERDICT: ${report.verdict} (${report.triggeredCount}/${report.totalFalsifiers} falsifiers triggered)`,
    `MIRROR: ${report.mirrorSummary}`,
    `OBSERVABLES: dur=${report.features.durationSec}s | attack=${report.features.maxAttackSlope} | hf=${report.features.meanHfRatio} | voiced=${report.features.voicedRatio} | jitter=${report.features.jitter} | coupling=${report.features.commonCauseCoupling} | tail=${report.features.tailDecaySec}s`,
    `DIMENSIONS:`
  ];
  for (const f of report.falsifiers) {
    const mark = f.triggered ? "TRIGGERED" : "clear    ";
    lines.push(`  - [${mark}] ${f.id} (score=${f.score}, thr=${f.threshold}) | ${f.evidence}`);
    if (f.triggered) lines.push(`      hint: ${f.hint}`);
  }
  return lines.join("\n");
}

export function formatCompareForLLM(cmp) {
  const lines = [
    `[UNKAWAII COMPARE] A="${cmp.a.label}" vs B="${cmp.b.label}"`,
    `A: ${cmp.a.verdict} (${cmp.a.triggeredCount} triggered)`,
    `B: ${cmp.b.verdict} (${cmp.b.triggeredCount} triggered)`,
    `DELTAS (B - A; positive = B is MORE unkawaii on that axis):`
  ];
  for (const d of cmp.deltas) {
    const sign = d.deltaBMinusA > 0 ? "+" : "";
    lines.push(`  - ${d.id}: A=${d.aScore}${d.aTriggered ? "*" : ""} -> B=${d.bScore}${d.bTriggered ? "*" : ""} (${sign}${d.deltaBMinusA})`);
  }
  return lines.join("\n");
}

// ============================================================================
// 5. CLI Entrypoint
// ============================================================================
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(
      "Usage:\n" +
      "  node unkawaii_detector.mjs <file.wav> [--format llm|json]\n" +
      "  node unkawaii_detector.mjs --compare <a.wav> <b.wav> [--format llm|json]"
    );
    process.exit(0);
  }

  const fmtIdx = args.indexOf("--format");
  const format = fmtIdx >= 0 ? args[fmtIdx + 1] : "llm";
  const cmpIdx = args.indexOf("--compare");

  if (cmpIdx >= 0) {
    const fileA = args[cmpIdx + 1];
    const fileB = args[cmpIdx + 2];
    if (!fileA || !fileB) throw new Error("--compare requires two WAV paths");
    const wavA = decodeWavBuffer(fs.readFileSync(fileA));
    const wavB = decodeWavBuffer(fs.readFileSync(fileB));
    const repA = analyzeSamples(wavA.samples, wavA.sampleRate, { label: path.basename(fileA) });
    const repB = analyzeSamples(wavB.samples, wavB.sampleRate, { label: path.basename(fileB) });
    const cmp = compareReports(repA, repB);
    console.log(format === "json" ? JSON.stringify(cmp, null, 2) : formatCompareForLLM(cmp));
  } else {
    const file = args.find(a => !a.startsWith("--") && a !== format);
    if (!file) throw new Error("Missing WAV file path");
    const wav = decodeWavBuffer(fs.readFileSync(file));
    const rep = analyzeSamples(wav.samples, wav.sampleRate, { label: path.basename(file) });
    console.log(format === "json" ? JSON.stringify(rep, null, 2) : formatForLLM(rep));
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}