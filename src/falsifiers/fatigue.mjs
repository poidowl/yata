/**
 * src/falsifiers/fatigue.mjs — Micro-Expression, Vocal Register & Listener Fatigue Falsifiers (F57–F64, v0.10)
 *
 * Completes the 64-axis multidimensional falsifier mirror:
 *   F57_TAIL_DECAY_MONOTONY       — Cloned / uniform phrase-ending decay curves
 *   F58_UPPER_FORMANT_FREEZE      — Frozen upper vocal tract / dead nasal cavity (MFCC 5–8)
 *   F59_LOW_MID_PROXIMITY_BOOM    — Heavy 150–450 Hz mic proximity boom masking 1–3.5 kHz
 *   F60_SIBILANT_DURATION_STRETCH — Unnaturally dragged-out s/sh hiss segments (> 0.28s)
 *   F61_CREAKY_VOCAL_FRY_DRAG     — Sustained sub-115 Hz creaky vocal fry drag
 *   F62_REGISTER_BREAK_JUMP       — Abrupt >= 7.5 semitone pitch break mid-vowel
 *   F63_MICRO_TREMOR_STRESS       — Unsteady 8–13 Hz physiological stress tremor
 *   F64_EAR_CANAL_FATIGUE_INDEX   — Sustained unrelieved 2.5–5 kHz ear-canal resonance density
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

export const FATIGUE_FALSIFIERS = [
  {
    id: "F57_TAIL_DECAY_MONOTONY",
    domain: "prosody_rhythm",
    name: "Cloned / Monotonous Phrase-Ending Decay",
    detect(f, override) {
      const tailDecayCv = num(f.tailDecayCv, 1);
      const phraseEndCount = num(f.phraseEndCount, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxCv = num(opts?.maxMonotoneCv, 0.08);
      const eligible = num(f.activeFrameCount) >= 20 && phraseEndCount >= 3;

      const score = eligible ? round3(clamp01((maxCv * 1.6 - tailDecayCv) / (maxCv * 1.2))) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `tailDecayCv=${tailDecayCv} (phraseEnds=${phraseEndCount})`,
        hint: "Vary phrase-ending tapers organically across clauses instead of cloning identical decay envelopes.",
      };
    },
  },
  {
    id: "F58_UPPER_FORMANT_FREEZE",
    domain: "hollowness",
    name: "Frozen Upper Formant / Dead Nasal Cavity (MFCC 5–8)",
    detect(f, override) {
      const upperMfccStd = num(f.upperMfccStd, 2);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minStd = num(opts?.minUpperMfccStd, 0.55);
      const eligible =
        num(f.activeFrameCount) >= 20 &&
        num(f.voicedRatio) >= 0.45 &&
        num(f.durationSec) >= 1.2 &&
        num(f.activeMpsSpeech4_16, num(f.mpsSpeech4_16, 0)) >= 0.04;

      const score = eligible ? round3(clamp01((minStd - upperMfccStd) / 0.35)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `upperMfccStd=${upperMfccStd}`,
        hint: "Allow subtle upper-formant (F3–F5) and nasal-cavity movement so speech does not feel locked inside a rigid tube.",
      };
    },
  },
  {
    id: "F59_LOW_MID_PROXIMITY_BOOM",
    domain: "hollowness",
    name: "Mic Proximity Boom Masking (150–450 Hz)",
    detect(f, override) {
      const proximityBoomRatio = num(f.proximityBoomRatio, 0);
      const presenceRatio = num(f.presenceRatio, 1);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minBoom = num(opts?.minBoomRatio, 0.68);
      const eligible =
        num(f.activeFrameCount) >= 15 &&
        num(f.voicedRatio) >= 0.35 &&
        num(f.meanTop1PeakShare, 1) < 0.45 &&
        presenceRatio < 0.08;

      const score = eligible ? round3(clamp01((proximityBoomRatio - (minBoom - 0.18)) / 0.36)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `proximityBoom(150-450Hz)=${proximityBoomRatio}, presence=${presenceRatio}`,
        hint: "Step slightly back from the mic or gently tame 150–450 Hz proximity boom so 1–3.5 kHz clarity breathes.",
        where: { freqHz: 280 },
      };
    },
  },
  {
    id: "F60_SIBILANT_DURATION_STRETCH",
    domain: "aggression",
    name: "Dragged / Stretched Sibilant Hiss Run",
    detect(f, override) {
      const maxSibilantRunSec = num(f.maxSibilantRunSec, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxRun = num(opts?.maxSibilantRunSec, 0.28);
      const eligible = num(f.activeFrameCount) >= 15 && num(f.voicedRatio) >= 0.35;

      const score = eligible ? round3(clamp01((maxSibilantRunSec - (maxRun - 0.1)) / 0.2)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `maxSibilantRunSec=${maxSibilantRunSec}s`,
        hint: "Shorten stretched s/sh sibilant durations (< 0.25s) so fricatives stay crisp and gentle.",
        where: { freqHz: 6000 },
      };
    },
  },
  {
    id: "F61_CREAKY_VOCAL_FRY_DRAG",
    domain: "aggression",
    name: "Sustained Creaky Vocal Fry Drag",
    detect(f, override) {
      const vocalFryRatio = num(f.vocalFryRatio, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minFry = num(opts?.minFryRatio, 0.32);
      const eligible = num(f.activeFrameCount) >= 20 && num(f.voicedRatio) >= 0.35 && num(f.durationSec) >= 0.8;

      const score = eligible ? round3(clamp01((vocalFryRatio - (minFry - 0.12)) / 0.24)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `vocalFryRatio=${vocalFryRatio}`,
        hint: "Support breath airflow through phrase endings to prevent sustained sub-115 Hz creaky vocal fry drag.",
      };
    },
  },
  {
    id: "F62_REGISTER_BREAK_JUMP",
    domain: "prosody_rhythm",
    name: "Abrupt Intra-Vowel Register Break / Pitch Crack",
    detect(f, override) {
      const maxIntraRunF0JumpSemi = num(f.maxIntraRunF0JumpSemi, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minJump = num(opts?.minJumpSemi, 8.5);
      const eligible = num(f.voicedFrameCount) >= 10;

      const score = eligible ? round3(clamp01((maxIntraRunF0JumpSemi - (minJump - 2.5)) / 5.0)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `maxIntraRunF0JumpSemi=${maxIntraRunF0JumpSemi}st`,
        hint: "Smooth abrupt > 8 semitone register breaks or pitch-tracker/vocoder octave glitches mid-vowel.",
      };
    },
  },
  {
    id: "F63_MICRO_TREMOR_STRESS",
    domain: "prosody_rhythm",
    name: "Physiological Stress Micro-Tremor (8–13 Hz)",
    detect(f, override) {
      const stressTremorDepth = num(f.stressTremorDepth, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minDepth = num(opts?.minTremorDepth, 0.32);
      const eligible = num(f.activeFrameCount) >= 30 && num(f.voicedRatio) >= 0.45 && num(f.durationSec) >= 0.8;

      const score = eligible ? round3(clamp01((stressTremorDepth - (minDepth - 0.12)) / 0.24)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `stressTremorDepth(8-13Hz)=${stressTremorDepth}`,
        hint: "Relax tense 8–13 Hz vocal tremor so pitch and amplitude glide calmly.",
      };
    },
  },
  {
    id: "F64_EAR_CANAL_FATIGUE_INDEX",
    domain: "aggression",
    name: "Unrelieved Ear-Canal Resonance Fatigue (2.5–5 kHz)",
    detect(f, override) {
      const earFatigueDensity = num(f.earFatigueDensity, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minDens = num(opts?.minFatigueDensity, 0.42);
      const eligible = num(f.activeFrameCount) >= 30 && num(f.durationSec) >= 1.2;

      const score = eligible ? round3(clamp01((earFatigueDensity - (minDens - 0.16)) / 0.32)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `earFatigueDensity(2.5-5kHz x duty)=${earFatigueDensity}`,
        hint: "Insert breathing pauses and soften sustained 2.5–5 kHz ear-canal energy to prevent listener fatigue.",
        where: { freqHz: 3500 },
      };
    },
  },
  {
    id: "F65_HF_PHASE_GRAININESS",
    domain: "waveform_dynamics",
    name: "High-Frequency Phase-Locked Graininess (1.2–4.5 kHz)",
    detect(f, override) {
      const hfBandWaveKurt = num(f.hfBandWaveKurt, 3.0);
      const hasCount = Number.isFinite(f?.hfBandWaveKurtCount);
      const count = hasCount ? f.hfBandWaveKurtCount : 4;
      const { threshold, opts } = resolveThreshold(override, 0.5);
      const minKurt = num(opts?.minHfWaveKurt, 3.5);
      // Applies to voiced speech/tonal audio with sufficient active frames and speech modulation
      const eligible =
        num(f.activeFrameCount) >= 20 &&
        num(f.voicedRatio) >= 0.45 &&
        num(f.durationSec) >= 0.8 &&
        num(f.activeMpsSpeech4_16, num(f.mpsSpeech4_16, 0)) >= 0.04;

      const unobservable = eligible && count < 4;
      const observable = eligible && !unobservable;
      const score = observable ? round3(clamp01((hfBandWaveKurt - (minKurt - 0.35)) / 0.7)) : 0;
      const triggered = observable && score >= threshold;

      return {
        triggered,
        observed: !unobservable,
        observability: unobservable ? "unobservable" : "observed",
        score,
        threshold,
        evidence: unobservable
          ? `unobservable: vowelCoreWindows=${count} (<4; requires f0>=155Hz & hfRatio<0.35)`
          : `hfBandWaveKurt(1.2-4.5kHz)=${hfBandWaveKurt}`,
        hint: "Disperse high-order harmonic phase alignment (group-delay dispersion) so 1.2–4.5 kHz sounds smooth rather than pulse-grainy.",
        where: { freqHz: 2400 },
      };
    },
  },
];
