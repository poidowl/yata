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
 * Generate a minimal local counterfactual audio buffer where ONLY [startSec..endSec]
 * is gently smoothed/softened, leaving all samples outside [startSec..endSec]
 * bit-for-bit identical to the input.
 *
 * @param {Float32Array|ArrayLike<number>} samplesInput
 * @param {number} sampleRateInput
 * @param {{
 *   startSec?: number,
 *   endSec?: number,
 *   mode?: "soften_mps" | "lowpass",
 *   windowSec?: number,
 *   crossfadeSec?: number,
 *   cutoffHz?: number,
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

  if (startSec === null || endSec === null) {
    const hotspot = findTimelineHotspot(beforeTimeline);
    if (hotspot) {
      startSec = hotspot.startSec;
      endSec = hotspot.endSec;
    } else {
      startSec = 0;
      endSec = Math.min(durationSec, windowSec);
    }
  }

  startSec = Math.max(0, Math.min(durationSec, startSec));
  endSec = Math.max(startSec, Math.min(durationSec, endSec));

  const startIdx = Math.max(0, Math.min(n, Math.floor(startSec * sampleRate)));
  const endIdx = Math.max(startIdx, Math.min(n, Math.ceil(endSec * sampleRate)));
  const sliceLen = endIdx - startIdx;

  if (sliceLen >= 4) {
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
