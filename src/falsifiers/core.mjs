/**
 * src/falsifiers/core.mjs — Preserved Core 6 Falsifiers (F1–F6, v0.1 backward-compatible)
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

function resolveThreshold(override, defaultThreshold) {
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

export const ORIGINAL_6_FALSIFIERS = [
  {
    id: "F1_HARSH_EDGE",
    domain: "aggression",
    name: "Sharp Edge / High-Freq Aggression",
    detect(f, override) {
      const maxAttackSlope = num(f.maxAttackSlope);
      const maxAttackTimeSec = num(f.maxAttackTimeSec);
      const meanHfRatio = num(f.meanHfRatio);
      const voicedRatio = num(f.voicedRatio, 1);
      const meanRoughness = num(f.meanRoughness, 0);
      const meanVoicedHnrDb = num(f.meanVoicedHnrDb, 20);
      const mpsRoughToSpeechRatio = num(f.mpsRoughToSpeechRatio, 0);
      const subBassRatio = num(f.subBassRatio, 0);

      const edgeScore = round3(maxAttackSlope * 0.6 + meanHfRatio * 0.4);
      const hfNorm = meanHfRatio / Math.max(0.25, 1 - subBassRatio);
      const isRoughHiss =
        voicedRatio < 0.5 && meanRoughness > 0.45 && hfNorm > 0.22 && maxAttackSlope > 0.25;
      const isAperiodicGrowl =
        voicedRatio >= 0.25 &&
        voicedRatio <= 0.75 &&
        meanVoicedHnrDb < 4.5 &&
        meanRoughness > 0.45 &&
        mpsRoughToSpeechRatio > 2.0;

      const hissScore = isRoughHiss ? round3(Math.min(1, 0.45 + meanRoughness * 0.4 + hfNorm * 0.3)) : 0;
      const growlScore = isAperiodicGrowl
        ? round3(Math.min(1, 0.45 + meanRoughness * 0.35 + Math.min(0.25, mpsRoughToSpeechRatio * 0.05)))
        : 0;
      const score = Math.max(edgeScore, hissScore, growlScore);

      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.42);
      const attackLimit = num(opts?.maxAttackSlope, 0.43);
      const extremeAttackLimit = num(opts?.extremeAttackSlope, 0.55);
      const minAttackHf = num(opts?.minAttackHfRatio, 0.18);
      const sharpEdgeTriggered =
        edgeScore > threshold ||
        maxAttackSlope > extremeAttackLimit ||
        (maxAttackSlope > attackLimit && meanHfRatio >= minAttackHf);
      const triggered = isNumericOverride
        ? score > threshold
        : sharpEdgeTriggered || isRoughHiss || isAperiodicGrowl;

      let evidence = `attackSlope=${maxAttackSlope} @ ${maxAttackTimeSec}s, hfRatio=${meanHfRatio}`;
      if (!sharpEdgeTriggered && isRoughHiss) {
        evidence += `, roughHiss(rough=${meanRoughness}, hfNorm=${hfNorm.toFixed(2)}, voiced=${voicedRatio})`;
      } else if (!sharpEdgeTriggered && isAperiodicGrowl) {
        evidence += `, roughGrowl(hnr=${meanVoicedHnrDb}dB, rough=${meanRoughness}, mpsRatio=${mpsRoughToSpeechRatio})`;
      }
      return {
        triggered,
        score,
        threshold,
        evidence,
        hint: "Soften glottal attack curvature, reduce 30–150 Hz rough modulation, and deepen high-frequency spectral tilt.",
        where: { startSec: maxAttackTimeSec },
      };
    },
  },
  {
    id: "F2_PURE_ROBOT",
    domain: "absence_of_presence",
    name: "Mechanical Rigidity (Zero Micro-Variation)",
    detect(f, override) {
      const voicedRatio = num(f.voicedRatio);
      const jitter = num(f.jitter);
      const shimmer = num(f.shimmer);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.7);
      const minVoiced = num(opts?.minVoicedRatio, 0.45);
      const minJitter = num(opts?.minJitter, 0.00025);
      const minJitterShimmer = num(opts?.minJitterShimmer, 0.04);
      const softJitter = num(opts?.softJitter, 0.0025);
      const softShimmer = num(opts?.softShimmer, 0.015);
      const baseScore = 1 - Math.min(1, jitter * 200 + shimmer * 20);
      const zeroJitterScore =
        jitter <= minJitter && shimmer <= minJitterShimmer ? Math.max(0.75, 1 - shimmer * 6) : 0;
      const score = voicedRatio >= minVoiced ? round3(Math.max(baseScore, zeroJitterScore)) : 0;
      const triggered = isNumericOverride
        ? voicedRatio >= minVoiced && score > threshold
        : voicedRatio >= minVoiced &&
          ((jitter <= minJitter && shimmer <= minJitterShimmer) ||
            (jitter <= softJitter && shimmer <= softShimmer));
      return {
        triggered,
        score,
        threshold,
        evidence: `voicedRatio=${voicedRatio}, jitter=${jitter}, shimmer=${shimmer}`,
        hint: "Introduce physical inertia, lung-pressure drift, or 1/f micro-fluctuation.",
      };
    },
  },
  {
    id: "F3_PURE_NOISE",
    domain: "absence_of_presence",
    name: "Unstructured Noise (Wind / Static)",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const voicedRatio = num(f.voicedRatio);
      const hasFlatness = Number.isFinite(f?.meanSpectralFlatness);
      const flatness = hasFlatness ? num(f.meanSpectralFlatness) : 1;
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.78);
      const minVoiced = num(opts?.minVoicedRatio, 0.22);
      const minFlatness = num(opts?.minSpectralFlatness, 0.25);
      const broadbandNoise = !hasFlatness || flatness >= minFlatness;
      const score =
        activeFrameCount === 0
          ? 1
          : broadbandNoise
            ? round3(1 - voicedRatio)
            : round3((1 - voicedRatio) * Math.min(1, flatness / minFlatness) * 0.7);
      const triggered = isNumericOverride
        ? score > threshold
        : activeFrameCount === 0 || (voicedRatio < minVoiced && broadbandNoise);
      return {
        triggered,
        score,
        threshold,
        evidence: `voicedRatio=${voicedRatio}, flatness=${round3(flatness)} (activeFrames=${activeFrameCount})`,
        hint: "Establish coherent periodic vocal-fold / resonant body structure.",
      };
    },
  },
  {
    id: "F4_NO_COMMON_CAUSE",
    domain: "absence_of_presence",
    name: "Uncoupled Channels (Hollow / Stitched)",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const coupling = num(f.commonCauseCoupling);
      const score = round3(1 - coupling);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.78);
      const minCoupling = num(opts?.minCoupling, 0.22);
      const triggered = isNumericOverride
        ? activeFrameCount >= 8 && score > threshold
        : activeFrameCount >= 8 && coupling < minCoupling;
      return {
        triggered,
        score,
        threshold,
        evidence: `crossChannelCoupling=${coupling}`,
        hint: "Couple pitch, breathiness, and amplitude to a single latent physical state (e.g., lung air reservoir).",
      };
    },
  },
  {
    id: "F5_ABRUPT_TAIL",
    domain: "no_arrow_of_time",
    name: "Abrupt Cut-Off Tail (Symbolic / Katakana)",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const tailDecaySec = num(f.tailDecaySec);
      const tailStartSec = num(f.tailStartSec);
      const tailTruncated = num(f.tailTruncatedAtEof, 0) >= 0.5;
      const score = tailTruncated ? 0 : round3(1 - Math.min(1, tailDecaySec / 0.14));
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.61);
      const minTailSec = num(opts?.minTailDecaySec, 0.055);
      const triggered = tailTruncated
        ? false
        : isNumericOverride
          ? activeFrameCount >= 5 && score > threshold
          : activeFrameCount >= 5 && tailDecaySec < minTailSec;
      return {
        triggered,
        score,
        threshold,
        evidence: tailTruncated
          ? `tailTruncatedAtEof (sound still active at clip end; tailDecay=${tailDecaySec}s)`
          : `tailDecay=${tailDecaySec}s (from ${tailStartSec}s)`,
        hint: "Allow phrase tail to release gradually with breath/tension decay instead of hard cut-off.",
        where: {
          startSec: tailStartSec,
          endSec: +(tailStartSec + tailDecaySec).toFixed(3),
        },
      };
    },
  },
  {
    id: "F6_PHYSICAL_GLITCH",
    domain: "mechanical_failure",
    name: "Physical Discontinuity / Clipping",
    detect(f, override) {
      const clipRatio = num(f.clipRatio);
      const maxSampleJump = num(f.maxSampleJump);
      const score = round3(Math.min(1, clipRatio * 50 + Math.max(0, maxSampleJump - 0.5)));
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.35);
      const maxClip = num(opts?.maxClipRatio, 0.005);
      const maxJump = num(opts?.maxSampleJump, 0.85);
      const triggered = isNumericOverride
        ? score > threshold
        : clipRatio > maxClip || maxSampleJump > maxJump;
      return {
        triggered,
        score,
        threshold,
        evidence: `clipRatio=${clipRatio}, maxSampleJump=${maxSampleJump}`,
        hint: "Check waveguide stability, clicks, or output gain normalization.",
      };
    },
  },
];
