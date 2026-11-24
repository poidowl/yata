/**
 * src/falsifiers/spectral.mjs — Spectral Aggression, Hollowness, Pressed Strain & Stasis (F12–F20, F31, F32)
 *
 * Includes sasayaki (breathy whisper) false-positive guard on F31_PRESSED_STRAIN
 * and clean-harmonic guards on F18_MUDDY_BOXINESS / F19_TELEPHONE_BANDLIMIT.
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

export const SPECTRAL_CORE_FALSIFIERS = [
  {
    id: "F12_MENACING_LOW_REGISTER",
    domain: "aggression",
    name: "Menacing / Boomy Low Register",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const voicedFrameCount = num(f.voicedFrameCount);
      const medianF0 = num(f.medianF0);
      const centroid = num(f.spectralCentroidHz);
      const lowBandRatio = num(f.lowBandRatio);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxF0 = num(opts?.medianF0, 140);
      const minLowBand = num(opts?.lowBandRatio, 0.4);

      let vScore = 0;
      if (voicedFrameCount >= 5 && medianF0 > 0) {
        const f0Low = clamp01((maxF0 + 40 - medianF0) / 80);
        const lbScore = clamp01(lowBandRatio / (minLowBand * 2));
        vScore = Math.min(f0Low, lbScore);
      }
      let nvScore = 0;
      if (centroid > 0) {
        const cScore = clamp01((560 - centroid) / 280);
        const bScore = clamp01((lowBandRatio - 0.36) / 0.64);
        nvScore = Math.min(cScore, bScore);
      }

      const score = activeFrameCount >= 5 ? round3(Math.max(vScore, nvScore)) : 0;
      const triggered = isNumericOverride
        ? activeFrameCount >= 5 && score >= threshold
        : activeFrameCount >= 5 &&
          ((voicedFrameCount >= 5 && medianF0 > 0 && medianF0 < maxF0 && lowBandRatio >= minLowBand) ||
            (lowBandRatio >= 0.68 && centroid > 0 && centroid < 420));

      return {
        triggered,
        score,
        threshold,
        evidence: `medianF0=${medianF0}Hz, centroid=${centroid}Hz, lowBandRatio=${lowBandRatio}`,
        hint: "Raise fundamental register or trim heavy 60-250 Hz low-end weight.",
        where: { freqHz: medianF0 > 0 ? medianF0 : centroid },
      };
    },
  },
  {
    id: "F13_SUBBASS_RUMBLE",
    domain: "aggression",
    name: "Sub-Bass Rumble / Handling Noise",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const subBassRatio = num(f.subBassRatio);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minSub = num(opts?.subBassRatio, 0.22);

      const score = activeFrameCount >= 3 ? round3(subBassRatio / (minSub * 2)) : 0;
      const triggered = isNumericOverride
        ? activeFrameCount >= 3 && score >= threshold
        : activeFrameCount >= 3 && subBassRatio >= minSub;

      return {
        triggered,
        score,
        threshold,
        evidence: `subBassRatio(20-90Hz)=${subBassRatio}`,
        hint: "Apply an 80 Hz high-pass filter to remove sub-bass rumble and mic handling noise.",
        where: { freqHz: 55 },
      };
    },
  },
  {
    // Sensory dissonance curve based on Sethares, W. A. (1993), "Local consonance and the
    // relationship between timbre and scale", JASA 94(3), 1218–1228 (parametrizing Plomp & Levelt 1965).
    id: "F14_HELMHOLTZ_ROUGHNESS",
    domain: "aggression",
    name: "Psychoacoustic Roughness / Beating Dissonance",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const meanRoughness = num(f.meanRoughness);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minRough = num(opts?.meanRoughness, 0.26);

      const score = activeFrameCount >= 4 ? round3(meanRoughness / (minRough * 2)) : 0;
      const triggered = isNumericOverride
        ? activeFrameCount >= 4 && score >= threshold
        : activeFrameCount >= 4 && meanRoughness >= minRough;

      return {
        triggered,
        score,
        threshold,
        evidence: `meanRoughness=${meanRoughness}`,
        hint: "Reduce closely-spaced dissonant partials (15-70 Hz beating intervals) or FM sideband clutter.",
      };
    },
  },
  {
    id: "F15_PIERCING_WHISTLE",
    domain: "aggression",
    name: "Piercing Narrowband Whistle (2-6.5 kHz)",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const promDb = num(f.piercingProminenceDb);
      const share = num(f.piercingBandShare);
      const persist = num(f.piercingPersistence);
      const freqHz = num(f.piercingFreqHz);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minPersist = num(opts?.piercingPersistence, 0.35);
      const minProm = num(opts?.piercingProminenceDb, 15);
      const minShare = num(opts?.piercingBandShare, 0.12);

      let score = 0;
      if (activeFrameCount >= 4) {
        const p1 = clamp01(persist / (minPersist * 2));
        const p2 = clamp01(promDb / (minProm * 2));
        const p3 = clamp01(share / (minShare * 2));
        score = round3(Math.min(p1, p2, p3));
      }
      const triggered = isNumericOverride
        ? activeFrameCount >= 4 && score >= threshold
        : activeFrameCount >= 4 && persist >= minPersist && promDb >= minProm && share >= minShare;

      return {
        triggered,
        score,
        threshold,
        evidence: `prominence=${promDb}dB, share=${share}, persist=${persist} @ ${freqHz}Hz`,
        hint: "Notch out narrowband ringing or feedback whine in the 2-6.5 kHz ear-canal resonance band.",
        where: freqHz > 0 ? { freqHz } : undefined,
      };
    },
  },
  {
    id: "F16_HARSH_SIBILANCE_FIZZ",
    domain: "aggression",
    name: "Harsh Sibilance / High-Frequency Fizz (4.5-10 kHz)",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const meanSib = num(f.meanSibilanceRatio);
      const p90Sib = num(f.p90SibilanceRatio);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minMean = num(opts?.meanSibilanceRatio, 0.26);
      const minP90 = num(opts?.p90SibilanceRatio, 0.42);

      const score =
        activeFrameCount >= 4
          ? round3(Math.max(meanSib / (minMean * 2), p90Sib / (minP90 * 2)))
          : 0;
      const triggered = isNumericOverride
        ? activeFrameCount >= 4 && score >= threshold
        : activeFrameCount >= 4 && (meanSib >= minMean || p90Sib >= minP90);

      return {
        triggered,
        score,
        threshold,
        evidence: `meanSibilance=${meanSib}, p90Sibilance=${p90Sib}`,
        hint: "De-ess the 4.5-10 kHz band and soften harsh sibilant fricatives or metallic fizz.",
        where: { freqHz: 6500 },
      };
    },
  },
  {
    id: "F17_HOLLOW_METALLIC_COMB",
    domain: "hollowness",
    name: "Hollow Metallic Comb-Filter Resonance",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const cepPeak = num(f.nonPitchCepstralPeak);
      const notchDb = num(f.combNotchDepthDb);
      const delayMs = num(f.combDelayMs);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minNotchDb = num(opts?.combNotchDepthDb, 4.5);
      const minPeak = num(opts?.nonPitchCepstralPeak, 0.25);

      const score =
        activeFrameCount >= 5
          ? round3(Math.min(notchDb / (minNotchDb * 2), cepPeak / (minPeak * 2)))
          : 0;
      const triggered = isNumericOverride
        ? activeFrameCount >= 5 && score >= threshold
        : activeFrameCount >= 5 && notchDb >= minNotchDb && cepPeak >= minPeak;

      return {
        triggered,
        score,
        threshold,
        evidence: `combNotchDepth=${notchDb}dB, cepPeak=${cepPeak}, delay=${delayMs}ms`,
        hint: "Eliminate short-delay comb reflections (2-15 ms) or phase-canceled metallic doubling.",
        where: delayMs > 0 ? { freqHz: Math.round(1000 / delayMs) } : undefined,
      };
    },
  },
  {
    id: "F18_MUDDY_BOXINESS",
    domain: "hollowness",
    name: "Muddy Boxiness (250-650 Hz Congestion)",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const boxyRatio = num(f.boxyRatio);
      const presenceRatio = num(f.presenceRatio);
      const top1Share = num(f.meanTop1PeakShare);
      const medianF0 = num(f.medianF0);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minBoxy = num(opts?.boxyRatio, 0.58);
      const maxPres = num(opts?.presenceRatio, 0.06);

      // Guard against clean tonal instruments/voices whose single fundamental happens to sit in 250-650 Hz
      const isCongested = top1Share < 0.45 || (medianF0 > 0 && medianF0 < 250);
      let score = 0;
      if (activeFrameCount >= 5 && isCongested) {
        const bScore = clamp01((boxyRatio - (minBoxy - 0.25)) / 0.5);
        const pScore = clamp01((maxPres + 0.06 - presenceRatio) / 0.12);
        score = round3(Math.min(bScore, pScore));
      }
      const triggered = isNumericOverride
        ? activeFrameCount >= 5 && isCongested && score >= threshold
        : activeFrameCount >= 5 && isCongested && boxyRatio >= minBoxy && presenceRatio <= maxPres;

      return {
        triggered,
        score,
        threshold,
        evidence: `boxyRatio(250-650Hz)=${boxyRatio}, presence=${presenceRatio}, top1Share=${top1Share}`,
        hint: "Cut muddy 250-650 Hz room/box congestion and restore natural upper-mid clarity.",
        where: { freqHz: 420 },
      };
    },
  },
  {
    id: "F19_TELEPHONE_BANDLIMIT",
    domain: "hollowness",
    name: "Telephone Band-Limited Narrowband (300-3400 Hz)",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const midOnlyRatio = num(f.midOnlyRatio);
      const lowWarmthRatio = num(f.lowWarmthRatio);
      const highAirRatio = num(f.highAirRatio);
      const centroid = num(f.spectralCentroidHz);
      const top1Share = num(f.meanTop1PeakShare);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minMid = num(opts?.midOnlyRatio, 0.93);
      const maxLow = num(opts?.lowWarmthRatio, 0.03);
      const maxAir = num(opts?.highAirRatio, 0.015);

      // Guard against pure/gentle warm tones/chimes whose few harmonics naturally fall below 3.4 kHz
      const isMidBandVoiceLike = centroid >= 750 && top1Share < 0.48;
      let score = 0;
      if (activeFrameCount >= 5 && isMidBandVoiceLike) {
        const mScore = clamp01((midOnlyRatio - (minMid - 0.07)) / 0.14);
        const lScore = clamp01((maxLow * 2 - lowWarmthRatio) / (maxLow * 2));
        const aScore = clamp01((maxAir * 2 - highAirRatio) / (maxAir * 2));
        score = round3(Math.min(mScore, lScore, aScore));
      }
      const triggered = isNumericOverride
        ? activeFrameCount >= 5 && isMidBandVoiceLike && score >= threshold
        : activeFrameCount >= 5 &&
          isMidBandVoiceLike &&
          midOnlyRatio >= minMid &&
          lowWarmthRatio <= maxLow &&
          highAirRatio <= maxAir;

      return {
        triggered,
        score,
        threshold,
        evidence: `midOnly=${midOnlyRatio}, lowWarmth=${lowWarmthRatio}, highAir=${highAirRatio}, centroid=${centroid}Hz`,
        hint: "Restore full-bandwidth low warmth (<300 Hz) and natural high-frequency air (>3.4 kHz).",
        where: { freqHz: 1400 },
      };
    },
  },
  {
    id: "F20_STERILE_PURE_TONE",
    domain: "hollowness",
    name: "Sterile Pure Sine / Electronic Beep",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const top1Share = num(f.meanTop1PeakShare);
      const flatness = num(f.meanSpectralFlatness);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minTop1 = num(opts?.meanTop1PeakShare, 0.92);
      const maxFlat = num(opts?.meanSpectralFlatness, 0.03);

      let score = 0;
      if (activeFrameCount >= 5) {
        const pScore = clamp01((top1Share - (minTop1 - 0.08)) / 0.16);
        const fScore = clamp01((maxFlat * 2 - flatness) / (maxFlat * 2));
        score = round3(Math.min(pScore, fScore));
      }
      const triggered = isNumericOverride
        ? activeFrameCount >= 5 && score >= threshold
        : activeFrameCount >= 5 && top1Share >= minTop1 && flatness <= maxFlat;

      return {
        triggered,
        score,
        threshold,
        evidence: `top1PeakShare=${top1Share}, flatness=${flatness}`,
        hint: "Add warm harmonic overtones and gentle body resonance so the sound does not feel like a sterile beep.",
      };
    },
  },
];

export const SPECTRAL_EXTRA_FALSIFIERS = [
  {
    id: "F31_PRESSED_STRAIN",
    domain: "aggression",
    name: "Pressed / Strained Glottal Tension",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const voicedRatio = num(f.voicedRatio);
      const tiltDb = num(f.lowToMidTiltDb);
      const midHighFlatness = num(f.midHighFlatness);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxTiltDb = num(opts?.lowToMidTiltDb, -2.0);
      const maxWhisperFlatness = num(opts?.midHighFlatness, 0.18);
      const minVoiced = num(opts?.voicedRatio, 0.45);

      // Sasayaki (breathy whisper) guard: whispered speech has high mid-high noise flatness or low voicing
      const isWhisperGuarded = voicedRatio < minVoiced || midHighFlatness >= maxWhisperFlatness;
      let score = 0;
      if (activeFrameCount >= 5 && !isWhisperGuarded) {
        const tiltScore = clamp01((maxTiltDb + 4.0 - tiltDb) / 8.0);
        const harmScore = clamp01((maxWhisperFlatness + 0.06 - midHighFlatness) / 0.12);
        score = round3(Math.min(tiltScore, harmScore));
      }
      const triggered = isNumericOverride
        ? activeFrameCount >= 5 && !isWhisperGuarded && score >= threshold
        : activeFrameCount >= 5 && !isWhisperGuarded && tiltDb <= maxTiltDb;

      return {
        triggered,
        score,
        threshold,
        evidence: `lowToMidTilt=${tiltDb}dB, midHighFlatness=${midHighFlatness}, voicedRatio=${voicedRatio}`,
        hint: "Relax glottal pressing and restore warm low-frequency fundamental dominance over 1-3.5 kHz strain.",
        where: { freqHz: 2000 },
      };
    },
  },
  {
    id: "F32_SPECTRAL_STASIS",
    domain: "hollowness",
    name: "Frozen Spectral Stasis (Static Timbre)",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const meanFlux = num(f.meanSpectralFlux);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const maxFlux = num(opts?.meanSpectralFlux, 0.0005);

      const score =
        activeFrameCount >= 20 ? round3(clamp01((maxFlux * 2 - meanFlux) / (maxFlux * 2))) : 0;
      const triggered = isNumericOverride
        ? activeFrameCount >= 20 && score >= threshold
        : activeFrameCount >= 20 && meanFlux < maxFlux;

      return {
        triggered,
        score,
        threshold,
        evidence: `meanSpectralFlux=${meanFlux} (activeFrames=${activeFrameCount})`,
        hint: "Allow natural timbral evolution (formant movement, harmonic decay, or breath drift) over time.",
      };
    },
  },
  {
    id: "F33_REMOTE_BELTING",
    domain: "hollowness",
    name: "Remote Belting / Airless Mid-Low Projection",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const voicedRatio = num(f.voicedRatio);
      const voicedDurationSec = num(f.voicedDurationSec);
      const longestContinuousSec = num(f.longestContinuousSec);
      const meanHfRatio = num(f.meanHfRatio);
      const highAirRatio = num(f.highAirRatio);
      const centroid = num(f.spectralCentroidHz);
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.45);
      const maxHf = num(opts?.maxHfRatio, 0.075);
      const maxAir = num(opts?.maxHighAirRatio, 0.02);
      const maxCent = num(opts?.maxCentroidHz, 2600);
      const minVoiced = num(opts?.minVoicedRatio, 0.35);
      const minSustainedSec = num(opts?.minSustainedSec, 1.2);

      // Guard: sustained vocal projection (not brief warm chimes, lullabies, or short phrases)
      const eligible =
        activeFrameCount >= 10 &&
        voicedRatio >= minVoiced &&
        voicedDurationSec >= minSustainedSec &&
        longestContinuousSec >= minSustainedSec &&
        centroid >= 850 &&
        highAirRatio < maxAir;

      let score = 0;
      if (eligible) {
        const hfPen = clamp01((maxHf - meanHfRatio) / Math.max(0.01, maxHf - 0.01));
        const centPen = clamp01((maxCent - centroid) / 1400);
        score = round3(hfPen * centPen);
      }
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `hfRatio=${meanHfRatio}, air=${highAirRatio}, centroid=${centroid}Hz, maxRun=${longestContinuousSec}s`,
        hint: "Bring the voice closer with gentle high-frequency breath air (>4–6%) rather than projecting dark airless mid-low resonance.",
        where: centroid > 0 ? { freqHz: Math.round(centroid) } : undefined,
      };
    },
  },
  {
    id: "F34_CHIPMUNK_SHIFT",
    domain: "prosody_rhythm",
    name: "Chipmunk Over-Pitch / Vanished Chest Warmth",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const voicedRatio = num(f.voicedRatio);
      const medianF0 = num(f.medianF0);
      const lowWarmthRatio = num(f.lowWarmthRatio);
      const activeMpsSpeech4_16 = num(f.activeMpsSpeech4_16, num(f.mpsSpeech4_16, 0));
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minF0 = num(opts?.minF0Hz, 440);
      const maxF0 = num(opts?.maxF0Hz, 720);
      const maxWarmth = num(opts?.maxLowWarmthRatio, 0.025);
      const minVoiced = num(opts?.minVoicedRatio, 0.35);
      const minSpeechMod = num(opts?.minSpeechMod, 0.04);

      // Guard: syllabic speech in chipmunk register (excludes pure bird whistles & chimes)
      const eligible =
        activeFrameCount >= 10 &&
        voicedRatio >= minVoiced &&
        activeMpsSpeech4_16 >= minSpeechMod &&
        medianF0 >= minF0 &&
        medianF0 <= maxF0;

      let score = 0;
      if (eligible) {
        const f0Pen = clamp01((medianF0 - minF0) / 100);
        const noWarmth = clamp01((maxWarmth - lowWarmthRatio) / Math.max(0.005, maxWarmth));
        score = round3(f0Pen * noWarmth);
      }
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `medianF0=${medianF0}Hz, lowWarmth(80-300Hz)=${lowWarmthRatio}, mps4_16=${activeMpsSpeech4_16}`,
        hint: "Keep fundamental pitch in natural human range (<440 Hz) and preserve chest warmth instead of shrinking the whole vocal tract.",
        where: medianF0 > 0 ? { freqHz: Math.round(medianF0) } : undefined,
      };
    },
  },
  {
    id: "F35_SYNTHETIC_TUBE_FLATNESS",
    domain: "absence_of_presence",
    name: "Synthetic Tube Flatness / Missing Live Micro-Dynamics",
    detect(f, override) {
      const activeFrameCount = num(f.activeFrameCount);
      const voicedRatio = num(f.voicedRatio);
      const durationSec = num(f.durationSec);
      const jitter = num(f.jitter);
      const bodyBand80_200Db = num(f.bodyBand80_200Db, -90);
      const hf4500_7000Db = num(f.hf4500_7000Db, -90);
      const hiBand2800_11000StdDb = num(f.hiBand2800_11000StdDb, 0);
      const activeMpsSpeech4_16 = num(f.activeMpsSpeech4_16, num(f.mpsSpeech4_16, 0));
      const { threshold, isNumericOverride, opts } = resolveThreshold(override, 0.5);
      const minVoiced = num(opts?.minVoicedRatio, 0.4);
      const minDur = num(opts?.minDurationSec, 0.8);
      const minSpeechMod = num(opts?.minSpeechMod, 0.04);
      const minSmearedHfDb = num(opts?.minSmearedHfDb, -25);

      // Guard: speech-like voiced audio with smeared 4.5–7 kHz floor (excludes clean tonal instruments)
      const eligible =
        activeFrameCount >= 20 &&
        voicedRatio >= minVoiced &&
        durationSec >= minDur &&
        activeMpsSpeech4_16 >= minSpeechMod &&
        hf4500_7000Db >= minSmearedHfDb;

      let score = 0;
      if (eligible) {
        const pJit = clamp01((0.048 - jitter) / 0.022);
        const pBody = clamp01((-35 - bodyBand80_200Db) / 11);
        const pFlatHf =
          clamp01((hf4500_7000Db - -22) / 5) * clamp01((9.5 - hiBand2800_11000StdDb) / 3.5);
        score = round3(pJit * 0.4 + pBody * 0.35 + pFlatHf * 0.25);
      }
      const triggered = isNumericOverride ? eligible && score >= threshold : eligible && score >= threshold;

      return {
        triggered,
        score,
        threshold,
        evidence: `jitter=${jitter}, body80_200=${bodyBand80_200Db}dB, hf4.5_7k=${hf4500_7000Db}dB, hiStd=${hiBand2800_11000StdDb}dB`,
        hint: "Restore organic cycle-to-cycle glottal micro-jitter (~0.05+), 80–200 Hz chest/body floor, and clean vowel-vs-consonant HF contrast.",
      };
    },
  },
];

export const SPECTRAL_FALSIFIERS = [...SPECTRAL_CORE_FALSIFIERS, ...SPECTRAL_EXTRA_FALSIFIERS];
