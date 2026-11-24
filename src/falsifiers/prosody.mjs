/**
 * src/falsifiers/prosody.mjs — Prosody, Control, Artifice, Rebound & Cadence Falsifiers (F21–F27)
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

export const PROSODY_FALSIFIERS = [
  {
    id: "F21_NOISY_HNR_SWAMP",
    domain: "absence_of_presence",
    name: "Noisy HNR Swamp (Muddy Breathy Voicing)",
    detect(f, override) {
      const voicedFrameCount = num(f.voicedFrameCount);
      const hnrDb = num(f.meanVoicedHnrDb);
      const flatness = num(f.meanSpectralFlatness);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxHnrDb = num(opts?.meanVoicedHnrDb, 5.5);
      const minFlat = num(opts?.meanSpectralFlatness, 0.1);

      let score = 0;
      if (voicedFrameCount >= 8) {
        const hnrDeficit = clamp01((maxHnrDb + 4.0 - hnrDb) / 8.0);
        const flatScore = clamp01(flatness / (minFlat * 2));
        score = round3(Math.min(hnrDeficit, flatScore));
      }
      const triggered = isNumericOverride
        ? voicedFrameCount >= 8 && score >= threshold
        : voicedFrameCount >= 8 && hnrDb < maxHnrDb && flatness >= minFlat;

      return {
        triggered,
        score,
        threshold,
        evidence: `voicedHNR=${hnrDb}dB, spectralFlatness=${flatness}`,
        hint: "Improve harmonic-to-noise ratio by denoising background static or strengthening periodic resonance.",
      };
    },
  },
  {
    id: "F22_MONOTONE_FLAT_PROSODY",
    domain: "absence_of_presence",
    name: "Monotone Flat Pitch Contour",
    detect(f, override) {
      const voicedDurationSec = num(f.voicedDurationSec);
      const voicedFrameCount = num(f.voicedFrameCount);
      const f0Range = num(f.f0RangeSemitones);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minRange = num(opts?.f0RangeSemitones, 0.55);

      const eligible = voicedDurationSec >= 0.4 && voicedFrameCount >= 35;
      const score = eligible ? round3(clamp01((minRange * 2 - f0Range) / (minRange * 2))) : 0;
      const triggered = isNumericOverride
        ? eligible && score >= threshold
        : eligible && f0Range < minRange;

      return {
        triggered,
        score,
        threshold,
        evidence: `f0Range=${f0Range}st over ${voicedDurationSec}s voiced`,
        hint: "Add gentle natural pitch inflection (rise/fall arc) instead of holding a flat monotone.",
      };
    },
  },
  {
    id: "F23_ERRATIC_PITCH_WARBLE",
    domain: "broken_control",
    name: "Erratic Pitch Warble / Unstable Control",
    detect(f, override) {
      const voicedFrameCount = num(f.voicedFrameCount);
      const diff1 = num(f.f0MeanAbsDiffSemi);
      const diff2 = num(f.f0SecondDiffSemi);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minDiff1 = num(opts?.f0MeanAbsDiffSemi, 0.45);
      const minDiff2 = num(opts?.f0SecondDiffSemi, 0.55);

      let score = 0;
      if (voicedFrameCount >= 10) {
        const d1 = clamp01(diff1 / (minDiff1 * 2));
        const d2 = clamp01(diff2 / (minDiff2 * 2));
        score = round3(Math.min(d1, d2));
      }
      const triggered = isNumericOverride
        ? voicedFrameCount >= 10 && score >= threshold
        : voicedFrameCount >= 10 && diff1 >= minDiff1 && diff2 >= minDiff2;

      return {
        triggered,
        score,
        threshold,
        evidence: `f0Diff1=${diff1}st, f0Diff2=${diff2}st`,
        hint: "Stabilize pitch trajectory and remove erratic frame-to-frame warble.",
      };
    },
  },
  {
    id: "F24_CALCULATED_PITCH_LFO",
    domain: "calculated_artifice",
    name: "Calculated Sinusoidal Pitch LFO / Artificial Vibrato",
    detect(f, override) {
      const voicedFrameCount = num(f.voicedFrameCount);
      const depth = num(f.f0ModDepthSemi);
      const sinusoidality = num(f.f0ModSinusoidality);
      const freqHz = num(f.f0ModFreqHz);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minDepth = num(opts?.f0ModDepthSemi, 0.35);
      const minSinu = num(opts?.f0ModSinusoidality, 0.62);

      let score = 0;
      if (voicedFrameCount >= 15) {
        const dScore = clamp01(depth / (minDepth * 2));
        const sScore = clamp01((sinusoidality - (minSinu - 0.38)) / 0.76);
        score = round3(Math.min(dScore, sScore));
      }
      const triggered = isNumericOverride
        ? voicedFrameCount >= 15 && score >= threshold
        : voicedFrameCount >= 15 && depth >= minDepth && sinusoidality >= minSinu;

      return {
        triggered,
        score,
        threshold,
        evidence: `f0ModDepth=${depth}st, sinusoidality=${sinusoidality} @ ${freqHz}Hz`,
        hint: "Replace mechanical 3-12 Hz sinusoidal pitch LFO with organic, non-periodic prosody.",
        where: freqHz > 0 ? { freqHz } : undefined,
      };
    },
  },
  {
    id: "F25_AUTOTUNE_STAIRCASE",
    domain: "calculated_artifice",
    name: "Hard-Quantized Auto-Tune Pitch Staircase",
    detect(f, override) {
      const voicedFrameCount = num(f.voicedFrameCount);
      const voicedRatio = num(f.voicedRatio);
      const hnrDb = num(f.meanVoicedHnrDb);
      const flatStepRatio = num(f.flatStepRatio);
      const snapJumpCount = num(f.snapJumpCount);
      const f0Range = num(f.f0RangeSemitones);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minFlat = num(opts?.flatStepRatio, 0.65);
      const minJumps = num(opts?.snapJumpCount, 2);
      const minPlateauFlat = num(opts?.plateauFlatRatio, 0.75);
      const minPlateauRange = num(opts?.plateauRangeSemitones, 1.5);
      const minVoicedRatio = num(opts?.minVoicedRatio, 0.55);
      const minHnrDb = num(opts?.minVoicedHnrDb, 6.0);

      const eligible =
        voicedFrameCount >= 15 && voicedRatio >= minVoicedRatio && hnrDb >= minHnrDb;

      let score = 0;
      if (eligible) {
        const fScore = clamp01((flatStepRatio - (minFlat - 0.35)) / 0.7);
        const jScore = clamp01(snapJumpCount / (minJumps * 2));
        const snapScore = Math.min(fScore, jScore);

        const pfScore = clamp01((flatStepRatio - (minPlateauFlat - 0.25)) / 0.5);
        const prScore = clamp01(f0Range / (minPlateauRange * 2));
        const plateauScore = Math.min(pfScore, prScore);

        score = round3(Math.max(snapScore, plateauScore));
      }
      const triggered = isNumericOverride
        ? eligible && score >= threshold
        : eligible &&
          ((flatStepRatio >= minFlat && snapJumpCount >= minJumps) ||
            (flatStepRatio >= minPlateauFlat && f0Range >= minPlateauRange));

      return {
        triggered,
        score,
        threshold,
        evidence: `flatStepRatio=${flatStepRatio}, snapJumps=${snapJumpCount}, f0Range=${f0Range}st, voicedRatio=${voicedRatio}, hnr=${hnrDb}dB`,
        hint: "Loosen pitch-correction retune speed so transitions glide naturally instead of snapping to discrete steps.",
      };
    },
  },
  {
    id: "F26_INTERNAL_REBOUND_SHOCK",
    domain: "aggression",
    name: "Internal Rebound Shock (Post-Valley Glottal Hit)",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const shock = num(f.maxInternalShock);
      const timeSec = num(f.internalShockTimeSec);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minShock = num(opts?.maxInternalShock, 0.18);

      const score = activeFrameCount >= 8 ? round3(shock / (minShock * 2)) : 0;
      const triggered = isNumericOverride
        ? activeFrameCount >= 8 && score >= threshold
        : activeFrameCount >= 8 && shock >= minShock;

      return {
        triggered,
        score,
        threshold,
        evidence: `maxInternalShock=${shock} @ ${timeSec}s`,
        hint: "Soften internal syllable re-attack after pauses/valleys to avoid jarring mid-phrase shock.",
        where: { startSec: timeSec },
      };
    },
  },
  {
    id: "F27_METRONOMIC_CADENCE",
    domain: "rhythm_timing",
    name: "Robotic Metronomic Cadence (Zero Micro-Timing)",
    detect(f, override) {
      const onsetCount = num(f.onsetCount);
      const ioiCv = num(f.ioiCv);
      const meanIoiSec = num(f.meanIoiSec);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minOnsets = num(opts?.onsetCount, 4);
      const maxCv = num(opts?.ioiCv, 0.055);

      const eligible = onsetCount >= minOnsets && meanIoiSec >= 0.07;
      const score = eligible ? round3(clamp01((maxCv * 2 - ioiCv) / (maxCv * 2))) : 0;
      const triggered = isNumericOverride
        ? eligible && score >= threshold
        : eligible && ioiCv < maxCv;

      return {
        triggered,
        score,
        threshold,
        evidence: `onsetCount=${onsetCount}, ioiCv=${ioiCv}, meanIoi=${meanIoiSec}s`,
        hint: "Introduce organic micro-timing rubato and phrase-boundary breathing instead of rigid metronomic spacing.",
      };
    },
  },
];
