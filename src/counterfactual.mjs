/**
 * src/counterfactual.mjs — Minimal Local Counterfactual Audio Mirror (v0.6)
 *
 * Identifies the single 0.5s hotspot window in a timeline and synthesizes a minimal
 * local counterfactual where ONLY [startSec..endSec] is gently softened (zero-phase
 * 1-pole low-pass + 30–150 Hz envelope-roughness damping with raised-cosine crossfades),
 * leaving all samples outside [startSec..endSec] bit-for-bit identical.
 *
 * Zero external dependencies. Pure ES Module.
 */

import { extractSegmentTimeline } from "./features.mjs";
import { renderTimelineDiff } from "./visualize/ascii.mjs";

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function roundTo(v, digits) {
  const f = finite(v, 0);
  const scale = Math.pow(10, digits);
  return Math.round(f * scale) / scale;
}

/**
 * Zero-phase (forward + backward) 1-pole exponential low-pass filter.
 * Unconditionally stable with zero group delay / phase shift.
 */
function lowPassZeroPhase(sig, sampleRate, cutoffHz) {
  const n = sig.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const fc = Math.max(1, Math.min(sampleRate * 0.45, finite(cutoffHz, 2400)));
  const alpha = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);

  const fwd = new Float32Array(n);
  fwd[0] = sig[0];
  for (let i = 1; i < n; i++) {
    fwd[i] = fwd[i - 1] + alpha * (sig[i] - fwd[i - 1]);
  }

  out[n - 1] = fwd[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    out[i] = out[i + 1] + alpha * (fwd[i] - out[i + 1]);
  }
  return out;
}

/**
 * Identify the single hotspot window in an extractSegmentTimeline result:
 * highest `mpsRoughness30_150`, with fallback to highest `rms` if all MPS are 0.
 *
 * @param {object} timeline - Output of extractSegmentTimeline
 * @returns {{ index: number, startSec: number, endSec: number, reason: string, mpsRoughness30_150: number, rms: number, presence: number } | null}
 */
export function findTimelineHotspot(timeline) {
  const segs = Array.isArray(timeline?.segments) ? timeline.segments : [];
  if (segs.length === 0) return null;

  let bestMpsIdx = -1;
  let bestMps = 0;
  let bestRmsIdx = 0;
  let bestRms = -1;

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const mps = finite(s?.mpsRoughness30_150, 0);
    const rms = finite(s?.rms, 0);
    if (mps > bestMps) {
      bestMps = mps;
      bestMpsIdx = i;
    }
    if (rms > bestRms) {
      bestRms = rms;
      bestRmsIdx = i;
    }
  }

  const useMps = bestMpsIdx >= 0 && bestMps > 0;
  const idx = useMps ? bestMpsIdx : bestRmsIdx;
  const seg = segs[idx];

  return {
    index: idx,
    startSec: finite(seg.startSec, 0),
    endSec: finite(seg.endSec, 0),
    reason: useMps ? "mps_roughness" : "peak_rms",
    mpsRoughness30_150: finite(seg.mpsRoughness30_150, 0),
    rms: finite(seg.rms, 0),
    presence: finite(seg.presence, 0),
  };
}

/**
 * Deterministic Mulberry32 PRNG for reproducible organic breath-air synthesis.
 */
function makeSeededRng(seed = 0x59415441) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Find the sample index where the last active phrase ends (RMS >= max(0.03, maxRms * 0.12)).
 */
function findLastActiveCutoffSample(src, sampleRate) {
  const n = src.length;
  const frameLen = Math.max(64, Math.round(sampleRate * 0.02));
  const hopLen = Math.max(32, Math.round(sampleRate * 0.01));
  if (n < frameLen) return { cutIdx: n, maxRms: 0, endRms: 0 };

  const rmsList = [];
  let maxRms = 0;
  for (let s = 0; s + frameLen <= n; s += hopLen) {
    let sq = 0;
    for (let j = 0; j < frameLen; j++) {
      const x = src[s + j];
      sq += x * x;
    }
    const r = Math.sqrt(sq / frameLen);
    rmsList.push({ start: s, end: s + frameLen, rms: r });
    if (r > maxRms) maxRms = r;
  }

  if (maxRms < 1e-4) return { cutIdx: 0, maxRms: 0, endRms: 0 };

  const thresh = Math.max(0.03, maxRms * 0.12);
  let lastActive = -1;
  for (let i = rmsList.length - 1; i >= 0; i--) {
    if (rmsList[i].rms >= thresh) {
      lastActive = i;
      break;
    }
  }
  if (lastActive < 0) return { cutIdx: 0, maxRms, endRms: 0 };

  // Refine exact cutoff sample inside the last active frame (avoid cutting mid-silence)
  const frame = rmsList[lastActive];
  const sampleThresh = Math.max(0.005, maxRms * 0.05);
  let cutIdx = frame.end;
  for (let i = Math.min(n - 1, frame.end + hopLen); i >= frame.start; i--) {
    if (Math.abs(src[i]) >= sampleThresh) {
      cutIdx = Math.min(n, i + 1);
      break;
    }
  }
  return { cutIdx, maxRms, endRms: frame.rms };
}

/**
 * Generate a minimal local counterfactual audio buffer where ONLY [startSec..endSec]
 * is gently smoothed/softened, leaving all samples outside [startSec..endSec]
 * bit-for-bit identical to the input.
 *
 * Modes:
 *   - "soften_mps" (default): zero-phase low-pass + 30–150 Hz envelope-roughness damping
 *   - "lowpass": zero-phase low-pass only
 *   - "breath_tail": gentle exponential release taper + faint organic breath-air decay (~0.18s)
 *     at the end of an abruptly cut active phrase (zero clicks)
 *
 * @param {Float32Array|ArrayLike<number>} samplesInput
 * @param {number} sampleRateInput
 * @param {{
 *   startSec?: number,
 *   endSec?: number,
 *   mode?: "soften_mps" | "lowpass" | "breath_tail",
 *   windowSec?: number,
 *   crossfadeSec?: number,
 *   cutoffHz?: number,
 *   tailDurationSec?: number,
 *   charset?: "ascii" | "unicode",
 * }} [opts={}]
 */
export function generateCounterfactualSlice(samplesInput, sampleRateInput, opts = {}) {
  const sampleRate = Number.isFinite(sampleRateInput) && sampleRateInput > 0 ? sampleRateInput : 24000;
  const src = samplesInput instanceof Float32Array
    ? samplesInput
    : Float32Array.from(samplesInput ?? []);
  const n = src.length;
  const durationSec = n / sampleRate;

  const mode = opts.mode || "soften_mps";
  const windowSec = Math.max(0.1, Math.min(5.0, finite(opts.windowSec, 0.5)));
  const crossfadeSec = Math.max(0.002, Math.min(0.25, finite(opts.crossfadeSec, 0.025)));
  const cutoffHz = Math.max(200, Math.min(sampleRate * 0.45, finite(opts.cutoffHz, 2400)));
  const tailDurationSec = Math.max(0.05, Math.min(0.5, finite(opts.tailDurationSec, 0.18)));
  const charset = opts.charset === "unicode" ? "unicode" : "ascii";

  const beforeTimeline = extractSegmentTimeline(null, src, sampleRate, { windowSec });

  const out = new Float32Array(src);
  if (n === 0 || durationSec <= 0) {
    const afterTimeline = extractSegmentTimeline(null, out, sampleRate, { windowSec });
    return {
      samples: out,
      sampleRate,
      window: { startSec: 0, endSec: 0 },
      mode,
      beforeTimeline,
      afterTimeline,
      timelineDiff: renderTimelineDiff(beforeTimeline, afterTimeline, { charset }),
    };
  }

  let startSec = Number.isFinite(opts.startSec) ? opts.startSec : null;
  let endSec = Number.isFinite(opts.endSec) ? opts.endSec : null;
  let autoCutInfo = null;

  if (startSec === null || endSec === null) {
    if (mode === "breath_tail") {
      autoCutInfo = findLastActiveCutoffSample(src, sampleRate);
      if (autoCutInfo.cutIdx > 0 && autoCutInfo.maxRms >= 1e-4) {
        const afterSamples = n - autoCutInfo.cutIdx;
        if (afterSamples >= Math.round(0.04 * sampleRate)) {
          const preSamples = Math.min(autoCutInfo.cutIdx, Math.round(0.04 * sampleRate));
          const postSamples = Math.min(afterSamples, Math.round(tailDurationSec * sampleRate));
          startSec = (autoCutInfo.cutIdx - preSamples) / sampleRate;
          endSec = (autoCutInfo.cutIdx + postSamples) / sampleRate;
        } else {
          const tailSamples = Math.min(autoCutInfo.cutIdx, Math.round(tailDurationSec * sampleRate));
          startSec = (autoCutInfo.cutIdx - tailSamples) / sampleRate;
          endSec = autoCutInfo.cutIdx / sampleRate;
        }
      } else {
        startSec = 0;
        endSec = Math.min(durationSec, tailDurationSec);
      }
    } else {
      const hotspot = findTimelineHotspot(beforeTimeline);
      if (hotspot) {
        startSec = hotspot.startSec;
        endSec = hotspot.endSec;
      } else {
        startSec = 0;
        endSec = Math.min(durationSec, windowSec);
      }
    }
  }

  startSec = Math.max(0, Math.min(durationSec, startSec));
  endSec = Math.max(startSec, Math.min(durationSec, endSec));

  const startIdx = Math.max(0, Math.min(n, Math.floor(startSec * sampleRate)));
  const endIdx = Math.max(startIdx, Math.min(n, Math.ceil(endSec * sampleRate)));
  const sliceLen = endIdx - startIdx;

  if (sliceLen >= 4 && mode === "breath_tail") {
    const cutInfo = autoCutInfo ?? findLastActiveCutoffSample(src, sampleRate);
    const localCut =
      cutInfo.cutIdx > startIdx && cutInfo.cutIdx < endIdx
        ? cutInfo.cutIdx - startIdx
        : sliceLen;

    // Measure ending active RMS just before localCut
    const refLen = Math.min(localCut, Math.max(16, Math.round(0.03 * sampleRate)));
    let refSq = 0;
    for (let i = Math.max(0, localCut - refLen); i < localCut; i++) {
      const x = src[startIdx + i];
      refSq += x * x;
    }
    const endRms = refLen > 0 ? Math.sqrt(refSq / refLen) : cutInfo.endRms;

    if (endRms > 1e-4) {
      // Synthesize deterministic warm band-limited breath-air (zero-phase LP ~2000 Hz minus LP ~220 Hz)
      const rng = makeSeededRng(0x59415441 ^ sliceLen);
      const rawNoise = new Float32Array(sliceLen);
      for (let i = 0; i < sliceLen; i++) {
        rawNoise[i] = (rng() * 2 - 1) * 0.5 + (rng() * 2 - 1) * 0.5;
      }
      const lpHi = lowPassZeroPhase(rawNoise, sampleRate, Math.min(2000, sampleRate * 0.4));
      const lpLo = lowPassZeroPhase(rawNoise, sampleRate, Math.min(220, sampleRate * 0.1));
      const air = new Float32Array(sliceLen);
      let airSq = 0;
      for (let i = 0; i < sliceLen; i++) {
        const v = lpHi[i] - lpLo[i];
        air[i] = v;
        airSq += v * v;
      }
      const airRms = Math.sqrt(airSq / sliceLen);
      const breathAmp = Math.min(0.16, Math.max(0.02, endRms * 0.25));
      const airScale = airRms > 1e-6 ? breathAmp / airRms : 0;

      const fadeInAir = Math.min(Math.round(0.02 * sampleRate), Math.max(2, Math.floor(sliceLen * 0.2)));
      const fadeOutAir = Math.min(Math.round(0.02 * sampleRate), Math.max(2, Math.floor(sliceLen * 0.2)));

      for (let i = 0; i < sliceLen; i++) {
        // 1. Soft exponential release taper of the original active phrase (zero clicks at both ends)
        let sigPart = 0;
        if (i < localCut) {
          const u = localCut > 1 ? i / (localCut - 1) : 1;
          const taper = 0.5 * (1 + Math.cos(Math.PI * u)) * Math.exp(-1.5 * u);
          sigPart = src[startIdx + i] * taper;
        }

        // 2. Faint organic breath-air decay across the release window
        let envAir = 1;
        if (i < fadeInAir) {
          envAir = 0.5 * (1 - Math.cos((Math.PI * i) / fadeInAir));
        } else {
          const decayU = (i - fadeInAir) / Math.max(1, sliceLen - fadeInAir);
          envAir = Math.exp(-3.0 * decayU);
        }
        if (i >= sliceLen - fadeOutAir) {
          const k = sliceLen - 1 - i;
          envAir *= 0.5 * (1 - Math.cos((Math.PI * k) / fadeOutAir));
        }

        const val = sigPart + air[i] * airScale * envAir;
        out[startIdx + i] = Math.max(-0.98, Math.min(0.98, val));
      }
    }
  } else if (sliceLen >= 4) {
    // Include up to 25ms context padding on both sides for artifact-free zero-phase filtering
    const padSamples = Math.min(Math.round(0.025 * sampleRate), n);
    const padStart = Math.max(0, startIdx - padSamples);
    const padEnd = Math.min(n, endIdx + padSamples);
    const innerOffset = startIdx - padStart;
    const padded = src.subarray(padStart, padEnd);

    // 1. Zero-phase 1-pole low-pass to soften sharp high-frequency edge
    let proc = lowPassZeroPhase(padded, sampleRate, cutoffHz);

    // 2. Gentle 30–150 Hz envelope-roughness damping (preserves 4–16 Hz speech rhythm)
    if (mode !== "lowpass") {
      const m = proc.length;
      const rect = new Float32Array(m);
      for (let i = 0; i < m; i++) rect[i] = Math.abs(proc[i]);

      const envFast = lowPassZeroPhase(rect, sampleRate, 160);
      const envSlow = lowPassZeroPhase(rect, sampleRate, 16);

      let meanSlow = 0;
      for (let i = 0; i < sliceLen; i++) meanSlow += envSlow[innerOffset + i];
      meanSlow /= sliceLen;

      if (meanSlow > 1e-5) {
        const eps = meanSlow * 0.12;
        const damped = new Float32Array(m);
        const strength = 0.88;
        for (let i = 0; i < m; i++) {
          const ratio = Math.max(0.28, Math.min(2.2, (envSlow[i] + eps) / (envFast[i] + eps)));
          const gain = 1 + strength * (ratio - 1);
          damped[i] = proc[i] * gain;
        }
        proc = damped;
      }
    }

    // Match RMS of processed slice to original slice RMS (capped to prevent clipping)
    let origSq = 0;
    let procSq = 0;
    let origPeak = 0;
    let procPeak = 0;
    for (let i = 0; i < sliceLen; i++) {
      const o = src[startIdx + i];
      const p = proc[innerOffset + i];
      origSq += o * o;
      procSq += p * p;
      const ao = Math.abs(o);
      const ap = Math.abs(p);
      if (ao > origPeak) origPeak = ao;
      if (ap > procPeak) procPeak = ap;
    }

    let rmsScale = procSq > 1e-12 ? Math.sqrt(origSq / procSq) : 1;
    const peakCeiling = Math.min(0.98, Math.max(origPeak, 0.92));
    if (procPeak * rmsScale > peakCeiling && procPeak > 1e-9) {
      rmsScale = peakCeiling / procPeak;
    }

    // Blend ONLY inside [startIdx..endIdx] with raised-cosine crossfades (w=0 at both ends)
    const fadeSamples = Math.min(Math.round(crossfadeSec * sampleRate), Math.floor(sliceLen / 2));
    for (let i = 0; i < sliceLen; i++) {
      let w = 1;
      if (fadeSamples > 0 && i < fadeSamples) {
        w = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
      } else if (fadeSamples > 0 && i >= sliceLen - fadeSamples) {
        const k = sliceLen - 1 - i;
        w = 0.5 * (1 - Math.cos((Math.PI * k) / fadeSamples));
      }
      const orig = src[startIdx + i];
      const softened = proc[innerOffset + i] * rmsScale;
      out[startIdx + i] = orig * (1 - w) + softened * w;
    }
  }

  const afterTimeline = extractSegmentTimeline(null, out, sampleRate, { windowSec });
  const timelineDiff = renderTimelineDiff(beforeTimeline, afterTimeline, { charset });

  return {
    samples: out,
    sampleRate,
    window: {
      startSec: roundTo(startSec, 3),
      endSec: roundTo(endSec, 3),
    },
    mode,
    beforeTimeline,
    afterTimeline,
    timelineDiff,
  };
}
