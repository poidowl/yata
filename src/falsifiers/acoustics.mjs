/**
 * src/falsifiers/acoustics.mjs — Room, Codec, Phase & Recording Artifact Falsifiers (F49–F56, v0.10)
 *
 * Orthogonal acoustic-environment, codec, and harmonic-phase failure modes:
 *   F49_EXCESSIVE_ROOM_REVERB_TAIL   — Cavernous late reverb tail killing intimacy
 *   F50_PRE_ECHO_SMEAR               — Low-bitrate perceptual codec pre-echo before sharp onsets
 *   F51_SPECTRAL_BAND_HOLE           — Deep spectral notch / collapsed frequency band
 *   F52_HARMONIC_PHASE_CHORUS        — Robotic vocoder phaser / rapid mid-band micro-beating
 *   F53_HIGH_FREQ_BANDWIDTH_CUTOFF   — Muffled brickwall low-pass / codec bandwidth ceiling
 *   F54_COMPRESSOR_PUMPING           — Aggressive AGC / noise-floor breathing
 *   F55_INTERHARMONIC_BUZZ_FLOOR     — Gritty inter-harmonic buzz in 300–2200 Hz voiced core
 *   F56_PHASE_LOCKED_IMPULSE_BUZZ    — Zero-phase buzz-saw / high-kurtosis impulse train
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

export const ACOUSTICS_FALSIFIERS = [
  {
    id: "F49_EXCESSIVE_ROOM_REVERB_TAIL",
    domain: "environment_digital_spatial",
    name: "Cavernous Late Room Reverb Tail",
    detect(f, override) {
      const lateReverbRatio = num(f.lateReverbRatio, 0);
      const dur = num(f.durationSec, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minRatio = num(opts?.minLateReverbRatio, 0.42);
      const eligible = num(f.activeFrameCount) >= 20 && dur >= 1.0;

      const score = eligible ? round3(clamp01((lateReverbRatio - (minRatio - 0.14)) / 0.28)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `lateReverbRatio=${lateReverbRatio}`,
        hint: "Record closer to the microphone or dampen cavernous room reflections so the voice stays intimate.",
      };
    },
  },
  {
    id: "F50_PRE_ECHO_SMEAR",
    domain: "environment_digital_spatial",
    name: "Codec Pre-Echo / Transient Smear",
    detect(f, override) {
      const preEchoRatio = num(f.preEchoRatio, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minPre = num(opts?.minPreEchoRatio, 0.45);
      const eligible = num(f.activeFrameCount) >= 15 && num(f.onsetCount) >= 2;

      const score = eligible ? round3(clamp01((preEchoRatio - (minPre - 0.15)) / 0.3)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `preEchoRatio=${preEchoRatio}`,
        hint: "Use higher bitrate or lossless PCM to avoid pre-onset codec ringing before sharp transients.",
      };
    },
  },
  {
    id: "F51_SPECTRAL_BAND_HOLE",
    domain: "hollowness",
    name: "Deep Spectral Band Hole / Collapsed Notch",
    detect(f, override) {
      const spectralHoleDepthDb = num(f.spectralHoleDepthDb, 0);
      const flatness = num(f.meanSpectralFlatness, 0);
      const speechMod = num(f.activeMpsSpeech4_16, num(f.mpsSpeech4_16, 0));
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minDepth = num(opts?.minHoleDepthDb, 22);
      // Guard: only flag collapsed EQ/codec band holes on broadband/speech audio (not sparse harmonic chimes/tones)
      const eligible =
        num(f.activeFrameCount) >= 15 &&
        flatness >= 0.02 &&
        flatness < 0.35 &&
        speechMod >= 0.04;

      const score = eligible ? round3(clamp01((spectralHoleDepthDb - (minDepth - 8)) / 16)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `spectralHoleDepthDb=${spectralHoleDepthDb}dB`,
        hint: "Fill deep narrowband EQ/codec notches in the vocal-tract range so timbre does not sound hollowed out.",
      };
    },
  },
  {
    id: "F52_HARMONIC_PHASE_CHORUS",
    domain: "hollowness",
    name: "Robotic Phase Chorus / Mid-Band Micro-Beating",
    detect(f, override) {
      const midBandFluxJitter = num(f.midBandFluxJitter, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minJit = num(opts?.minMidFluxJitter, 6.5);
      const eligible = num(f.activeFrameCount) >= 20 && num(f.voicedRatio) >= 0.4;

      const score = eligible ? round3(clamp01((midBandFluxJitter - (minJit - 2.0)) / 4.0)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `midBandFluxJitter=${midBandFluxJitter}dB`,
        hint: "Remove phase-cancellation chorus or vocoder frame-boundary beating in the 500–2500 Hz midband.",
      };
    },
  },
  {
    id: "F53_HIGH_FREQ_BANDWIDTH_CUTOFF",
    domain: "environment_digital_spatial",
    name: "Brickwall High-Frequency Bandwidth Ceiling",
    detect(f, override) {
      const effectiveCutoffHz = num(f.effectiveCutoffHz, 12000);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxCutoff = num(opts?.maxCutoffHz, 4200);
      const eligible =
        num(f.activeFrameCount) >= 15 &&
        num(f.durationSec) >= 0.8 &&
        num(f.activeMpsSpeech4_16, num(f.mpsSpeech4_16, 0)) >= 0.04;

      const score = eligible ? round3(clamp01((maxCutoff - effectiveCutoffHz) / 1800)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `effectiveCutoffHz=${effectiveCutoffHz}Hz`,
        hint: "Preserve natural high-frequency air above 5–8 kHz instead of truncating with a muffled low-pass ceiling.",
        where: effectiveCutoffHz > 0 ? { freqHz: Math.round(effectiveCutoffHz) } : undefined,
      };
    },
  },
  {
    id: "F54_COMPRESSOR_PUMPING",
    domain: "waveform_dynamics",
    name: "Aggressive Compressor / AGC Noise-Floor Pumping",
    detect(f, override) {
      const noiseFloorPumping = num(f.noiseFloorPumping, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minPump = num(opts?.minPumping, 0.65);
      const eligible = num(f.activeFrameCount) >= 20 && num(f.pauseCount) >= 2;

      const score = eligible ? round3(clamp01((noiseFloorPumping - (minPump - 0.25)) / 0.5)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `noiseFloorPumping=${noiseFloorPumping}`,
        hint: "Relax aggressive AGC/compressor release times so background hiss does not surge up during pauses.",
      };
    },
  },
  {
    id: "F55_INTERHARMONIC_BUZZ_FLOOR",
    domain: "aggression",
    name: "Inter-Harmonic Gritty Buzz Floor (300–2200 Hz)",
    detect(f, override) {
      const voicedCoreFlatness = num(f.voicedCoreFlatness, 0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minFlat = num(opts?.minCoreFlatness, 0.28);
      const eligible = num(f.activeFrameCount) >= 15 && num(f.voicedRatio) >= 0.45;

      const score = eligible ? round3(clamp01((voicedCoreFlatness - (minFlat - 0.1)) / 0.2)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `voicedCoreFlatness(300-2200Hz)=${voicedCoreFlatness}`,
        hint: "Clean up gritty inter-harmonic buzz or vocoder noise trapped between pitch harmonics in 300–2200 Hz.",
      };
    },
  },
  {
    id: "F56_PHASE_LOCKED_IMPULSE_BUZZ",
    domain: "waveform_dynamics",
    name: "Zero-Phase Buzz-Saw / High-Kurtosis Impulse Train",
    detect(f, override) {
      const waveKurtMean = num(f.waveKurtMean, 3);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minKurt = num(opts?.minWaveKurt, 11.0);
      const eligible = num(f.activeFrameCount) >= 15 && num(f.voicedRatio) >= 0.4;

      const score = eligible ? round3(clamp01((waveKurtMean - (minKurt - 3.5)) / 7.0)) : 0;
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `waveKurtMean=${waveKurtMean}`,
        hint: "Disperse rigid zero-phase harmonic alignment so the waveform sounds warm rather than a sharp impulse train.",
      };
    },
  },
];
