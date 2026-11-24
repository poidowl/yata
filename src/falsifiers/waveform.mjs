/**
 * src/falsifiers/waveform.mjs — Waveform & Dynamics Falsifiers (F7–F11)
 *
 * Covers sub-full-scale flat-top clipping, DC offset bias, micro-clicks/dropouts,
 * brickwall loudness suffocation, and mechanical pumping/tremolo.
 *
 * Zero external dependencies. Pure ES Module.
 */

function num(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function round3(x) {
  return Math.round(clamp01(x) * 1000) / 1000;
}

function resolveThreshold(override, defaultThreshold = 0.5) {
  if (typeof override === "number" && Number.isFinite(override)) {
    return { threshold: override, isNumericOverride: true, opts: null };
  }
  if (override && typeof override === "object") {
    const t =
      typeof override.threshold === "number" && Number.isFinite(override.threshold)
        ? override.threshold
        : defaultThreshold;
    return { threshold: t, isNumericOverride: false, opts: override };
  }
  return { threshold: defaultThreshold, isNumericOverride: false, opts: null };
}

export const WAVEFORM_FALSIFIERS = [
  {
    id: "F7_FLAT_TOP_CLIPPING",
    domain: "mechanical_failure",
    name: "Sub-Full-Scale Flat-Top Clipping",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const exactFlatRatio = num(f.exactFlatRatio);
      const clippedPeakCycles = num(f.clippedPeakCycles);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const flatLim = num(opts?.exactFlatRatio, 0.004);
      const cycleLim = num(opts?.clippedPeakCycles, 4);

      const score =
        activeFrameCount > 0
          ? round3(Math.max(exactFlatRatio / (flatLim * 2), clippedPeakCycles / (cycleLim * 2)))
          : 0;
      const triggered = isNumericOverride
        ? activeFrameCount > 0 && score >= threshold
        : activeFrameCount > 0 && (exactFlatRatio >= flatLim || clippedPeakCycles >= cycleLim);

      return {
        triggered,
        score,
        threshold,
        evidence: `exactFlatRatio=${exactFlatRatio}, clippedPeakCycles=${clippedPeakCycles}`,
        hint: "Remove hard limiter/clipper before output scaling; preserve rounded waveform peaks.",
      };
    },
  },
  {
    id: "F8_DC_OFFSET_BIAS",
    domain: "mechanical_failure",
    name: "DC Offset / Asymmetric Waveform Bias",
    detect(f, override) {
      const dcOffset = num(f.dcOffset);
      const dcToRmsRatio = num(f.dcToRmsRatio);
      const peak = num(f.peak);
      const absDc = Math.abs(dcOffset);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const dcLim = num(opts?.dcOffset, 0.03);
      const ratioLim = num(opts?.dcToRmsRatio, 0.15);

      const score = round3(
        Math.max(absDc / (dcLim * 2), peak > 0.02 ? dcToRmsRatio / (ratioLim * 2) : 0)
      );
      const triggered = isNumericOverride
        ? score >= threshold
        : absDc >= dcLim || (peak > 0.02 && dcToRmsRatio >= ratioLim);

      return {
        triggered,
        score,
        threshold,
        evidence: `dcOffset=${dcOffset}, dcToRmsRatio=${dcToRmsRatio}`,
        hint: "Apply a gentle high-pass DC blocker (20-30 Hz) to center the waveform around zero.",
      };
    },
  },
  {
    id: "F9_MICRO_CLICK_DROPOUT",
    domain: "mechanical_failure",
    name: "Micro-Click Spike or Buffer Dropout",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const clickRatio = num(f.clickRatio);
      const maxClickJump = num(f.maxClickJump);
      const clickTimeSec = num(f.clickTimeSec);
      const dropoutCount = num(f.dropoutCount);
      const dropoutTimeSec = num(f.dropoutTimeSec);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const ratioLim = num(opts?.clickRatio, 14);
      const jumpLim = num(opts?.maxClickJump, 0.22);

      const clickScore =
        maxClickJump >= jumpLim
          ? clamp01(clickRatio / (ratioLim * 2))
          : clamp01((clickRatio / (ratioLim * 2)) * (maxClickJump / Math.max(jumpLim, 1e-6)) * 0.9);
      const dropScore = dropoutCount >= 1 ? clamp01(0.55 + 0.15 * (dropoutCount - 1)) : 0;
      const score = activeFrameCount >= 3 ? round3(Math.max(clickScore, dropScore)) : 0;
      const triggered = isNumericOverride
        ? activeFrameCount >= 3 && score >= threshold
        : activeFrameCount >= 3 && ((clickRatio >= ratioLim && maxClickJump >= jumpLim) || dropoutCount >= 1);

      return {
        triggered,
        score,
        threshold,
        evidence: `clickRatio=${clickRatio}, maxClickJump=${maxClickJump} @ ${clickTimeSec}s, dropouts=${dropoutCount}`,
        hint: "Eliminate sample-level discontinuities, splice clicks, or zero-filled buffer dropouts.",
        where: { startSec: dropoutCount >= 1 ? dropoutTimeSec : clickTimeSec },
      };
    },
  },
  {
    id: "F10_BRICKWALL_SUFFOCATION",
    domain: "dynamics",
    name: "Brickwall Compression / Breathless Loudness",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const crestFactorDb = num(f.crestFactorDb);
      const activeRmsCv = num(f.activeRmsCv);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxCrest = num(opts?.crestFactorDb, 5.5);
      const maxCv = num(opts?.activeRmsCv, 0.14);

      let score = 0;
      if (activeFrameCount >= 12 && crestFactorDb > 0) {
        const crestDeficit = clamp01((maxCrest + 2.0 - crestFactorDb) / 4.0);
        const cvDeficit = clamp01((maxCv + 0.06 - activeRmsCv) / 0.12);
        score = round3(Math.min(crestDeficit, cvDeficit));
      }
      const triggered = isNumericOverride
        ? activeFrameCount >= 12 && score >= threshold
        : activeFrameCount >= 12 && crestFactorDb > 0 && crestFactorDb < maxCrest && activeRmsCv < maxCv;

      return {
        triggered,
        score,
        threshold,
        evidence: `crestFactor=${crestFactorDb}dB, activeRmsCv=${activeRmsCv}`,
        hint: "Relax limiter/compressor ratio to restore dynamic breathing room and transient headroom.",
      };
    },
  },
  {
    id: "F11_PUMPING_TREMOLO",
    domain: "dynamics",
    name: "Mechanical Pumping / Sinusoidal Tremolo",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const depth = num(f.ampModDepth);
      const sinusoidality = num(f.ampModSinusoidality);
      const freqHz = num(f.ampModFreqHz);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minDepth = num(opts?.ampModDepth, 0.22);
      const minSinu = num(opts?.ampModSinusoidality, 0.58);

      let score = 0;
      if (activeFrameCount >= 15) {
        const dScore = clamp01(depth / (minDepth * 2));
        const sScore = clamp01((sinusoidality - (minSinu - 0.42)) / 0.84);
        score = round3(Math.min(dScore, sScore));
      }
      const triggered = isNumericOverride
        ? activeFrameCount >= 15 && score >= threshold
        : activeFrameCount >= 15 && depth >= minDepth && sinusoidality >= minSinu;

      return {
        triggered,
        score,
        threshold,
        evidence: `ampModDepth=${depth}, sinusoidality=${sinusoidality} @ ${freqHz}Hz`,
        hint: "Remove periodic LFO tremolo or sidechain pumping in the 2-16 Hz envelope band.",
        where: freqHz > 0 ? { freqHz } : undefined,
      };
    },
  },
];
