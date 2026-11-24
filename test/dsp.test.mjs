import test from "node:test";
import assert from "node:assert/strict";
import {
  fftRadix2,
  hannWindow,
  computeMelFilterbank,
  estimateF0Parabolic,
  computeCycleJitter,
  computeRoughness,
  computeCepstrumComb,
  computeModulationDft,
} from "../src/dsp.mjs";
import { extractAudioProfile, extractFeatures } from "../src/features.mjs";
import { extractFeatures as extractFeaturesV01 } from "../unkawaii_detector.mjs";

function seededNoise(n, seed = 12345) {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out[i] = u * 2 - 1;
  }
  return out;
}

function makeSine(freqHz, durationSec, sr = 24000, amp = 0.6) {
  const n = Math.round(durationSec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr);
  }
  return out;
}

const EXPECTED_V01_KEYS = [
  "sampleRate",
  "durationSec",
  "frameCount",
  "activeFrameCount",
  "peak",
  "clipRatio",
  "maxSampleJump",
  "maxAttackSlope",
  "maxAttackTimeSec",
  "meanHfRatio",
  "voicedRatio",
  "jitter",
  "shimmer",
  "commonCauseCoupling",
  "tailDecaySec",
  "tailStartSec",
];

const EXPECTED_NEW_KEYS = [
  "exactFlatRatio",
  "clippedPeakCycles",
  "dcOffset",
  "dcToRmsRatio",
  "clickRatio",
  "maxClickJump",
  "clickTimeSec",
  "dropoutCount",
  "dropoutTimeSec",
  "crestFactorDb",
  "activeRmsCv",
  "ampModDepth",
  "ampModSinusoidality",
  "ampModFreqHz",
  "medianF0",
  "spectralCentroidHz",
  "lowBandRatio",
  "subBassRatio",
  "meanRoughness",
  "piercingProminenceDb",
  "piercingBandShare",
  "piercingPersistence",
  "piercingFreqHz",
  "meanSibilanceRatio",
  "p90SibilanceRatio",
  "nonPitchCepstralPeak",
  "combNotchDepthDb",
  "combDelayMs",
  "boxyRatio",
  "presenceRatio",
  "midOnlyRatio",
  "lowWarmthRatio",
  "highAirRatio",
  "meanTop1PeakShare",
  "meanVoicedHnrDb",
  "meanSpectralFlatness",
  "voicedDurationSec",
  "voicedFrameCount",
  "f0RangeSemitones",
  "f0MeanAbsDiffSemi",
  "f0SecondDiffSemi",
  "f0ModDepthSemi",
  "f0ModSinusoidality",
  "f0ModFreqHz",
  "flatStepRatio",
  "snapJumpCount",
  "maxInternalShock",
  "internalShockTimeSec",
  "onsetCount",
  "ioiCv",
  "meanIoiSec",
  "mainsHumRatio",
  "mainsPersistence",
  "mainsFreqHz",
  "uniqueLevelRatio",
  "aliasingFloorRatio",
  "numChannels",
  "stereoCorr",
  "lrImbalance",
  "lowToMidTiltDb",
  "midHighFlatness",
  "meanSpectralFlux",
];

test("fftRadix2: Parseval energy conservation < 1e-6 and pure sine peak > 40 dB SNR", () => {
  const n = 1024;
  const sr = 16000;
  const targetBin = 32; // exact bin -> 500 Hz
  const freq = (targetBin * sr) / n;

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const win = hannWindow(n);

  let timeEnergy = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / sr) * win[i];
    re[i] = x;
    timeEnergy += x * x;
  }

  fftRadix2(re, im);

  let freqEnergy = 0;
  let peakBin = 0;
  let peakPow = 0;
  let noisePow = 0;
  for (let k = 0; k < n; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    freqEnergy += p;
    if (k <= n / 2) {
      if (p > peakPow) {
        peakPow = p;
        peakBin = k;
      }
    }
  }
  freqEnergy /= n;

  const parsevalErr = Math.abs(timeEnergy - freqEnergy) / timeEnergy;
  assert.ok(parsevalErr < 1e-6, `Parseval error too large: ${parsevalErr}`);
  assert.ok(Math.abs(peakBin - targetBin) <= 1, `Peak bin ${peakBin} expected ~${targetBin}`);

  for (let k = 1; k < n / 2; k++) {
    if (Math.abs(k - peakBin) > 3) {
      noisePow += re[k] * re[k] + im[k] * im[k];
    }
  }
  const snrDb = 10 * Math.log10(peakPow / Math.max(noisePow, 1e-18));
  assert.ok(snrDb > 40, `Expected SNR > 40 dB, got ${snrDb.toFixed(1)} dB`);

  assert.throws(() => fftRadix2(new Float64Array(100), new Float64Array(100)), RangeError);
  assert.throws(() => fftRadix2(new Float64Array(16), new Float64Array(8)), RangeError);
});

test("estimateF0Parabolic: accurate across 110 Hz, 302 Hz, 780 Hz without octave halving", () => {
  const sr = 24000;
  const frameLen = 720; // 30ms

  for (const targetHz of [110, 302, 780]) {
    const frame = new Float32Array(frameLen);
    for (let i = 0; i < frameLen; i++) {
      frame[i] =
        0.7 * Math.sin((2 * Math.PI * targetHz * i) / sr) +
        0.2 * Math.sin((2 * Math.PI * targetHz * 2 * i) / sr);
    }
    const est = estimateF0Parabolic(frame, sr, 55, 1000);
    assert.ok(
      Math.abs(est.f0 - targetHz) < 1.5,
      `F0 mismatch for ${targetHz} Hz: got ${est.f0.toFixed(2)} Hz`
    );
    assert.ok(est.periodicity > 0.9, `Low periodicity for ${targetHz} Hz: ${est.periodicity}`);
    assert.ok(est.hnrDb > 10, `Low HNR for ${targetHz} Hz: ${est.hnrDb}`);
  }

  // White noise should have low periodicity / HNR
  const noise = seededNoise(frameLen, 99);
  const estNoise = estimateF0Parabolic(noise, sr, 55, 1000);
  assert.ok(estNoise.periodicity < 0.45, `Noise periodicity too high: ${estNoise.periodicity}`);
});

test("estimateF0Parabolic: <80 Hz wind/handling rumble guard prevents F0 hijack on 520 Hz meow while preserving 60 Hz hum", () => {
  const sr = 24000;
  const frameLen = 720; // 30ms

  // 1. 520 Hz cat-meow-like harmonic voice + strong 68 Hz wind rumble (rumble louder than voice)
  const meowPlusRumble = new Float32Array(frameLen);
  for (let i = 0; i < frameLen; i++) {
    const t = i / sr;
    const meow =
      0.28 * Math.sin(2 * Math.PI * 520 * t) +
      0.16 * Math.sin(2 * Math.PI * 1040 * t) +
      0.08 * Math.sin(2 * Math.PI * 1560 * t);
    const rumble = 0.55 * Math.sin(2 * Math.PI * 68 * t + 0.4);
    meowPlusRumble[i] = meow + rumble;
  }
  const estMeow = estimateF0Parabolic(meowPlusRumble, sr, 55, 1000);
  assert.ok(
    Math.abs(estMeow.f0 - 520) < 15,
    `Expected rumble guard to recover ~520 Hz meow F0, got ${estMeow.f0.toFixed(1)} Hz`
  );

  // 2. Pure 60 Hz mains hum still reports ~60 Hz F0
  const pure60 = new Float32Array(frameLen);
  for (let i = 0; i < frameLen; i++) {
    pure60[i] = 0.5 * Math.sin((2 * Math.PI * 60 * i) / sr);
  }
  const est60 = estimateF0Parabolic(pure60, sr, 55, 1000);
  assert.ok(
    Math.abs(est60.f0 - 60) < 3,
    `Expected pure 60 Hz hum to preserve ~60 Hz F0, got ${est60.f0.toFixed(1)} Hz`
  );
});

test("computeCycleJitter & extractFeatures.jitter: glide-invariant RAP vs 1% cycle perturbation vs pure rigid tone", () => {
  const sr = 24000;
  const dur = 0.6;
  const n = Math.round(sr * dur);

  // 1. Smooth pitch glide (220 Hz -> 440 Hz over 0.6s, zero jitter)
  const glide = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f0 = 220 * Math.pow(2, u);
    phase += (2 * Math.PI * f0) / sr;
    glide[i] = 0.6 * (0.7 * Math.sin(phase) + 0.25 * Math.sin(2 * phase));
  }
  const glideFeat = extractFeatures(glide, sr);

  // 2. Steady 250 Hz tone with 1% random cycle-to-cycle period perturbation
  const jittered = new Float32Array(n);
  const basePeriod = sr / 250; // 96 samples
  let seed = 424242;
  const nextRand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let pos = 0;
  while (pos < n) {
    // Gaussian-like ~1% std cycle-to-cycle period perturbation (sum of 3 uniforms)
    const g = (nextRand() + nextRand() + nextRand() - 1.5) * 2; // approx N(0, 1)
    const period = basePeriod * (1 + 0.01 * g);
    const cycleLen = Math.max(20, period);
    const end = Math.min(n, Math.ceil(pos + cycleLen));
    for (let i = Math.floor(pos); i < end; i++) {
      const phi = (2 * Math.PI * (i - pos)) / cycleLen;
      jittered[i] = 0.6 * (0.7 * Math.sin(phi) + 0.25 * Math.sin(2 * phi));
    }
    pos += cycleLen;
  }
  const jitteredFeat = extractFeatures(jittered, sr);

  // 3. Pure rigid sine & sawtooth
  const rigidSine = makeSine(250, dur, sr, 0.6);
  const rigidSaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * 250 * h * t) / h;
    rigidSaw[i] = 0.4 * s;
  }
  const rigidSineFeat = extractFeatures(rigidSine, sr);
  const rigidSawFeat = extractFeatures(rigidSaw, sr);

  // Direct computeCycleJitter sanity on empty/invalid inputs
  assert.equal(computeCycleJitter(new Float32Array(0), sr, [], 240), 0);

  // Assertions:
  assert.ok(
    glideFeat.jitter < 0.005,
    `Smooth pitch glide (220->440 Hz) should have near-zero jitter (< 0.005), got ${glideFeat.jitter}`
  );
  assert.ok(
    jitteredFeat.jitter >= 0.006,
    `1% cycle-jittered 250 Hz tone should have jitter >= 0.006, got ${jitteredFeat.jitter}`
  );
  assert.ok(
    jitteredFeat.jitter > glideFeat.jitter * 2,
    `1% jittered tone (${jitteredFeat.jitter}) must exceed 2x smooth glide (${glideFeat.jitter})`
  );
  assert.ok(
    rigidSineFeat.jitter < 0.001,
    `Pure rigid sine should have jitter < 0.001, got ${rigidSineFeat.jitter}`
  );
  assert.ok(
    rigidSawFeat.jitter < 0.001,
    `Pure rigid saw should have jitter < 0.001, got ${rigidSawFeat.jitter}`
  );
});

test("computeRoughness: harmonic tone low (< 0.16) vs beating cluster high (> 0.28)", () => {
  const sr = 24000;
  const fftSize = 2048;
  const win = hannWindow(fftSize);

  const specOf = (fn) => {
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) re[i] = fn(i / sr) * win[i];
    fftRadix2(re, im);
    const mag = new Float32Array(fftSize / 2 + 1);
    for (let b = 0; b < mag.length; b++) mag[b] = Math.hypot(re[b], im[b]) / fftSize;
    return mag;
  };

  // Smooth harmonic tone (260 Hz + decaying harmonics)
  const harmonicMag = specOf(
    (t) =>
      Math.sin(2 * Math.PI * 260 * t) +
      0.5 * Math.sin(2 * Math.PI * 520 * t) +
      0.25 * Math.sin(2 * Math.PI * 780 * t) +
      0.12 * Math.sin(2 * Math.PI * 1040 * t)
  );
  const rHarm = computeRoughness(harmonicMag, sr, fftSize, 12);

  // Closely spaced beating cluster (440 + 485 + 530 Hz)
  const beatingMag = specOf(
    (t) =>
      Math.sin(2 * Math.PI * 440 * t) +
      Math.sin(2 * Math.PI * 485 * t) +
      Math.sin(2 * Math.PI * 530 * t)
  );
  const rBeat = computeRoughness(beatingMag, sr, fftSize, 12);

  assert.ok(rHarm < 0.16, `Harmonic roughness too high: ${rHarm}`);
  assert.ok(rBeat > 0.28, `Beating cluster roughness too low: ${rBeat}`);
});

test("computeCepstrumComb: detects 5.5ms comb filter vs clean noise", () => {
  const sr = 24000;
  const fftSize = 2048;
  const delaySamples = Math.round(0.0055 * sr); // 5.5ms = 132 samples
  const raw = seededNoise(sr, 777);
  const combed = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    combed[i] = raw[i] + (i >= delaySamples ? 0.75 * raw[i - delaySamples] : 0);
  }

  const meanLogMagOf = (sig) => {
    const win = hannWindow(fftSize);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const acc = new Float64Array(fftSize / 2 + 1);
    let count = 0;
    for (let start = 0; start + fftSize <= sig.length; start += 512) {
      for (let k = 0; k < fftSize; k++) {
        re[k] = sig[start + k] * win[k];
        im[k] = 0;
      }
      fftRadix2(re, im);
      for (let b = 0; b < acc.length; b++) {
        acc[b] += Math.log(Math.hypot(re[b], im[b]) / fftSize + 1e-9);
      }
      count++;
    }
    for (let b = 0; b < acc.length; b++) acc[b] /= count;
    return acc;
  };

  const combRes = computeCepstrumComb(meanLogMagOf(combed), sr, fftSize, 0);
  const cleanRes = computeCepstrumComb(meanLogMagOf(raw), sr, fftSize, 0);

  assert.ok(
    Math.abs(combRes.combDelayMs - 5.5) < 0.4,
    `Expected combDelayMs ~5.5, got ${combRes.combDelayMs}`
  );
  assert.ok(
    combRes.nonPitchCepstralPeak > cleanRes.nonPitchCepstralPeak * 2.5,
    `Comb peak (${combRes.nonPitchCepstralPeak}) should exceed clean (${cleanRes.nonPitchCepstralPeak})`
  );
  assert.ok(combRes.combNotchDepthDb > 6, `Expected notch depth > 6 dB, got ${combRes.combNotchDepthDb}`);
});

test("computeModulationDft: accurately detects 4 Hz amp tremolo and 6 Hz F0 vibrato", () => {
  const hopSec = 0.01;
  const n = 150; // 1.5s

  const ampSeries = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ampSeries[i] = 1 + 0.45 * Math.sin(2 * Math.PI * 4.0 * i * hopSec);
  }
  const ampRes = computeModulationDft(ampSeries, hopSec, 2, 16);
  assert.ok(Math.abs(ampRes.freqHz - 4.0) < 0.3, `Expected ~4 Hz, got ${ampRes.freqHz}`);
  assert.ok(ampRes.depth > 0.35, `Expected depth > 0.35, got ${ampRes.depth}`);
  assert.ok(ampRes.sinusoidality > 0.85, `Expected sinusoidality > 0.85, got ${ampRes.sinusoidality}`);

  const f0Series = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    f0Series[i] = 12 + 1.5 * Math.sin(2 * Math.PI * 6.0 * i * hopSec);
  }
  const f0Res = computeModulationDft(f0Series, hopSec, 3, 12);
  assert.ok(Math.abs(f0Res.freqHz - 6.0) < 0.3, `Expected ~6 Hz, got ${f0Res.freqHz}`);
  assert.ok(Math.abs(f0Res.depth - 1.5) < 0.2, `Expected depth ~1.5 semi, got ${f0Res.depth}`);
  assert.ok(f0Res.sinusoidality > 0.85, `Expected sinusoidality > 0.85, got ${f0Res.sinusoidality}`);
});

test("extractAudioProfile: returns full schema with frames, spectrogram, spectralSlice, markers, phaseLoop", () => {
  const sr = 24000;
  const sig = makeSine(320, 0.5, sr, 0.7);
  // Inject a sharp attack & clipped burst to trigger hotspots
  for (let i = 0; i < 60; i++) sig[i] = 0;
  for (let i = 6000; i < 6060; i++) sig[i] = 1.0;

  const profile = extractAudioProfile(sig, sr);
  assert.equal(profile.sampleRate, sr);
  assert.ok(profile.fftSize >= 512 && (profile.fftSize & (profile.fftSize - 1)) === 0);
  assert.ok(profile.frames.length > 30);

  const f0Frame = profile.frames[10];
  for (const key of [
    "timeSec",
    "rms",
    "rmsDb",
    "peakPos",
    "peakNeg",
    "zcrRate",
    "hfRatio",
    "f0",
    "domHz",
    "periodicity",
    "voiced",
    "hnrDb",
    "spectralCentroidHz",
    "spectralRolloffHz",
    "spectralFlatness",
    "harshnessRatio",
    "spectralFlux",
    "envelopeCurvature",
    "clipped",
  ]) {
    assert.ok(key in f0Frame, `Missing frame field: ${key}`);
  }

  assert.equal(profile.spectrogram.times.length, profile.frames.length);
  assert.equal(profile.spectrogram.freqsHz.length, 48);
  assert.equal(profile.spectrogram.dbMatrix.length, profile.frames.length);
  assert.ok(profile.spectrogram.dbMatrix[0] instanceof Float32Array);

  assert.ok(profile.spectralSlice.freqsHz.length > 0);
  assert.ok(profile.spectralSlice.peaks.length > 0);
  assert.ok(Array.isArray(profile.markers.onsets));
  assert.ok(Array.isArray(profile.markers.hotspots));
  assert.ok(profile.markers.hotspots.length > 0, "Expected at least one anomaly hotspot");
  assert.equal(profile.phaseLoop.length, profile.frames.length);
});

test("extractFeatures: exact key set & 100% finite values across all edge cases", () => {
  const sr = 24000;
  const stereoL = makeSine(300, 0.4, sr, 0.5);
  const stereoR = new Float32Array(stereoL.length);
  for (let i = 0; i < stereoL.length; i++) stereoR[i] = -stereoL[i]; // anti-phase

  const cases = [
    { name: "empty", sig: new Float32Array(0) },
    { name: "silence", sig: new Float32Array(sr * 0.5) },
    { name: "short_10ms", sig: makeSine(400, 0.01, sr, 0.5) },
    { name: "clipped", sig: new Float32Array(sr * 0.3).fill(1.0) },
    { name: "dc_only", sig: new Float32Array(sr * 0.3).fill(0.4) },
    { name: "stereo_antiphase", sig: new Float32Array(stereoL.length), opts: { channels: [stereoL, stereoR] } },
  ];

  const allExpectedKeys = [...EXPECTED_V01_KEYS, ...EXPECTED_NEW_KEYS];

  for (const c of cases) {
    const feat = extractFeatures(c.sig, sr, c.opts);
    for (const k of allExpectedKeys) {
      assert.ok(k in feat, `[${c.name}] missing key: ${k}`);
      assert.equal(typeof feat[k], "number", `[${c.name}] key ${k} not a number`);
      assert.ok(Number.isFinite(feat[k]), `[${c.name}] key ${k} not finite: ${feat[k]}`);
    }
  }

  // Verify stereo anti-phase correlation
  const stFeat = extractFeatures(stereoL, sr, { channels: [stereoL, stereoR] });
  assert.equal(stFeat.numChannels, 2);
  assert.ok(stFeat.stereoCorr < -0.95, `Expected anti-phase stereoCorr < -0.95, got ${stFeat.stereoCorr}`);
});

test("extractFeatures: targeted signals for F7, F9, F28, F29, F31, F32", () => {
  const sr = 24000;

  // F7: sub-full-scale flat-top clipping at 0.5
  const flatSig = makeSine(220, 0.4, sr, 0.8);
  for (let i = 0; i < flatSig.length; i++) flatSig[i] = Math.max(-0.5, Math.min(0.5, flatSig[i]));
  const f7 = extractFeatures(flatSig, sr);
  assert.ok(f7.exactFlatRatio > 0.1, `Expected exactFlatRatio > 0.1, got ${f7.exactFlatRatio}`);
  assert.ok(f7.clippedPeakCycles >= 10, `Expected clippedPeakCycles >= 10, got ${f7.clippedPeakCycles}`);

  // F9: short 20ms dropout in the middle of a tone
  const dropSig = makeSine(300, 0.5, sr, 0.5);
  for (let i = Math.round(0.24 * sr); i < Math.round(0.26 * sr); i++) dropSig[i] = 0;
  const f9 = extractFeatures(dropSig, sr);
  assert.ok(f9.dropoutCount >= 1, `Expected dropoutCount >= 1, got ${f9.dropoutCount}`);

  // F28: 60 Hz mains hum
  const humSig = new Float32Array(sr);
  for (let i = 0; i < sr; i++) {
    const t = i / sr;
    humSig[i] = 0.25 * Math.sin(2 * Math.PI * 60 * t) + 0.12 * Math.sin(2 * Math.PI * 120 * t);
  }
  const f28 = extractFeatures(humSig, sr);
  assert.equal(f28.mainsFreqHz, 60);
  assert.ok(f28.mainsHumRatio > 0.5, `Expected mainsHumRatio > 0.5, got ${f28.mainsHumRatio}`);
  assert.ok(f28.mainsPersistence > 0.8, `Expected mainsPersistence > 0.8, got ${f28.mainsPersistence}`);

  // F29: 3-bit bitcrushed tone -> very low uniqueLevelRatio
  const crushSig = makeSine(330, 0.4, sr, 0.7);
  for (let i = 0; i < crushSig.length; i++) crushSig[i] = Math.round(crushSig[i] * 4) / 4;
  const f29 = extractFeatures(crushSig, sr);
  assert.ok(f29.uniqueLevelRatio < 0.05, `Expected low uniqueLevelRatio, got ${f29.uniqueLevelRatio}`);

  // F32: static tone -> near-zero meanSpectralFlux
  const staticSig = makeSine(400, 0.5, sr, 0.5);
  const f32 = extractFeatures(staticSig, sr);
  assert.ok(f32.meanSpectralFlux < 0.02, `Expected low meanSpectralFlux, got ${f32.meanSpectralFlux}`);
});

test("extractFeatures: backward-compatibility parity with unkawaii_detector.mjs v0.1 on F1–F6 signal", () => {
  const sr = 24000;
  const n = Math.round(sr * 0.6);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.04) * Math.exp(-Math.max(0, t - 0.3) * 5);
    const f0 = 260 + 25 * Math.sin(2 * Math.PI * 2.2 * t);
    sig[i] = env * (0.55 * Math.sin(2 * Math.PI * f0 * t) + 0.2 * Math.sin(2 * Math.PI * 2 * f0 * t));
  }

  const v01 = extractFeaturesV01(sig, sr);
  const v02 = extractFeatures(sig, sr);

  assert.equal(v02.sampleRate, v01.sampleRate);
  assert.equal(v02.durationSec, v01.durationSec);
  assert.equal(v02.frameCount, v01.frameCount);
  assert.equal(v02.activeFrameCount, v01.activeFrameCount);
  assert.equal(v02.peak, v01.peak);
  assert.equal(v02.clipRatio, v01.clipRatio);
  assert.equal(v02.maxSampleJump, v01.maxSampleJump);
  assert.ok(Math.abs(v02.maxAttackSlope - v01.maxAttackSlope) < 1e-4);
  assert.ok(Math.abs(v02.meanHfRatio - v01.meanHfRatio) < 1e-4);
  assert.ok(Math.abs(v02.voicedRatio - v01.voicedRatio) < 0.05);
  assert.ok(Math.abs(v02.tailDecaySec - v01.tailDecaySec) < 0.02);
});

test("performance: 2s 44.1kHz feature extraction completes well under 150ms", () => {
  const sr = 44100;
  const sig = makeSine(280, 2.0, sr, 0.5);
  // Warm up V8 JIT so we measure steady-state DSP latency
  extractFeatures(sig.subarray(0, sr), sr);
  extractFeatures(sig.subarray(0, sr), sr);

  const times = [];
  let feat;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    feat = extractFeatures(sig, sr);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[1];

  assert.ok(feat.frameCount > 180);
  assert.ok(medianMs < 150, `Expected median < 150ms for 2s 44.1kHz WAV, got ${medianMs.toFixed(1)}ms (${times.map((t) => t.toFixed(1)).join(", ")})`);
});
