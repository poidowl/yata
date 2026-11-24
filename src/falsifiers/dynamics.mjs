/**
 * src/falsifiers/dynamics.mjs — Prosodic & Articulatory Dynamics Falsifiers (F41–F48, v0.10)
 *
 * Captures the "marching-in-place / flat prosodic & articulatory life" layer:
 *   F41_MONOTONE_DECLINATION        — Mechanical steep pitch drop every phrase
 *   F42_FLAT_SYLLABLE_DYNAMICS      — Uniform syllable peak loudness (marching-in-place)
 *   F43_UNVOICED_CONSONANT_STARVATION — Missing crisp voiceless consonant releases
 *   F44_FLAT_HNR_CONTRAST           — Monotonous voice quality (flat HNR dynamics)
 *   F45_SLUGGISH_ARTICULATION       — Sluggish tongue/lip MFCC trajectory speed
 *   F46_PITCH_ACCENT_STIFFNESS      — Over-smoothed / stiff pitch inflection curvature
 *   F47_MECHANICAL_PAUSE_PACKING    — Breathless packing or mechanical identical pauses
 *   F48_UNIFORM_ONSET_LOCK          — Identical mechanical syllable attack ramps
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

function isSpeechEligible(f, minDur = 1.0, minVoiced = 0.4) {
  return (
    num(f.activeFrameCount) >= 20 &&
    num(f.voicedRatio) >= minVoiced &&
    num(f.durationSec) >= minDur &&
    num(f.activeMpsSpeech4_16, num(f.mpsSpeech4_16, 0)) >= 0.04
  );
}

export const DYNAMICS_FALSIFIERS = [
  {
    id: "F41_MONOTONE_DECLINATION",
    domain: "prosody_rhythm",
    name: "Monotone Steep Pitch Declination",
    detect(f, override) {
      const f0SlopeSemi = num(f.f0SlopeSemi, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const slopeLimit = num(opts?.maxDeclinationSemi, -1.0);
      const eligible = isSpeechEligible(f, 1.0, 0.45);

      const score = eligible ? round3(clamp01((slopeLimit - f0SlopeSemi) / 0.65)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `f0SlopeSemi=${f0SlopeSemi}st`,
        hint: "Allow natural pitch accent rises and phrase-level intonation arcs instead of a steep mechanical downward ramp.",
      };
    },
  },
  {
    id: "F42_FLAT_SYLLABLE_DYNAMICS",
    domain: "prosody_rhythm",
    name: "Flat Marching-in-Place Syllable Loudness",
    detect(f, override) {
      const syllPeakCount = num(f.syllPeakCount, 0);
      const syllPeakAmpCv = num(f.syllPeakAmpCv, 1);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minPeaks = num(opts?.minSyllPeaks, 5);
      const eligible = isSpeechEligible(f, 1.0, 0.4) && syllPeakCount >= minPeaks;

      const score = eligible ? round3(clamp01((0.32 - syllPeakAmpCv) / 0.16)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `syllPeakAmpCv=${syllPeakAmpCv} (peaks=${syllPeakCount})`,
        hint: "Differentiate stressed accent nuclei from softer unstressed morae so phrasing does not march at uniform loudness.",
      };
    },
  },
  {
    id: "F43_UNVOICED_CONSONANT_STARVATION",
    domain: "absence_of_presence",
    name: "Unvoiced Consonant Release Starvation",
    detect(f, override) {
      const internalUnvoicedRatio = num(f.internalUnvoicedRatio, 1);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minUnv = num(opts?.minUnvoicedRatio, 0.045);
      const eligible = isSpeechEligible(f, 1.2, 0.45);

      const score = eligible ? round3(clamp01((minUnv - internalUnvoicedRatio) / 0.038)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `internalUnvoicedRatio=${internalUnvoicedRatio}`,
        hint: "Preserve crisp voiceless consonant releases (k/t/s/sh/ch) inside speech instead of smearing continuous voicing through every consonant.",
      };
    },
  },
  {
    id: "F44_FLAT_HNR_CONTRAST",
    domain: "absence_of_presence",
    name: "Flat Voice-Quality / HNR Dynamics",
    detect(f, override) {
      const hnrStdDb = num(f.hnrStdDb, 10);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minStd = num(opts?.minHnrStdDb, 4.7);
      const eligible = isSpeechEligible(f, 1.2, 0.45);

      const score = eligible ? round3(clamp01((minStd - hnrStdDb) / 1.4)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `hnrStdDb=${hnrStdDb}dB`,
        hint: "Allow living contrast between clear harmonic vowel cores and softer breathy consonant/tail transitions.",
      };
    },
  },
  {
    id: "F45_SLUGGISH_ARTICULATION",
    domain: "hollowness",
    name: "Sluggish Articulatory Trajectory Velocity (MFCC Delta)",
    detect(f, override) {
      const mfccVelMean = num(f.mfccVelMean, 5);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minVel = num(opts?.minMfccVel, 1.38);
      const eligible = isSpeechEligible(f, 1.2, 0.45);

      const score = eligible ? round3(clamp01((minVel - mfccVelMean) / 0.35)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `mfccVelMean=${mfccVelMean}`,
        hint: "Increase tongue and lip articulatory agility between syllables so vowels and consonants do not blend into a sluggish tube.",
      };
    },
  },
  {
    id: "F46_PITCH_ACCENT_STIFFNESS",
    domain: "prosody_rhythm",
    name: "Stiff / Over-Smoothed Pitch Accent Curvature",
    detect(f, override) {
      const f0CurvP90Semi = num(f.f0CurvP90Semi, 1);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxStiff = num(opts?.maxStiffCurv, 0.28);
      const eligible = isSpeechEligible(f, 1.0, 0.45);

      const score = eligible ? round3(clamp01((maxStiff - f0CurvP90Semi) / 0.2)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `f0CurvP90Semi=${f0CurvP90Semi}st`,
        hint: "Preserve nimble micro-inflections and pitch-accent bends rather than over-smoothing the F0 trajectory.",
      };
    },
  },
  {
    id: "F47_MECHANICAL_PAUSE_PACKING",
    domain: "prosody_rhythm",
    name: "Mechanical Pause Uniformity / Breathless Packing",
    detect(f, override) {
      const pauseCount = num(f.pauseCount, 0);
      const pauseDurCv = num(f.pauseDurCv, 1);
      const breathlessWallRatio = num(f.breathlessWallRatio, 0);
      const { threshold, isNumericOverride } = resolveThreshold(override, 0.5);
      const eligible = isSpeechEligible(f, 1.5, 0.4);

      let score = 0;
      if (eligible) {
        const mechPause = pauseCount >= 3 ? clamp01((0.18 - pauseDurCv) / 0.14) : 0;
        const breathless = clamp01((breathlessWallRatio - 0.55) / 0.35);
        score = round3(Math.max(mechPause, breathless));
      }
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `pauseCount=${pauseCount}, pauseDurCv=${pauseDurCv}, breathlessWall=${breathlessWallRatio}`,
        hint: "Vary breathing pause lengths naturally between clauses instead of packing speech breathlessly or cloning identical gaps.",
      };
    },
  },
  {
    id: "F48_UNIFORM_ONSET_LOCK",
    domain: "waveform_dynamics",
    name: "Uniform / Cloned Syllable Onset Ramps",
    detect(f, override) {
      const syllPeakCount = num(f.syllPeakCount, 0);
      const onsetAttackCv = num(f.onsetAttackCv, 1);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minPeaks = num(opts?.minSyllPeaks, 5);
      const eligible = isSpeechEligible(f, 1.0, 0.4) && syllPeakCount >= minPeaks;

      const score = eligible ? round3(clamp01((0.36 - onsetAttackCv) / 0.22)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `onsetAttackCv=${onsetAttackCv} (peaks=${syllPeakCount})`,
        hint: "Allow consonant-dependent onset variety (gentle vowel swells vs crisp plosive entries) instead of cloned attack ramps.",
      };
    },
  },
];
