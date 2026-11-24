/**
 * src/falsifiers/spatial.mjs — Environment, Digital & Spatial Falsifiers (F28–F30)
 *
 * Includes graceful no-op on mono (numChannels < 2) for F30_STEREO_PHASE_DISCOMFORT.
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

export const SPATIAL_FALSIFIERS = [
  {
    id: "F28_MAINS_HUM_DRONE",
    domain: "environment_digital_spatial",
    name: "50/60 Hz Mains Electrical Hum Drone",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const humRatio = num(f.mainsHumRatio);
      const persist = num(f.mainsPersistence);
      const freqHz = num(f.mainsFreqHz);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minRatio = num(opts?.mainsHumRatio, 0.08);
      const minPersist = num(opts?.mainsPersistence, 0.5);

      let score = 0;
      if (activeFrameCount >= 3) {
        const rScore = clamp01(humRatio / (minRatio * 2));
        const pScore = clamp01(persist / (minPersist * 2));
        score = round3(Math.min(rScore, pScore));
      }
      const triggered = isNumericOverride
        ? activeFrameCount >= 3 && score >= threshold
        : activeFrameCount >= 3 && humRatio >= minRatio && persist >= minPersist;

      return {
        triggered,
        score,
        threshold,
        evidence: `mainsHumRatio=${humRatio}, persistence=${persist} @ ${freqHz}Hz`,
        hint: "Notch out 50/60 Hz AC mains hum and its 2nd/3rd harmonics (100/150 or 120/180 Hz).",
        where: freqHz > 0 ? { freqHz } : undefined,
      };
    },
  },
  {
    id: "F29_BITCRUSH_ALIASING",
    domain: "environment_digital_spatial",
    name: "Bitcrush Quantization / Digital Aliasing",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const uniqueLevelRatio = num(f.uniqueLevelRatio);
      const aliasingFloorRatio = num(f.aliasingFloorRatio);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxUnique = num(opts?.uniqueLevelRatio, 0.1);
      const minAlias = num(opts?.aliasingFloorRatio, 0.2);

      let score = 0;
      if (activeFrameCount >= 8) {
        const qScore =
          uniqueLevelRatio > 0 ? clamp01((maxUnique * 2 - uniqueLevelRatio) / (maxUnique * 2)) : 0;
        const aScore = clamp01(aliasingFloorRatio / (minAlias * 2));
        score = round3(Math.max(qScore, aScore));
      }
      const triggered = isNumericOverride
        ? activeFrameCount >= 8 && score >= threshold
        : activeFrameCount >= 8 &&
          ((uniqueLevelRatio > 0 && uniqueLevelRatio <= maxUnique) ||
            aliasingFloorRatio >= minAlias);

      return {
        triggered,
        score,
        threshold,
        evidence: `uniqueLevelRatio=${uniqueLevelRatio}, aliasingFloorRatio=${aliasingFloorRatio}`,
        hint: "Use >= 16-bit precision and anti-aliasing low-pass filtering before sample-rate conversion.",
      };
    },
  },
  {
    id: "F30_STEREO_PHASE_DISCOMFORT",
    domain: "environment_digital_spatial",
    name: "Stereo Phase Inversion / Severe L-R Imbalance",
    detect(f, override) {
      const numChannels = num(f.numChannels, 1);
      const stereoCorr = num(f.stereoCorr, 1);
      const lrImbalance = num(f.lrImbalance, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);

      // Graceful no-op on mono
      if (numChannels < 2) {
        return {
          triggered: false,
          score: 0,
          threshold,
          evidence: `mono (numChannels=${numChannels}): stereo phase check skipped`,
          hint: "No stereo issue on mono input.",
        };
      }

      const maxNegCorr = num(opts?.stereoCorr, -0.25);
      const minImb = num(opts?.lrImbalance, 0.55);

      const phaseScore =
        stereoCorr < 0 ? clamp01(-stereoCorr / Math.max(Math.abs(maxNegCorr) * 2, 1e-6)) : 0;
      const imbScore = clamp01(lrImbalance / (minImb * 2));
      const score = round3(Math.max(phaseScore, imbScore));
      const triggered = isNumericOverride
        ? score >= threshold
        : stereoCorr < maxNegCorr || lrImbalance >= minImb;

      return {
        triggered,
        score,
        threshold,
        evidence: `numChannels=${numChannels}, stereoCorr=${stereoCorr}, lrImbalance=${lrImbalance}`,
        hint: "Fix inverted L/R polarity or extreme hard-panning so stereo image feels centered and comfortable.",
      };
    },
  },
];
