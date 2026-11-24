/**
 * src/features.mjs — Backward-compatible v0.1 + F7–F32 feature extractor
 * and full AudioProfile extractor for LLM Audio Vision.
 *
 * Zero external dependencies. Pure ES Module.
 */

import {
  fftRadix2,
  hannWindow,
  computeMelFilterbank,
  estimateF0Parabolic,
  computeCycleJitter,
  computeRoughness,
  computeCepstrumComb,
  computeModulationDft,
  computeMpsRoughness,
  computeSubharmonicRatio,
  pearson,
  median,
  percentile,
} from "./dsp.mjs";

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function roundTo(v, digits) {
  const f = finite(v, 0);
  const scale = Math.pow(10, digits);
  return Math.round(f * scale) / scale;
}

function nextPow2(v) {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

function meanOf(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stdOf(arr, m = null) {
  if (arr.length < 2) return 0;
  const mu = m === null ? meanOf(arr) : m;
  let sq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - mu;
    sq += d * d;
  }
  return Math.sqrt(sq / arr.length);
}

/**
 * Evaluate exact 50/100/150 Hz vs 60/120/180 Hz mains hum across the entire signal
 * using 200ms Hann-windowed Goertzel/DFT blocks so 50 Hz and 60 Hz are cleanly resolved.
 */
function analyzeMainsHum(samples, sampleRate) {
  const rawN = samples.length;
  if (rawN < 64 || sampleRate <= 0) {
    return { mainsHumRatio: 0, mainsPersistence: 0, mainsFreqHz: 0 };
  }

  // Decimate via box-averaging to ~2400 Hz (Nyquist ~1200 Hz >> 180 Hz) for >15x speedup
  const decFactor = sampleRate > 3000 ? Math.max(1, Math.floor(sampleRate / 2400)) : 1;
  const sr = sampleRate / decFactor;
  const n = Math.floor(rawN / decFactor);
  if (n < 32) {
    return { mainsHumRatio: 0, mainsPersistence: 0, mainsFreqHz: 0 };
  }

  const sig = decFactor > 1 ? new Float32Array(n) : samples;
  if (decFactor > 1) {
    const invDec = 1 / decFactor;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const base = i * decFactor;
      for (let k = 0; k < decFactor; k++) s += samples[base + k];
      sig[i] = s * invDec;
    }
  }

  const blockLen = Math.min(n, Math.max(32, Math.round(sr * 0.2)));
  const step = Math.max(16, Math.round(blockLen * 0.5));
  const win = hannWindow(blockLen);
  let winSqSum = 0;
  for (let i = 0; i < blockLen; i++) winSqSum += win[i] * win[i];
  if (winSqSum <= 1e-12) {
    return { mainsHumRatio: 0, mainsPersistence: 0, mainsFreqHz: 0 };
  }

  const freqs50 = [50, 100, 150];
  const freqs60 = [60, 120, 180];

  const tonePower = (start, freqHz, mean) => {
    const omega = (2 * Math.PI * freqHz) / sr;
    const cosW = Math.cos(omega);
    const sinW = Math.sin(omega);
    let c = 1;
    let s = 0;
    let re = 0;
    let im = 0;
    for (let i = 0; i < blockLen; i++) {
      const x = (sig[start + i] - mean) * win[i];
      re += x * c;
      im -= x * s;
      const nc = c * cosW - s * sinW;
      s = s * cosW + c * sinW;
      c = nc;
    }
    return (2 * (re * re + im * im)) / (blockLen * winSqSum);
  };

  let ratio50Sum = 0;
  let ratio60Sum = 0;
  let persist50 = 0;
  let persist60 = 0;
  let blockCount = 0;

  for (let start = 0; start + blockLen <= n; start += step) {
    let mean = 0;
    for (let i = 0; i < blockLen; i++) mean += sig[start + i];
    mean /= blockLen;

    let totalPower = 0;
    for (let i = 0; i < blockLen; i++) {
      const x = (sig[start + i] - mean) * win[i];
      totalPower += x * x;
    }
    totalPower /= winSqSum;

    let p50 = 0;
    let p60 = 0;
    if (totalPower > 1e-12) {
      for (const f of freqs50) p50 += tonePower(start, f, mean);
      for (const f of freqs60) p60 += tonePower(start, f, mean);
    }

    const r50 = totalPower > 1e-12 ? Math.min(1, p50 / totalPower) : 0;
    const r60 = totalPower > 1e-12 ? Math.min(1, p60 / totalPower) : 0;
    ratio50Sum += r50;
    ratio60Sum += r60;
    if (r50 >= 0.05 && p50 > 1e-9) persist50++;
    if (r60 >= 0.05 && p60 > 1e-9) persist60++;
    blockCount++;
  }

  if (blockCount === 0) {
    return { mainsHumRatio: 0, mainsPersistence: 0, mainsFreqHz: 0 };
  }

  const mean50 = ratio50Sum / blockCount;
  const mean60 = ratio60Sum / blockCount;

  if (mean60 >= mean50) {
    return {
      mainsHumRatio: mean60,
      mainsPersistence: persist60 / blockCount,
      mainsFreqHz: mean60 > 1e-5 ? 60 : 0,
    };
  }
  return {
    mainsHumRatio: mean50,
    mainsPersistence: persist50 / blockCount,
    mainsFreqHz: mean50 > 1e-5 ? 50 : 0,
  };
}

/**
 * Core single-pass STFT + frame analysis shared by extractAudioProfile and extractFeatures.
 */
function runCoreAnalysis(samplesInput, sampleRateInput, opts = {}) {
  const samples = samplesInput ?? new Float32Array(0);
  const n = samples.length;
  const sampleRate = Number.isFinite(sampleRateInput) && sampleRateInput > 0 ? sampleRateInput : 44100;
  const durationSec = n / sampleRate;

  const hopMs = opts.hopMs ?? 10;
  const melBands = opts.melBands ?? 48;
  const fMin = opts.fMin ?? 30;
  const fMax = opts.fMax ?? 8000;

  const frameSize = Math.max(256, Math.round(sampleRate * 0.025)); // 25ms (v0.1 exact)
  const hopSize = Math.max(128, Math.round(sampleRate * (hopMs / 1000))); // 10ms (v0.1 exact)
  const hopSec = hopSize / sampleRate;
  const fftSize = opts.fftSize
    ? nextPow2(Math.max(256, opts.fftSize))
    : nextPow2(Math.max(512, frameSize));
  const halfBins = (fftSize >> 1) + 1;
  const binHz = sampleRate / fftSize;

  // Global waveform scan: peak, clipCount, maxSampleJump, DC offset, exact flat-top clipping, click jumps
  let peak = 0;
  let clipCount = 0;
  let maxSampleJump = 0;
  let sumAll = 0;
  let diffSqAll = 0;
  let maxRawDiff = 0;
  let maxRawDiffIdx = 0;

  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(samples[i]) ? samples[i] : 0;
    const a = Math.abs(x);
    sumAll += x;
    if (a > peak) peak = a;
    if (a >= 0.995) clipCount++;
    if (i > 0) {
      const prev = Number.isFinite(samples[i - 1]) ? samples[i - 1] : 0;
      const d = Math.abs(x - prev);
      diffSqAll += d * d;
      if (d > maxSampleJump) maxSampleJump = d;
      if (d > maxRawDiff) {
        maxRawDiff = d;
        maxRawDiffIdx = i;
      }
    }
  }

  const dcOffset = n > 0 ? sumAll / n : 0;
  let acSqSum = 0;
  for (let i = 0; i < n; i++) {
    const x = (Number.isFinite(samples[i]) ? samples[i] : 0) - dcOffset;
    acSqSum += x * x;
  }
  const acRms = n > 0 ? Math.sqrt(acSqSum / n) : 0;
  const dcToRmsRatio =
    Math.abs(dcOffset) > 1e-9
      ? acRms > 1e-6
        ? Math.min(100, Math.abs(dcOffset) / acRms)
        : 100
      : 0;

  // F7: Sub-full-scale flat-top clipping plateau detection
  let exactFlatSamples = 0;
  let clippedPeakCycles = 0;
  if (peak > 1e-4 && n >= 4) {
    const flatAmpThresh = 0.97 * peak;
    const flatDiffThresh = 1.5e-4 * peak;
    let runLen = 1;
    let inPlateau = Math.abs(samples[0]) >= flatAmpThresh;
    for (let i = 1; i < n; i++) {
      const x = Number.isFinite(samples[i]) ? samples[i] : 0;
      const prev = Number.isFinite(samples[i - 1]) ? samples[i - 1] : 0;
      const sameHigh =
        Math.abs(x) >= flatAmpThresh &&
        Math.abs(prev) >= flatAmpThresh &&
        Math.sign(x) === Math.sign(prev) &&
        Math.abs(x - prev) <= flatDiffThresh;
      if (sameHigh) {
        if (!inPlateau) {
          inPlateau = true;
          runLen = 2;
        } else {
          runLen++;
        }
      } else {
        if (inPlateau && runLen >= 4) {
          exactFlatSamples += runLen;
          clippedPeakCycles++;
        }
        inPlateau = Math.abs(x) >= flatAmpThresh;
        runLen = 1;
      }
    }
    if (inPlateau && runLen >= 4) {
      exactFlatSamples += runLen;
      clippedPeakCycles++;
    }
  }
  const exactFlatRatio = n > 0 ? exactFlatSamples / n : 0;

  // Scale-invariant normalized buffer (matching v0.1)
  const norm = new Float32Array(n);
  const invPeak = peak > 1e-6 ? 1 / peak : 1;
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(samples[i]) ? samples[i] : 0;
    norm[i] = x * invPeak;
  }

  // Precompute STFT window & Mel filterbank
  const win = hannWindow(fftSize);
  const melFb = computeMelFilterbank(fftSize, sampleRate, melBands, fMin, fMax);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const mag = new Float32Array(halfBins);
  const pow = new Float32Array(halfBins);
  const powPrefix = new Float64Array(halfBins + 1);
  const neighScratch = new Float32Array(36);

  // Band bin bounds
  const binOf = (hz) => Math.max(0, Math.min(halfBins - 1, Math.round(hz / binHz)));
  const b20 = Math.max(1, binOf(20));
  const b60 = Math.max(1, binOf(60));
  const b80 = Math.max(1, binOf(80));
  const b90 = binOf(90);
  const b200 = binOf(200);
  const b250 = binOf(250);
  const b300 = binOf(300);
  const b600 = binOf(600);
  const b650 = binOf(650);
  const b1000 = binOf(1000);
  const b2000 = binOf(2000);
  const b2500 = binOf(2500);
  const b2800 = binOf(2800);
  const b3400 = binOf(3400);
  const b3500 = binOf(3500);
  const b4000 = binOf(4000);
  const b4500 = binOf(4500);
  const b5000 = binOf(5000);
  const b5500 = binOf(5500);
  const b6500 = binOf(6500);
  const b7000 = binOf(7000);
  const b8000 = binOf(8000);
  const b10000 = binOf(10000);
  const b11000 = binOf(11000);
  const aliasStartBin = sampleRate > 16000 ? b8000 : Math.max(1, Math.floor((halfBins - 1) * 0.7));
  const minDomBin = Math.max(1, Math.ceil(50 / binHz));

  const frames = [];
  const frameExtras = [];
  const dbMatrix = [];
  const times = [];

  // Accumulators for spectralSlice and cepstrum
  const meanPow = new Float64Array(halfBins);
  const peakPow = new Float64Array(halfBins);
  const meanLogMag = new Float64Array(halfBins);
  let specFrameCount = 0;

  let prevMelNorm = null;
  let minDb = Infinity;
  let maxDb = -Infinity;

  const invFft = 1 / fftSize;
  const invFftSq = invFft * invFft;
  const numAcBins = Math.max(1, halfBins - 1);
  const mhCount = Math.max(1, b4000 - b1000 + 1);

  for (let start = 0; start + frameSize <= n; start += hopSize) {
    let sumSq = 0;
    let rawSumSq = 0;
    let zcr = 0;
    let diffSq = 0;
    let peakPos = -Infinity;
    let peakNeg = Infinity;
    let clipped = false;

    for (let j = 0; j < frameSize; j++) {
      const idx = start + j;
      const x = norm[idx];
      const raw = samples[idx];
      sumSq += x * x;
      rawSumSq += raw * raw;
      if (raw > peakPos) peakPos = raw;
      if (raw < peakNeg) peakNeg = raw;
      if (raw >= 0.995 || raw <= -0.995) clipped = true;
      if (j > 0) {
        const prev = norm[idx - 1];
        if ((x >= 0 && prev < 0) || (x < 0 && prev >= 0)) zcr++;
        const d = x - prev;
        diffSq += d * d;
      }
    }

    const rms = Math.sqrt(sumSq / frameSize);
    const rawRms = Math.sqrt(rawSumSq / frameSize);
    const rmsDb = 20 * Math.log10(Math.max(rms, 1e-6));
    const zcrRate = zcr / frameSize;
    const hfRatio = sumSq > 1e-8 ? Math.min(1, diffSq / (sumSq * 2.0)) : 0;

    // F0 & periodicity (FFT-accelerated parabolic autocorrelation)
    let f0 = 0;
    let periodicity = 0;
    let hnrDb = 0;
    if (rms > 0.04) {
      const est = estimateF0Parabolic(norm.subarray(start, start + frameSize), sampleRate, 55, 1000);
      periodicity = est.periodicity;
      hnrDb = est.hnrDb;
      if (periodicity >= 0.55 && rms > 0.05) {
        f0 = est.f0;
      }
    }
    const voiced = periodicity >= 0.55 && rms > 0.05;

    // Center STFT window on frame center and remove local DC before windowing
    const center = start + (frameSize >> 1);
    const winStart = center - (fftSize >> 1);
    const clStart = Math.max(0, winStart);
    const clEnd = Math.min(n, winStart + fftSize);
    let winMean = 0;
    for (let idx = clStart; idx < clEnd; idx++) winMean += norm[idx];
    winMean = clEnd > clStart ? winMean / (clEnd - clStart) : 0;

    for (let k = 0; k < fftSize; k++) {
      const idx = winStart + k;
      const sampleVal = idx >= 0 && idx < n ? norm[idx] - winMean : 0;
      re[k] = sampleVal * win[k];
      im[k] = 0;
    }
    fftRadix2(re, im);

    let totalPow = 0;
    let magSum = 0;
    let weightedFreqSum = 0;
    let logPowSum = 0;
    let mhLogSum = 0;
    let domBin = 1;
    let domMag = 0;
    const accumulateSpec = rms > 0.02;

    powPrefix[0] = 0;
    for (let b = 0; b < halfBins; b++) {
      const rr = re[b];
      const ii = im[b];
      const p = (rr * rr + ii * ii) * invFftSq;
      const m = Math.sqrt(p);
      mag[b] = m;
      pow[b] = p;
      powPrefix[b + 1] = powPrefix[b] + p;

      let logP = -41.44653167389282; // Math.log(1e-18)
      if (b >= 1) {
        totalPow += p;
        magSum += m;
        weightedFreqSum += b * binHz * m;
        logP = Math.log(p + 1e-18);
        logPowSum += logP;
        if (b >= b1000 && b <= b4000) mhLogSum += logP;
        if (b >= minDomBin && m > domMag) {
          domMag = m;
          domBin = b;
        }
      }
      if (accumulateSpec) {
        meanPow[b] += p;
        if (p > peakPow[b]) peakPow[b] = p;
        meanLogMag[b] += 0.5 * (b >= 1 ? logP : Math.log(p + 1e-18));
      }
    }
    if (accumulateSpec) specFrameCount++;

    const domHz = domMag > 1e-9 ? domBin * binHz : 0;
    const spectralCentroidHz = magSum > 1e-12 ? weightedFreqSum / magSum : 0;

    // 85% spectral rolloff
    let spectralRolloffHz = 0;
    if (totalPow > 1e-18) {
      const target = powPrefix[1] + totalPow * 0.85;
      for (let b = 1; b < halfBins; b++) {
        if (powPrefix[b + 1] >= target) {
          spectralRolloffHz = b * binHz;
          break;
        }
      }
    }

    // Spectral flatness (geometric mean / arithmetic mean of power)
    const arithMeanPow = totalPow / numAcBins;
    const spectralFlatness =
      arithMeanPow > 1e-18
        ? Math.max(0, Math.min(1, Math.exp(logPowSum / numAcBins) / (arithMeanPow + 1e-18)))
        : 0;

    // Mid-high flatness (1000-4000 Hz) for F31 whisper guard
    const mhPowSum = powPrefix[b4000 + 1] - powPrefix[b1000];
    const mhArith = mhPowSum / mhCount;
    const midHighFlatness =
      mhArith > 1e-18 ? Math.max(0, Math.min(1, Math.exp(mhLogSum / mhCount) / (mhArith + 1e-18))) : 0;

    // O(1) prefix-sum band energies
    const invTotalPow = totalPow > 1e-18 ? 1 / totalPow : 0;
    const harshnessRatio = (powPrefix[b5500 + 1] - powPrefix[b2500]) * invTotalPow;
    const lowBandRatio = (powPrefix[b250 + 1] - powPrefix[b60]) * invTotalPow;
    const subBassRatio = (powPrefix[b90 + 1] - powPrefix[b20]) * invTotalPow;
    const sibilanceRatio = (powPrefix[b10000 + 1] - powPrefix[b4500]) * invTotalPow;
    const boxyRatio = (powPrefix[b650 + 1] - powPrefix[b250]) * invTotalPow;
    const presenceRatio = (powPrefix[b5000 + 1] - powPrefix[b2000]) * invTotalPow;
    const midOnlyRatio = (powPrefix[b3400 + 1] - powPrefix[b300]) * invTotalPow;
    const lowWarmthRatio = (powPrefix[b300 + 1] - powPrefix[b80]) * invTotalPow;
    const highAirRatio = (powPrefix[b10000 + 1] - powPrefix[b3400]) * invTotalPow;
    const aliasingFloorRatio = (powPrefix[halfBins] - powPrefix[aliasStartBin]) * invTotalPow;
    const lowUnder600Pow = powPrefix[b600 + 1] - powPrefix[b60];
    const mid1k3k5Pow = powPrefix[b3500 + 1] - powPrefix[b1000];
    const lowToMidTiltDb = Math.max(
      -40,
      Math.min(40, 10 * Math.log10((lowUnder600Pow + 1e-12) / (mid1k3k5Pow + 1e-12)))
    );

    // v0.9 Live-vs-Synthetic anti-fog bands (dB relative to 80–11000 Hz active spectrum)
    const band80_11kPow = Math.max(1e-18, powPrefix[b11000 + 1] - powPrefix[b80]);
    const bodyBand80_200Db = 10 * Math.log10((powPrefix[b200 + 1] - powPrefix[b80]) / band80_11kPow + 1e-9);
    const hf4500_7000Db = 10 * Math.log10((powPrefix[b7000 + 1] - powPrefix[b4500]) / band80_11kPow + 1e-9);
    const hiBand2800_11000Db =
      10 * Math.log10((powPrefix[b11000 + 1] - powPrefix[b2800]) / band80_11kPow + 1e-9);

    // Top-1 peak energy share (domBin ± 2) for F20 STERILE_PURE_TONE
    const top1Lo = Math.max(1, domBin - 2);
    const top1Hi = Math.min(halfBins - 1, domBin + 2);
    const top1Share = (powPrefix[top1Hi + 1] - powPrefix[top1Lo]) * invTotalPow;

    // Piercing whistle peak in [2000, 6500] Hz (F15)
    let pPeakBin = b2000;
    let pPeakMag = 0;
    for (let b = b2000; b <= b6500; b++) {
      if (mag[b] > pPeakMag) {
        pPeakMag = mag[b];
        pPeakBin = b;
      }
    }
    let neighCount = 0;
    const nLo = Math.max(1, pPeakBin - 16);
    const nHi = Math.min(halfBins - 1, pPeakBin + 16);
    for (let b = nLo; b <= nHi; b++) {
      if (Math.abs(b - pPeakBin) > 3) {
        neighScratch[neighCount++] = mag[b];
      }
    }
    let localMedMag = 1e-9;
    if (neighCount > 0) {
      const sub = neighScratch.subarray(0, neighCount);
      sub.sort();
      localMedMag = sub[neighCount >> 1];
    }
    const piercingPromDb =
      pPeakMag > 1e-9 ? Math.max(0, 20 * Math.log10(pPeakMag / Math.max(localMedMag, 1e-9))) : 0;
    const pLo = Math.max(1, pPeakBin - 2);
    const pHi = Math.min(halfBins - 1, pPeakBin + 2);
    const piercingShare = (powPrefix[pHi + 1] - powPrefix[pLo]) * invTotalPow;
    const piercingHz = pPeakBin * binHz;

    // Mel spectrogram column + cosine spectral flux
    const melCol = new Float32Array(melBands);
    const melVec = new Float32Array(melBands);
    let melNormSq = 0;
    for (let m = 0; m < melBands; m++) {
      const band = melFb.bands[m];
      let e = 0;
      for (let b = band.startBin; b <= band.endBin; b++) {
        e += pow[b] * band.weights[b - band.startBin];
      }
      const db = Math.max(-100, 10 * Math.log10(Math.max(e, 1e-10)));
      melCol[m] = db;
      if (db < minDb) minDb = db;
      if (db > maxDb) maxDb = db;

      const v = Math.max(0, db + 90);
      melVec[m] = v;
      melNormSq += v * v;
    }

    const melNorm = Math.sqrt(melNormSq);
    let spectralFlux = 0;
    if (melNorm > 1e-9) {
      for (let m = 0; m < melBands; m++) melVec[m] /= melNorm;
      if (prevMelNorm !== null) {
        let dot = 0;
        for (let m = 0; m < melBands; m++) dot += melVec[m] * prevMelNorm[m];
        spectralFlux = Math.max(0, Math.min(1, 1 - dot));
      }
      prevMelNorm = melVec;
    } else {
      prevMelNorm = null;
    }

    const roughness = rms > 0.03 ? computeRoughness(mag, sampleRate, fftSize, 12) : 0;

    const timeSec = (start + frameSize * 0.5) / sampleRate;
    times.push(timeSec);
    dbMatrix.push(melCol);

    frames.push({
      timeSec,
      rms,
      rmsDb,
      peakPos: Number.isFinite(peakPos) ? peakPos : 0,
      peakNeg: Number.isFinite(peakNeg) ? peakNeg : 0,
      zcrRate,
      hfRatio,
      f0,
      domHz,
      periodicity,
      voiced,
      hnrDb,
      spectralCentroidHz,
      spectralRolloffHz,
      spectralFlatness,
      harshnessRatio,
      spectralFlux,
      envelopeCurvature: 0, // filled in post-pass
      clipped,
    });

    frameExtras.push({
      rawRms,
      lowBandRatio,
      subBassRatio,
      sibilanceRatio,
      boxyRatio,
      presenceRatio,
      midOnlyRatio,
      lowWarmthRatio,
      highAirRatio,
      aliasingFloorRatio,
      lowToMidTiltDb,
      midHighFlatness,
      top1Share,
      roughness,
      piercingPromDb,
      piercingShare,
      piercingHz,
      bodyBand80_200Db,
      hf4500_7000Db,
      hiBand2800_11000Db,
    });
  }

  // Active frames (exact v0.1 threshold)
  const maxRms = frames.reduce((m, f) => Math.max(m, f.rms), 0);
  const activeThresh = Math.max(0.03, maxRms * 0.12);
  const activeIndices = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].rms >= activeThresh) activeIndices.push(i);
  }

  // Second-difference envelope curvature |Δ²E|
  const normMaxRms = Math.max(maxRms, 1e-6);
  for (let i = 1; i + 1 < frames.length; i++) {
    frames[i].envelopeCurvature =
      Math.abs(frames[i + 1].rms - 2 * frames[i].rms + frames[i - 1].rms) / normMaxRms;
  }

  // Tail window (exact v0.1 formula) + EOF truncation guard (raw final-15ms PCM energy)
  let tailDecaySec = 0;
  let tailStartSec = 0;
  let tailEndSec = 0;
  let tailTruncatedAtEof = 0;
  if (activeIndices.length >= 3) {
    const lastActive = activeIndices[activeIndices.length - 1];
    const tailCheckLen = Math.min(n, Math.max(1, Math.round(sampleRate * 0.015)));
    let tailEndSq = 0;
    for (let i = n - tailCheckLen; i < n; i++) {
      tailEndSq += norm[i] * norm[i];
    }
    const tailEndRms = Math.sqrt(tailEndSq / tailCheckLen);
    if (tailEndRms >= activeThresh) {
      tailTruncatedAtEof = 1;
    }
    let highIdx = lastActive;
    for (let i = lastActive; i >= activeIndices[0]; i--) {
      if (frames[i].rms >= maxRms * 0.65) {
        highIdx = i;
        break;
      }
    }
    tailStartSec = frames[highIdx].timeSec;
    tailEndSec = frames[lastActive].timeSec;
    tailDecaySec = Math.max(0, tailEndSec - tailStartSec);
  }

  // Onsets, curvature spikes, valleys, clips
  const onsetEnv = new Float32Array(frames.length);
  let maxOnsetEnv = 0;
  for (let i = 1; i < frames.length; i++) {
    const rise = Math.max(0, frames[i].rms - frames[i - 1].rms) / normMaxRms;
    const val = rise + 0.5 * frames[i].spectralFlux;
    onsetEnv[i] = val;
    if (val > maxOnsetEnv) maxOnsetEnv = val;
  }
  const onsets = [];
  const minOnsetGapFrames = Math.max(1, Math.round(0.06 / hopSec));
  const onsetThresh = Math.max(0.08, maxOnsetEnv * 0.22);
  let lastOnsetFrame = -minOnsetGapFrames;
  for (let i = 1; i + 1 < frames.length; i++) {
    if (
      i - lastOnsetFrame >= minOnsetGapFrames &&
      frames[i].rms >= activeThresh * 0.8 &&
      onsetEnv[i] >= onsetThresh &&
      onsetEnv[i] >= onsetEnv[i - 1] &&
      onsetEnv[i] >= onsetEnv[i + 1]
    ) {
      onsets.push(frames[i].timeSec);
      lastOnsetFrame = i;
    }
  }

  const curvatureSpikes = [];
  const valleys = [];
  const clips = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].clipped) clips.push(frames[i].timeSec);
    if (
      i > 0 &&
      i + 1 < frames.length &&
      frames[i].envelopeCurvature >= 0.15 &&
      frames[i].envelopeCurvature >= frames[i - 1].envelopeCurvature &&
      frames[i].envelopeCurvature >= frames[i + 1].envelopeCurvature
    ) {
      curvatureSpikes.push(frames[i].timeSec);
    }
    if (
      i > 1 &&
      i + 2 < frames.length &&
      frames[i].rms < frames[i - 1].rms &&
      frames[i].rms <= frames[i + 1].rms
    ) {
      const leftPeak = Math.max(frames[i - 2].rms, frames[i - 1].rms);
      const rightPeak = Math.max(frames[i + 1].rms, frames[i + 2].rms);
      const localRef = Math.min(leftPeak, rightPeak);
      if (localRef >= activeThresh && frames[i].rms <= localRef * 0.7) {
        valleys.push(frames[i].timeSec);
      }
    }
  }

  // Finalize meanLogMag and build compact spectralSlice (up to 96 log-spaced bins)
  if (specFrameCount > 0) {
    for (let b = 0; b < halfBins; b++) {
      meanPow[b] /= specFrameCount;
      meanLogMag[b] /= specFrameCount;
    }
  }

  const sliceBins = Math.min(96, Math.max(1, halfBins - 1));
  const sliceFreqsHz = [];
  const sliceMeanDb = [];
  const slicePeakDb = [];
  const fLo = Math.max(20, binHz);
  const fHi = Math.min(12000, sampleRate * 0.5);
  for (let i = 0; i < sliceBins; i++) {
    const frac = sliceBins > 1 ? i / (sliceBins - 1) : 0;
    const hz = fLo * Math.pow(fHi / fLo, frac);
    const b = Math.max(1, Math.min(halfBins - 1, Math.round(hz / binHz)));
    sliceFreqsHz.push(roundTo(hz, 1));
    sliceMeanDb.push(roundTo(Math.max(-100, 10 * Math.log10(Math.max(meanPow[b], 1e-10))), 2));
    slicePeakDb.push(roundTo(Math.max(-100, 10 * Math.log10(Math.max(peakPow[b], 1e-10))), 2));
  }

  // Top spectral peaks from meanPow
  const rawSlicePeaks = [];
  for (let b = 2; b < halfBins - 1; b++) {
    if (meanPow[b] > 1e-10 && meanPow[b] > meanPow[b - 1] && meanPow[b] >= meanPow[b + 1]) {
      rawSlicePeaks.push({
        hz: roundTo(b * binHz, 1),
        db: roundTo(Math.max(-100, 10 * Math.log10(meanPow[b])), 2),
      });
    }
  }
  rawSlicePeaks.sort((a, b) => b.db - a.db);
  const slicePeaks = rawSlicePeaks.slice(0, 8);

  // Real-audio phase-space loop (tension vs breath)
  const phaseLoop = frames.map((f) => {
    const normRms = f.rms / normMaxRms;
    const tension = Math.max(0, Math.min(1, 0.5 * normRms + 0.5 * Math.min(1, f.hfRatio / 0.4)));
    const breath = Math.max(
      0,
      Math.min(1, normRms * (1 - f.harshnessRatio) * (1 - Math.min(1, f.envelopeCurvature * 2)))
    );
    return {
      t: roundTo(f.timeSec, 3),
      tension: roundTo(tension, 4),
      breath: roundTo(breath, 4),
    };
  });

  // Anomaly hotspots (sorted by severity desc, capped to top 6)
  const hotspots = [];
  const pushHotspot = (startSec, endSec, reason, severity) => {
    hotspots.push({
      startSec: roundTo(Math.max(0, startSec), 3),
      endSec: roundTo(Math.min(durationSec, Math.max(startSec + hopSec, endSec)), 3),
      reason,
      severity: roundTo(Math.max(0, Math.min(1, severity)), 3),
    });
  };

  // Attack spike hotspot
  let maxAttackSlope = 0;
  let maxAttackTimeSec = 0;
  for (let i = 1; i < frames.length; i++) {
    const slope = (frames[i].rms - frames[i - 1].rms) / normMaxRms;
    if (slope > maxAttackSlope) {
      maxAttackSlope = slope;
      maxAttackTimeSec = frames[i].timeSec;
    }
  }
  if (maxAttackSlope >= 0.45) {
    pushHotspot(maxAttackTimeSec - 0.03, maxAttackTimeSec + 0.05, "sharp_attack", Math.min(1, maxAttackSlope));
  }
  if (clips.length > 0) {
    pushHotspot(clips[0] - 0.02, clips[clips.length - 1] + 0.02, "clipping", Math.min(1, 0.6 + clips.length * 0.05));
  }

  // Harshness hotspot
  let maxHarsh = 0;
  let maxHarshTime = 0;
  for (const idx of activeIndices) {
    if (frames[idx].harshnessRatio > maxHarsh) {
      maxHarsh = frames[idx].harshnessRatio;
      maxHarshTime = frames[idx].timeSec;
    }
  }
  if (maxHarsh >= 0.35) {
    pushHotspot(maxHarshTime - 0.04, maxHarshTime + 0.04, "high_harshness", Math.min(1, maxHarsh));
  }

  // Curvature spike hotspot
  let maxCurv = 0;
  let maxCurvTime = 0;
  for (const idx of activeIndices) {
    if (frames[idx].envelopeCurvature > maxCurv) {
      maxCurv = frames[idx].envelopeCurvature;
      maxCurvTime = frames[idx].timeSec;
    }
  }
  if (maxCurv >= 0.25) {
    pushHotspot(maxCurvTime - 0.03, maxCurvTime + 0.03, "envelope_curvature_spike", Math.min(1, maxCurv));
  }

  hotspots.sort((a, b) => b.severity - a.severity);

  const profile = {
    sampleRate,
    durationSec: roundTo(durationSec, 3),
    fftSize,
    hopSize,
    frames,
    spectrogram: {
      times,
      freqsHz: melFb.centerFreqsHz,
      dbMatrix,
      minDb: Number.isFinite(minDb) ? roundTo(minDb, 2) : -100,
      maxDb: Number.isFinite(maxDb) ? roundTo(maxDb, 2) : 0,
    },
    spectralSlice: {
      freqsHz: sliceFreqsHz,
      meanDb: sliceMeanDb,
      peakDb: slicePeakDb,
      peaks: slicePeaks,
    },
    markers: {
      onsets,
      curvatureSpikes,
      valleys,
      clips,
      tailWindow: {
        startSec: roundTo(tailStartSec, 3),
        endSec: roundTo(tailEndSec, 3),
      },
      hotspots: hotspots.slice(0, 6),
    },
    phaseLoop,
  };

  return {
    profile,
    samples,
    norm,
    n,
    sampleRate,
    durationSec,
    fftSize,
    hopSize,
    hopSec,
    peak,
    clipCount,
    maxSampleJump,
    dcOffset,
    dcToRmsRatio,
    exactFlatRatio,
    clippedPeakCycles,
    diffSqAll,
    maxRawDiff,
    maxRawDiffIdx,
    maxRms,
    activeThresh,
    activeIndices,
    maxAttackSlope,
    maxAttackTimeSec,
    tailDecaySec,
    tailStartSec,
    tailTruncatedAtEof,
    frameExtras,
    meanLogMag,
    specFrameCount,
  };
}

/**
 * Extract full AudioProfile (frames, Mel spectrogram, spectral slice, markers, phase loop).
 *
 * @param {Float32Array|ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {{ fftSize?: number, hopMs?: number, melBands?: number, fMin?: number, fMax?: number, channels?: Float32Array[] }} [opts]
 */
export function extractAudioProfile(samples, sampleRate, opts = {}) {
  return runCoreAnalysis(samples, sampleRate, opts).profile;
}

/**
 * Extract all 16 v0.1 scalar features + all new scalar features for F7–F32.
 * Every returned scalar is guaranteed to be a finite number (never NaN or Infinity).
 *
 * @param {Float32Array|ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {{ fftSize?: number, hopMs?: number, melBands?: number, fMin?: number, fMax?: number, channels?: Float32Array[] }} [opts]
 */
export function extractFeatures(samples, sampleRate, opts = {}) {
  const core = runCoreAnalysis(samples, sampleRate, opts);
  const {
    profile,
    n,
    durationSec,
    fftSize,
    hopSize,
    hopSec,
    peak,
    clipCount,
    maxSampleJump,
    dcOffset,
    dcToRmsRatio,
    exactFlatRatio,
    clippedPeakCycles,
    diffSqAll,
    maxRawDiff,
    maxRawDiffIdx,
    maxRms,
    activeIndices,
    maxAttackSlope,
    maxAttackTimeSec,
    tailDecaySec,
    tailStartSec,
    tailTruncatedAtEof,
    frameExtras,
    meanLogMag,
    specFrameCount,
  } = core;

  const frames = profile.frames;
  const activeCount = activeIndices.length;

  // --- v0.1 core scalars ---
  const meanHfRatio = activeCount
    ? activeIndices.reduce((s, idx) => s + frames[idx].hfRatio, 0) / activeCount
    : 0;

  const voicedFrames = activeIndices.map((i) => frames[i]).filter((f) => f.voiced);
  const voicedFrameCount = voicedFrames.length;
  const voicedRatio = activeCount ? voicedFrameCount / activeCount : 0;
  const voicedDurationSec = voicedFrameCount * hopSec;

  let shimmerSum = 0;
  let pairCount = 0;
  for (let i = 1; i < voicedFrames.length; i++) {
    const prev = voicedFrames[i - 1];
    const curr = voicedFrames[i];
    if (curr.timeSec - prev.timeSec <= 0.025) {
      shimmerSum += Math.abs(curr.rms - prev.rms) / Math.max(prev.rms, 1e-6);
      pairCount++;
    }
  }
  const f0Track = frames.map((f) => (f.voiced ? f.f0 : 0));
  const jitter = computeCycleJitter(core.norm, core.sampleRate, f0Track, hopSize);
  const shimmer = pairCount ? shimmerSum / pairCount : 0;

  const corrRmsHf = Math.abs(
    pearson(
      activeIndices.map((i) => frames[i].rms),
      activeIndices.map((i) => frames[i].hfRatio)
    )
  );
  const corrRmsCentroid = Math.abs(
    pearson(
      activeIndices.map((i) => frames[i].rms),
      activeIndices.map((i) => frames[i].spectralCentroidHz)
    )
  );
  const corrRmsF0 =
    voicedFrameCount >= 4
      ? Math.abs(
          pearson(
            voicedFrames.map((f) => f.rms),
            voicedFrames.map((f) => f.f0)
          )
        )
      : 0;
  const commonCauseCoupling = Math.max(corrRmsHf, corrRmsF0, corrRmsCentroid);

  // --- F9: Micro-clicks & short dropouts ---
  const rmsDiff = n > 1 ? Math.sqrt(diffSqAll / (n - 1)) : 0;
  const maxClickJump = peak > 1e-6 ? maxRawDiff / peak : 0;
  const clickRatio = rmsDiff > 1e-8 ? maxRawDiff / rmsDiff : 0;
  const clickTimeSec = n > 0 ? maxRawDiffIdx / core.sampleRate : 0;

  let dropoutCount = 0;
  let dropoutTimeSec = 0;
  if (activeCount >= 2 && n > 0) {
    const subLen = Math.max(16, Math.round(core.sampleRate * 0.005)); // 5ms blocks
    const firstSample = activeIndices[0] * hopSize;
    const lastSample = Math.min(n, activeIndices[activeCount - 1] * hopSize + hopSize);
    const numBlocks = Math.floor((lastSample - firstSample) / subLen);
    if (numBlocks >= 3) {
      const blockRms = new Float32Array(numBlocks);
      let maxBlockRms = 0;
      for (let b = 0; b < numBlocks; b++) {
        const s0 = firstSample + b * subLen;
        let sq = 0;
        for (let k = 0; k < subLen; k++) {
          const x = core.norm[s0 + k];
          sq += x * x;
        }
        const r = Math.sqrt(sq / subLen);
        blockRms[b] = r;
        if (r > maxBlockRms) maxBlockRms = r;
      }

      const maxGapBlocks = Math.max(1, Math.round(0.04 / 0.005)); // <= 40ms
      const dropFloor = maxBlockRms * 0.05;
      const wallThresh = maxBlockRms * 0.25;

      let b = 1;
      while (b < numBlocks - 1) {
        if (blockRms[b] < dropFloor && blockRms[b - 1] >= wallThresh) {
          let j = b;
          while (j < numBlocks - 1 && blockRms[j] < dropFloor) j++;
          const gapLen = j - b;
          if (gapLen >= 1 && gapLen <= maxGapBlocks && j < numBlocks && blockRms[j] >= wallThresh) {
            dropoutCount++;
            if (dropoutCount === 1) {
              dropoutTimeSec = (firstSample + b * subLen) / core.sampleRate;
            }
          }
          b = j;
        } else {
          b++;
        }
      }
    }
  }

  // --- F10: Crest factor & active RMS CV ---
  const activeRawRmsVals = activeIndices.map((i) => frameExtras[i].rawRms);
  const activeRmsVals = activeIndices.map((i) => frames[i].rms);
  const activeRawRms = activeRawRmsVals.length
    ? Math.sqrt(activeRawRmsVals.reduce((s, v) => s + v * v, 0) / activeRawRmsVals.length)
    : 0;
  const crestFactorDb =
    peak > 1e-6 && activeRawRms > 1e-6
      ? Math.max(0, Math.min(60, 20 * Math.log10(peak / activeRawRms)))
      : 0;
  const meanActiveRms = meanOf(activeRmsVals);
  const activeRmsCv = meanActiveRms > 1e-6 ? stdOf(activeRmsVals, meanActiveRms) / meanActiveRms : 0;

  // --- F11: Amplitude modulation DFT (2–16 Hz) ---
  let ampMod = { depth: 0, sinusoidality: 0, freqHz: 0 };
  if (activeCount >= 10 && meanActiveRms > 1e-6) {
    const firstAct = activeIndices[0];
    const lastAct = activeIndices[activeCount - 1];
    const envSeries = [];
    for (let i = firstAct; i <= lastAct; i++) {
      envSeries.push(frames[i].rms / meanActiveRms);
    }
    ampMod = computeModulationDft(envSeries, hopSec, 2, 16);
  }

  // --- F12–F21, F31–F35: Spectral aggregates over active frames ---
  const medianF0 = voicedFrameCount > 0 ? median(voicedFrames.map((f) => f.f0)) : 0;
  const activeCentroids = activeIndices.map((i) => frames[i].spectralCentroidHz);
  const spectralCentroidHz = activeCount ? meanOf(activeCentroids) : 0;
  const centroidStdHz = activeCount ? stdOf(activeCentroids, spectralCentroidHz) : 0;
  const bodyBand80_200Db = activeCount
    ? meanOf(activeIndices.map((i) => frameExtras[i].bodyBand80_200Db))
    : -90;
  const hf4500_7000Db = activeCount
    ? meanOf(activeIndices.map((i) => frameExtras[i].hf4500_7000Db))
    : -90;
  const activeHiBandDb = activeIndices.map((i) => frameExtras[i].hiBand2800_11000Db);
  const hiBand2800_11000StdDb = activeCount ? stdOf(activeHiBandDb, meanOf(activeHiBandDb)) : 0;

  // --- F36: Coarticulation seam / loudness-invariant Mel spectral-shape switching ---
  const dbMat = profile.spectrogram?.dbMatrix;
  let hiToMidStdDb = 0;
  let relMelFluxStdDb = 0;
  if (Array.isArray(dbMat) && dbMat.length === frames.length && frames.length > 0 && dbMat[0].length >= 46) {
    const seamThr = Math.max(0.03, maxRms * 0.08);
    const hiToMidVals = [];
    const relFluxVals = [];
    let currShape = new Float32Array(40);
    let prevShape = new Float32Array(40);
    let hasPrev = false;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].rms < seamThr) {
        hasPrev = false;
        continue;
      }
      const col = dbMat[i];
      let mu = 0;
      for (let m = 6; m <= 45; m++) mu += col[m];
      mu /= 40;
      for (let m = 6; m <= 45; m++) currShape[m - 6] = col[m] - mu;

      let hi = 0;
      let mid = 0;
      for (let m = 30; m <= 45; m++) hi += col[m];
      for (let m = 14; m <= 25; m++) mid += col[m];
      hiToMidVals.push(hi / 16 - mid / 12);

      if (hasPrev) {
        let d = 0;
        for (let k = 0; k < 40; k++) d += Math.abs(currShape[k] - prevShape[k]);
        relFluxVals.push(d / 40);
      }
      const tmp = prevShape;
      prevShape = currShape;
      currShape = tmp;
      hasPrev = true;
    }
    if (hiToMidVals.length >= 4) hiToMidStdDb = stdOf(hiToMidVals, meanOf(hiToMidVals));
    if (relFluxVals.length >= 4) relMelFluxStdDb = stdOf(relFluxVals, meanOf(relFluxVals));
  }

  const lowBandRatio = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].lowBandRatio)) : 0;
  const subBassRatio = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].subBassRatio)) : 0;
  const meanRoughness = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].roughness)) : 0;

  const piercingProms = activeIndices.map((i) => frameExtras[i].piercingPromDb);
  const piercingShares = activeIndices.map((i) => frameExtras[i].piercingShare);
  const piercingProminenceDb = activeCount ? meanOf(piercingProms) : 0;
  const piercingBandShare = activeCount ? meanOf(piercingShares) : 0;
  let piercingHits = 0;
  const piercingHitFreqs = [];
  for (const idx of activeIndices) {
    if (frameExtras[idx].piercingPromDb >= 14 && frameExtras[idx].piercingShare >= 0.12) {
      piercingHits++;
      piercingHitFreqs.push(frameExtras[idx].piercingHz);
    }
  }
  const piercingPersistence = activeCount ? piercingHits / activeCount : 0;
  const piercingFreqHz = piercingHitFreqs.length
    ? median(piercingHitFreqs)
    : activeCount
      ? median(activeIndices.map((i) => frameExtras[i].piercingHz))
      : 0;

  const sibRatios = activeIndices.map((i) => frameExtras[i].sibilanceRatio);
  const meanSibilanceRatio = activeCount ? meanOf(sibRatios) : 0;
  const p90SibilanceRatio = activeCount ? percentile(sibRatios, 0.9) : 0;

  // F17: Real cepstrum comb detector
  const comb =
    specFrameCount > 0
      ? computeCepstrumComb(meanLogMag, core.sampleRate, fftSize, medianF0)
      : { nonPitchCepstralPeak: 0, combNotchDepthDb: 0, combDelayMs: 0 };

  const boxyRatio = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].boxyRatio)) : 0;
  const presenceRatio = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].presenceRatio)) : 0;
  const midOnlyRatio = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].midOnlyRatio)) : 0;
  const lowWarmthRatio = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].lowWarmthRatio)) : 0;
  const highAirRatio = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].highAirRatio)) : 0;
  const meanTop1PeakShare = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].top1Share)) : 0;
  const meanVoicedHnrDb = voicedFrameCount ? meanOf(voicedFrames.map((f) => f.hnrDb)) : 0;
  const meanSpectralFlatness = activeCount
    ? meanOf(activeIndices.map((i) => frames[i].spectralFlatness))
    : 0;
  const lowToMidTiltDb = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].lowToMidTiltDb)) : 0;
  const midHighFlatness = activeCount ? meanOf(activeIndices.map((i) => frameExtras[i].midHighFlatness)) : 0;

  // F32: Mean spectral flux across consecutive active frames
  let fluxSum = 0;
  let fluxCount = 0;
  for (let k = 1; k < activeCount; k++) {
    if (activeIndices[k] === activeIndices[k - 1] + 1) {
      fluxSum += frames[activeIndices[k]].spectralFlux;
      fluxCount++;
    }
  }
  const meanSpectralFlux = fluxCount > 0 ? fluxSum / fluxCount : 0;

  // --- F22–F25: Pitch contour statistics ---
  const voicedSemi = voicedFrames.map((f) => 12 * Math.log2(Math.max(f.f0, 1) / 100));
  const f0RangeSemitones =
    voicedSemi.length >= 4 ? percentile(voicedSemi, 0.95) - percentile(voicedSemi, 0.05) : 0;

  let diff1Sum = 0;
  let diff1Count = 0;
  let diff2Sum = 0;
  let diff2Count = 0;
  let flatSteps = 0;
  let snapJumpCount = 0;

  // Build contiguous voiced runs (in semitones) for F0 modulation DFT & autotune detection
  const voicedRuns = [];
  let currentRun = [];
  for (let i = 0; i < voicedFrames.length; i++) {
    if (i === 0 || voicedFrames[i].timeSec - voicedFrames[i - 1].timeSec <= 0.025) {
      currentRun.push(voicedSemi[i]);
    } else {
      if (currentRun.length) voicedRuns.push(currentRun);
      currentRun = [voicedSemi[i]];
    }
  }
  if (currentRun.length) voicedRuns.push(currentRun);

  let longestRun = [];
  for (const run of voicedRuns) {
    if (run.length > longestRun.length) longestRun = run;
    for (let i = 1; i < run.length; i++) {
      const d1 = Math.abs(run[i] - run[i - 1]);
      diff1Sum += d1;
      diff1Count++;
      if (d1 < 0.04) flatSteps++;
    }
    for (let i = 1; i + 1 < run.length; i++) {
      diff2Sum += Math.abs(run[i + 1] - 2 * run[i] + run[i - 1]);
      diff2Count++;
    }
    // Snap jumps: >= 0.7 semitones in 1-2 frames flanked by flat steps
    for (let i = 1; i + 1 < run.length; i++) {
      const prevFlat = i >= 2 ? Math.abs(run[i - 1] - run[i - 2]) < 0.12 : true;
      const jump1 = Math.abs(run[i] - run[i - 1]);
      const nextFlat1 = Math.abs(run[i + 1] - run[i]) < 0.12;
      if (prevFlat && jump1 >= 0.7 && nextFlat1) {
        snapJumpCount++;
      } else if (i + 2 < run.length) {
        const jump2 = Math.abs(run[i + 1] - run[i - 1]);
        const nextFlat2 = Math.abs(run[i + 2] - run[i + 1]) < 0.12;
        if (prevFlat && jump1 < 0.7 && jump2 >= 0.7 && nextFlat2) {
          snapJumpCount++;
          i++;
        }
      }
    }
  }

  const f0MeanAbsDiffSemi = diff1Count > 0 ? diff1Sum / diff1Count : 0;
  const f0SecondDiffSemi = diff2Count > 0 ? diff2Sum / diff2Count : 0;
  const flatStepRatio = diff1Count > 0 ? flatSteps / diff1Count : 0;

  const f0Mod =
    longestRun.length >= 10
      ? computeModulationDft(longestRun, hopSec, 3, 12)
      : { depth: 0, sinusoidality: 0, freqHz: 0 };

  // --- F26: Internal rebound shock ---
  let maxInternalShock = 0;
  let internalShockTimeSec = 0;
  if (activeCount >= 6) {
    const startK = Math.floor(activeCount * 0.2);
    let localPeakRms = 0;
    for (let k = 0; k < startK; k++) {
      const r = frames[activeIndices[k]].rms;
      if (r > localPeakRms) localPeakRms = r;
    }

    let inValley = false;
    let valleyMinRms = Infinity;
    for (let idx = activeIndices[startK]; idx <= activeIndices[activeCount - 1]; idx++) {
      const f = frames[idx];
      if (!inValley) {
        if (f.rms > localPeakRms) localPeakRms = f.rms;
        if (localPeakRms > 0 && f.rms <= localPeakRms * 0.65) {
          inValley = true;
          valleyMinRms = f.rms;
        }
      } else {
        if (f.rms < valleyMinRms) {
          valleyMinRms = f.rms;
        } else if (f.rms >= valleyMinRms * 1.25 || f.rms >= localPeakRms * 0.75) {
          const shock = f.envelopeCurvature * (0.5 + f.hfRatio);
          if (shock > maxInternalShock) {
            maxInternalShock = shock;
            internalShockTimeSec = f.timeSec;
          }
          if (f.rms >= localPeakRms * 0.85) {
            inValley = false;
            localPeakRms = f.rms;
          }
        }
      }
    }
  }

  // --- F27: Onset cadence / metronomic IOI ---
  const onsets = profile.markers.onsets;
  const onsetCount = onsets.length;
  const iois = [];
  for (let i = 1; i < onsets.length; i++) {
    iois.push(onsets[i] - onsets[i - 1]);
  }
  const meanIoiSec = meanOf(iois);
  const ioiCv = iois.length >= 3 && meanIoiSec > 1e-6 ? stdOf(iois, meanIoiSec) / meanIoiSec : 0;

  // --- F28: Mains hum drone (50/100/150 vs 60/120/180 Hz across all frames) ---
  const mains = analyzeMainsHum(core.samples, core.sampleRate);

  // --- F29: Bitcrush & aliasing ---
  let uniqueLevelRatio = 0;
  if (peak > 1e-5 && activeCount > 0) {
    const seen = new Uint8Array(1025);
    let distinct = 0;
    const invP = 1 / peak;
    for (const idx of activeIndices) {
      const startSample = idx * hopSize;
      const endSample = Math.min(n, startSample + hopSize);
      for (let i = startSample; i < endSample; i++) {
        const s = Number.isFinite(core.samples[i]) ? core.samples[i] : 0;
        const q = Math.max(0, Math.min(1024, Math.round(s * invP * 512) + 512));
        if (seen[q] === 0) {
          seen[q] = 1;
          distinct++;
        }
      }
    }
    uniqueLevelRatio = distinct / 1025;
  }
  const aliasingFloorRatio = activeCount
    ? meanOf(activeIndices.map((i) => frameExtras[i].aliasingFloorRatio))
    : 0;

  // --- F30: Stereo phase discomfort ---
  const channels = opts?.channels;
  const numChannels = Array.isArray(channels) && channels.length >= 1 ? channels.length : 1;
  let stereoCorr = 1;
  let lrImbalance = 0;
  if (numChannels >= 2 && channels[0] && channels[1]) {
    const chL = channels[0];
    const chR = channels[1];
    const len = Math.min(chL.length, chR.length);
    if (len >= 3) {
      stereoCorr = pearson(chL, chR);
      let sqL = 0;
      let sqR = 0;
      for (let i = 0; i < len; i++) {
        const l = Number.isFinite(chL[i]) ? chL[i] : 0;
        const r = Number.isFinite(chR[i]) ? chR[i] : 0;
        sqL += l * l;
        sqR += r * r;
      }
      const rmsL = Math.sqrt(sqL / len);
      const rmsR = Math.sqrt(sqR / len);
      const sumLR = rmsL + rmsR;
      lrImbalance = sumLR > 1e-9 ? Math.abs(rmsL - rmsR) / sumLR : 0;
    }
  }

  // --- v0.5 Neuroscience DSP lenses: MPS roughness (30-150Hz vs 4-16Hz) & subharmonics ---
  const mps = computeMpsRoughness(core.samples, core.sampleRate);
  const subharmonicRatio = computeSubharmonicRatio(core.norm, core.sampleRate, f0Track, hopSize);

  // --- v0.6 Breath & Pause Profile ---
  const breath = computeBreathPauseProfile(frames, durationSec);

  const featuresObj = {
    // === 16 v0.1 backward-compatible scalar keys ===
    sampleRate: core.sampleRate,
    durationSec: roundTo(durationSec, 3),
    frameCount: frames.length,
    activeFrameCount: activeCount,
    peak: roundTo(peak, 4),
    clipRatio: roundTo(clipCount / Math.max(n, 1), 5),
    maxSampleJump: roundTo(maxSampleJump, 4),
    maxAttackSlope: roundTo(maxAttackSlope, 4),
    maxAttackTimeSec: roundTo(maxAttackTimeSec, 3),
    meanHfRatio: roundTo(meanHfRatio, 4),
    voicedRatio: roundTo(voicedRatio, 4),
    jitter: roundTo(jitter, 5),
    shimmer: roundTo(shimmer, 5),
    commonCauseCoupling: roundTo(commonCauseCoupling, 4),
    tailDecaySec: roundTo(tailDecaySec, 3),
    tailStartSec: roundTo(tailStartSec, 3),

    // === F7–F11: Waveform & dynamics ===
    exactFlatRatio: roundTo(exactFlatRatio, 5),
    clippedPeakCycles: Math.round(finite(clippedPeakCycles, 0)),
    dcOffset: roundTo(dcOffset, 5),
    dcToRmsRatio: roundTo(dcToRmsRatio, 4),
    clickRatio: roundTo(clickRatio, 3),
    maxClickJump: roundTo(maxClickJump, 4),
    clickTimeSec: roundTo(clickTimeSec, 3),
    dropoutCount: Math.round(finite(dropoutCount, 0)),
    dropoutTimeSec: roundTo(dropoutTimeSec, 3),
    crestFactorDb: roundTo(crestFactorDb, 3),
    activeRmsCv: roundTo(activeRmsCv, 4),
    ampModDepth: roundTo(ampMod.depth, 4),
    ampModSinusoidality: roundTo(ampMod.sinusoidality, 4),
    ampModFreqHz: roundTo(ampMod.freqHz, 3),

    // === F12–F20: Spectral aggression & hollowness ===
    medianF0: roundTo(medianF0, 2),
    spectralCentroidHz: roundTo(spectralCentroidHz, 2),
    lowBandRatio: roundTo(lowBandRatio, 4),
    subBassRatio: roundTo(subBassRatio, 4),
    meanRoughness: roundTo(meanRoughness, 4),
    piercingProminenceDb: roundTo(piercingProminenceDb, 2),
    piercingBandShare: roundTo(piercingBandShare, 4),
    piercingPersistence: roundTo(piercingPersistence, 4),
    piercingFreqHz: roundTo(piercingFreqHz, 1),
    meanSibilanceRatio: roundTo(meanSibilanceRatio, 4),
    p90SibilanceRatio: roundTo(p90SibilanceRatio, 4),
    nonPitchCepstralPeak: roundTo(comb.nonPitchCepstralPeak, 4),
    combNotchDepthDb: roundTo(comb.combNotchDepthDb, 2),
    combDelayMs: roundTo(comb.combDelayMs, 3),
    boxyRatio: roundTo(boxyRatio, 4),
    presenceRatio: roundTo(presenceRatio, 4),
    midOnlyRatio: roundTo(midOnlyRatio, 4),
    lowWarmthRatio: roundTo(lowWarmthRatio, 4),
    highAirRatio: roundTo(highAirRatio, 4),
    meanTop1PeakShare: roundTo(meanTop1PeakShare, 4),

    // === F21–F27: Presence, prosody, control, artifice, cadence ===
    meanVoicedHnrDb: roundTo(meanVoicedHnrDb, 2),
    meanSpectralFlatness: roundTo(meanSpectralFlatness, 4),
    voicedDurationSec: roundTo(voicedDurationSec, 3),
    voicedFrameCount: Math.round(finite(voicedFrameCount, 0)),
    f0RangeSemitones: roundTo(f0RangeSemitones, 3),
    f0MeanAbsDiffSemi: roundTo(f0MeanAbsDiffSemi, 4),
    f0SecondDiffSemi: roundTo(f0SecondDiffSemi, 4),
    f0ModDepthSemi: roundTo(f0Mod.depth, 4),
    f0ModSinusoidality: roundTo(f0Mod.sinusoidality, 4),
    f0ModFreqHz: roundTo(f0Mod.freqHz, 3),
    flatStepRatio: roundTo(flatStepRatio, 4),
    snapJumpCount: Math.round(finite(snapJumpCount, 0)),
    maxInternalShock: roundTo(maxInternalShock, 4),
    internalShockTimeSec: roundTo(internalShockTimeSec, 3),
    onsetCount: Math.round(finite(onsetCount, 0)),
    ioiCv: roundTo(ioiCv, 4),
    meanIoiSec: roundTo(meanIoiSec, 3),

    // === F28–F30: Environment, digital, spatial ===
    mainsHumRatio: roundTo(mains.mainsHumRatio, 4),
    mainsPersistence: roundTo(mains.mainsPersistence, 4),
    mainsFreqHz: roundTo(mains.mainsFreqHz, 1),
    uniqueLevelRatio: roundTo(uniqueLevelRatio, 4),
    aliasingFloorRatio: roundTo(aliasingFloorRatio, 4),
    numChannels: Math.round(finite(numChannels, 1)),
    stereoCorr: roundTo(stereoCorr, 4),
    lrImbalance: roundTo(lrImbalance, 4),

    // === F31–F32: Pressed strain (with whisper guard) & spectral stasis ===
    lowToMidTiltDb: roundTo(lowToMidTiltDb, 2),
    midHighFlatness: roundTo(midHighFlatness, 4),
    meanSpectralFlux: roundTo(meanSpectralFlux, 5),

    // === v0.5 Neuroscience DSP Lenses: Arnal MPS roughness & nonlinear subharmonics ===
    mpsSpeech4_16: roundTo(mps.mpsSpeech4_16, 4),
    mpsRoughness30_150: roundTo(mps.mpsRoughness30_150, 4),
    mpsRoughToSpeechRatio: roundTo(mps.mpsRoughToSpeechRatio, 3),
    subharmonicRatio: roundTo(subharmonicRatio, 4),

    // === v0.6 Breath & Pause Profile ===
    activeDutyCycle: breath.activeDutyCycle,
    pauseCount: breath.pauseCount,
    meanPauseSec: breath.meanPauseSec,
    longestContinuousSec: breath.longestContinuousSec,
    breathlessWallRatio: breath.breathlessWallRatio,
    tailTruncatedAtEof,

    // === v0.9 Anti-Fog Live-vs-Synthetic Dynamics (F35–F36) ===
    bodyBand80_200Db: roundTo(bodyBand80_200Db, 2),
    hf4500_7000Db: roundTo(hf4500_7000Db, 2),
    hiBand2800_11000StdDb: roundTo(hiBand2800_11000StdDb, 2),
    centroidStdHz: roundTo(centroidStdHz, 1),
    hiToMidStdDb: roundTo(hiToMidStdDb, 2),
    relMelFluxStdDb: roundTo(relMelFluxStdDb, 2),
  };

  // --- v0.6 Voice Compass ("sound produced to be heard by someone, using a respiratory organ") ---
  // Compute MPS on the leading/trailing-silence-trimmed active span so trailing recording silence
  // never inflates 4–16 Hz modulation clarity (even on undulating signals).
  const compassMaxRms = frames.reduce((m, fr) => Math.max(m, finite(fr?.rms, 0)), 0);
  const compassThresh = Math.max(0.03, compassMaxRms * 0.12);
  let trimFirst = -1;
  let trimLast = -1;
  for (let i = 0; i < frames.length; i++) {
    if (finite(frames[i]?.rms, 0) >= compassThresh) {
      if (trimFirst < 0) trimFirst = i;
      trimLast = i;
    }
  }
  let activeMps = mps;
  if (trimFirst >= 0 && trimLast >= trimFirst && n > 0) {
    const s0 = Math.max(0, Math.min(n, Math.floor(finite(frames[trimFirst].timeSec, 0) * core.sampleRate)));
    const s1 = Math.max(
      s0,
      Math.min(n, Math.ceil((finite(frames[trimLast].timeSec, 0) + hopSec) * core.sampleRate))
    );
    if (s1 - s0 > 0 && (s0 > 0 || s1 < n)) {
      const trimmedSlice =
        typeof core.samples.subarray === "function"
          ? core.samples.subarray(s0, s1)
          : core.samples.slice(s0, s1);
      activeMps = computeMpsRoughness(trimmedSlice, core.sampleRate);
    }
  }
  featuresObj.activeMpsSpeech4_16 = roundTo(activeMps.mpsSpeech4_16, 4);
  featuresObj.activeMpsRoughness30_150 = roundTo(activeMps.mpsRoughness30_150, 4);
  const compass = computeVoiceCompass(frames, featuresObj, breath);
  featuresObj.respiratoryScore = compass.respiratoryScore;
  featuresObj.directnessScore = compass.directnessScore;

  // --- v0.7 Over-Sanitization / Living Imperfection Lens ---
  const sanitization = computeSanitizationIndex(featuresObj, breath);
  featuresObj.sanitizationScore = sanitization.sanitizationScore;

  return featuresObj;
}

/**
 * Breath & Pause Profile: segments active sound islands (rms >= 0.03) and internal
 * breathing pauses (>= 0.06s) to distinguish silence, brief glances, phrased speech/music
 * with breathing room, and relentless breathless walls of sound.
 *
 * @param {Array<{ timeSec: number, rms: number }>} frames
 * @param {number} durationSec
 * @returns {{
 *   activeDutyCycle: number,
 *   pauseCount: number,
 *   meanPauseSec: number,
 *   longestContinuousSec: number,
 *   breathlessWallRatio: number,
 *   cadenceLabel: "silent" | "brief_glance" | "phrased_breath" | "continuous_wall",
 * }}
 */
export function computeBreathPauseProfile(frames, durationSec) {
  const dur = finite(durationSec, 0);
  if (!Array.isArray(frames) || frames.length === 0 || dur <= 0) {
    return {
      activeDutyCycle: 0,
      pauseCount: 0,
      meanPauseSec: 0,
      longestContinuousSec: 0,
      breathlessWallRatio: 0,
      cadenceLabel: "silent",
    };
  }

  const n = frames.length;
  const dt = n >= 2
    ? Math.max(1e-4, finite(frames[1].timeSec - frames[0].timeSec, 0.01))
    : Math.min(dur, 0.025);
  const ACTIVE_RMS = 0.03;
  const PAUSE_MIN_SEC = 0.06;

  let activeCount = 0;
  const activeFlags = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (finite(frames[i]?.rms, 0) >= ACTIVE_RMS) {
      activeFlags[i] = 1;
      activeCount++;
    }
  }

  if (activeCount === 0) {
    return {
      activeDutyCycle: 0,
      pauseCount: 0,
      meanPauseSec: 0,
      longestContinuousSec: 0,
      breathlessWallRatio: 0,
      cadenceLabel: "silent",
    };
  }

  const activeDutyCycle = Math.max(0, Math.min(1, activeCount / n));

  const islands = [];
  let i = 0;
  while (i < n) {
    if (activeFlags[i] === 1) {
      const start = i;
      while (i < n && activeFlags[i] === 1) i++;
      islands.push({ start, end: i - 1 });
    } else {
      i++;
    }
  }

  const pauses = [];
  const merged = [islands[0]];
  for (let k = 1; k < islands.length; k++) {
    const prev = merged[merged.length - 1];
    const curr = islands[k];
    const gapFrames = curr.start - prev.end - 1;
    const gapSec = gapFrames * dt;
    if (gapSec >= PAUSE_MIN_SEC) {
      pauses.push(gapSec);
      merged.push(curr);
    } else {
      prev.end = curr.end;
    }
  }

  const pauseCount = pauses.length;
  const meanPauseSec = pauseCount > 0 ? meanOf(pauses) : 0;

  let longestContinuousSec = 0;
  for (const run of merged) {
    const runSec = Math.min(dur, (run.end - run.start + 1) * dt);
    if (runSec > longestContinuousSec) longestContinuousSec = runSec;
  }

  const breathlessWallRatio = Math.max(0, Math.min(1, (longestContinuousSec - 2.0) / 3.0));

  let cadenceLabel;
  if (activeDutyCycle < 0.01) {
    cadenceLabel = "silent";
  } else if (longestContinuousSec >= 2.0 && (pauseCount === 0 || breathlessWallRatio >= 0.2)) {
    cadenceLabel = "continuous_wall";
  } else if (
    pauseCount === 0 &&
    (longestContinuousSec <= 0.25 || (activeDutyCycle <= 0.3 && longestContinuousSec <= 0.5))
  ) {
    cadenceLabel = "brief_glance";
  } else {
    cadenceLabel = "phrased_breath";
  }

  return {
    activeDutyCycle: roundTo(activeDutyCycle, 4),
    pauseCount,
    meanPauseSec: roundTo(meanPauseSec, 3),
    longestContinuousSec: roundTo(longestContinuousSec, 3),
    breathlessWallRatio: roundTo(breathlessWallRatio, 4),
    cadenceLabel,
  };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Voice Compass (v0.6 diagnostic lens — NEVER a hard veto):
 * Decomposes the definition "a voice is a sound produced to be heard by someone,
 * using a respiratory organ" into two orthogonal [0, 1] axes:
 *   1. respiratoryScore: finite-lung phrasing & breath support + natural dynamic/breath arc
 *      + organic voiced-harmonic / breath coupling.
 *   2. directnessScore: communicative band focus (300–3500 Hz) + syllabic/call modulation
 *      clarity (4–16 Hz vs 30–150 Hz harshness/diffuse noise) + figure-ground clarity.
 *
 * @param {Array<object>} frames
 * @param {object|null} [features=null]
 * @param {object|null} [breathProfile=null]
 * @returns {{
 *   respiratoryScore: number,
 *   directnessScore: number,
 *   label: "addressed_breath" | "distant_or_private_breath" | "non_breath_signal" | "ambient_or_hollow",
 * }}
 */
export function computeVoiceCompass(frames, features = null, breathProfile = null) {
  const fList = Array.isArray(frames) ? frames : [];
  const feat = features && typeof features === "object" ? features : {};

  let durationSec = finite(feat.durationSec, 0);
  if (durationSec <= 0 && fList.length >= 2) {
    const dt = Math.max(1e-4, finite(fList[1].timeSec - fList[0].timeSec, 0.01));
    durationSec = Math.max(0, finite(fList[fList.length - 1].timeSec - fList[0].timeSec, 0) + dt);
  }

  const breath =
    breathProfile && typeof breathProfile === "object"
      ? breathProfile
      : computeBreathPauseProfile(fList, durationSec);

  const maxRms = fList.reduce((m, fr) => Math.max(m, finite(fr?.rms, 0)), 0);
  const activeThresh = Math.max(0.03, maxRms * 0.12);
  const activeFrames = fList.filter((fr) => finite(fr?.rms, 0) >= activeThresh);

  if (
    activeFrames.length === 0 ||
    finite(breath.activeDutyCycle, 0) < 0.01 ||
    (Number.isFinite(feat.peak) && feat.peak < 1e-4)
  ) {
    return {
      respiratoryScore: 0,
      directnessScore: 0,
      label: "ambient_or_hollow",
    };
  }

  // --- Shared fallbacks when called with partial/null features ---
  const activeRms = activeFrames.map((fr) => finite(fr.rms, 0));
  const voicedFrames = activeFrames.filter((fr) => Boolean(fr.voiced) && finite(fr.f0, 0) > 0);
  const voicedRatio = Number.isFinite(feat.voicedRatio)
    ? clamp01(feat.voicedRatio)
    : activeFrames.length > 0
      ? voicedFrames.length / activeFrames.length
      : 0;

  const meanActiveRms = meanOf(activeRms);
  const activeRmsCv = Number.isFinite(feat.activeRmsCv)
    ? Math.max(0, feat.activeRmsCv)
    : meanActiveRms > 1e-6
      ? stdOf(activeRms, meanActiveRms) / meanActiveRms
      : 0;

  let maxAttackSlope = Number.isFinite(feat.maxAttackSlope) ? Math.max(0, feat.maxAttackSlope) : 0;
  if (!Number.isFinite(feat.maxAttackSlope) && fList.length >= 2 && maxRms > 1e-6) {
    for (let i = 1; i < fList.length; i++) {
      const slope = (finite(fList[i].rms, 0) - finite(fList[i - 1].rms, 0)) / maxRms;
      if (slope > maxAttackSlope) maxAttackSlope = slope;
    }
  }

  let tailDecaySec = Number.isFinite(feat.tailDecaySec) ? Math.max(0, feat.tailDecaySec) : 0;
  if (!Number.isFinite(feat.tailDecaySec) && activeFrames.length >= 3) {
    const lastAct = activeFrames[activeFrames.length - 1];
    let highTime = lastAct.timeSec;
    for (let i = activeFrames.length - 1; i >= 0; i--) {
      if (finite(activeFrames[i].rms, 0) >= maxRms * 0.65) {
        highTime = finite(activeFrames[i].timeSec, lastAct.timeSec);
        break;
      }
    }
    tailDecaySec = Math.max(0, finite(lastAct.timeSec, 0) - highTime);
  }

  let shimmer = Number.isFinite(feat.shimmer) ? Math.max(0, feat.shimmer) : 0;
  let jitter = Number.isFinite(feat.jitter) ? Math.max(0, feat.jitter) : 0;
  if ((!Number.isFinite(feat.shimmer) || !Number.isFinite(feat.jitter)) && voicedFrames.length >= 2) {
    let shSum = 0;
    let jiSum = 0;
    let cnt = 0;
    for (let i = 1; i < voicedFrames.length; i++) {
      const prev = voicedFrames[i - 1];
      const curr = voicedFrames[i];
      if (finite(curr.timeSec, 0) - finite(prev.timeSec, 0) <= 0.025) {
        shSum += Math.abs(curr.rms - prev.rms) / Math.max(prev.rms, 1e-6);
        jiSum += Math.abs(curr.f0 - prev.f0) / Math.max(prev.f0, 1);
        cnt++;
      }
    }
    if (!Number.isFinite(feat.shimmer)) shimmer = cnt > 0 ? shSum / cnt : 0;
    if (!Number.isFinite(feat.jitter)) jitter = cnt > 0 ? jiSum / cnt : 0;
  }

  let commonCauseCoupling = Number.isFinite(feat.commonCauseCoupling)
    ? clamp01(feat.commonCauseCoupling)
    : 0;
  if (!Number.isFinite(feat.commonCauseCoupling) && activeFrames.length >= 3) {
    const cHf = Math.abs(
      pearson(
        activeFrames.map((fr) => finite(fr.rms, 0)),
        activeFrames.map((fr) => finite(fr.hfRatio, 0))
      )
    );
    const cF0 =
      voicedFrames.length >= 4
        ? Math.abs(
            pearson(
              voicedFrames.map((fr) => finite(fr.rms, 0)),
              voicedFrames.map((fr) => finite(fr.f0, 0))
            )
          )
        : 0;
    commonCauseCoupling = clamp01(Math.max(cHf, cF0));
  }

  const meanSpectralFlatness = Number.isFinite(feat.meanSpectralFlatness)
    ? clamp01(feat.meanSpectralFlatness)
    : clamp01(meanOf(activeFrames.map((fr) => finite(fr.spectralFlatness, 0))));

  const meanTop1PeakShare = Number.isFinite(feat.meanTop1PeakShare) ? clamp01(feat.meanTop1PeakShare) : 0;
  const ioiCv = Number.isFinite(feat.ioiCv) ? Math.max(0, feat.ioiCv) : 0;
  const onsetCount = Number.isFinite(feat.onsetCount) ? feat.onsetCount : 0;

  let f0RangeSemitones = Number.isFinite(feat.f0RangeSemitones) ? Math.max(0, feat.f0RangeSemitones) : -1;
  if (f0RangeSemitones < 0 && voicedFrames.length >= 4) {
    const semi = voicedFrames.map((fr) => 12 * Math.log2(Math.max(fr.f0, 1) / 100));
    f0RangeSemitones = Math.max(0, percentile(semi, 0.95) - percentile(semi, 0.05));
  }

  // =========================================================================
  // Axis 1: respiratoryScore ("呼吸器を使ったもの" — Finite-Lung Signature)
  // Provenance note:
  //   - Literature-derived acoustic scales:
  //       * Breath-group phrasing 0.15s–2.5s (Lieberman 1967; Fuchs et al. 2013)
  //       * Natural vocal micro-variation (jitter/shimmer, Titze 1994)
  //   - Sub-component blend weights (0.28/0.36/0.36, 0.25/0.35/0.18/0.22,
  //     0.45/0.25/0.30) are heuristic v0.6–v0.8 engineering weights (not trained
  //     by regression); this axis is strictly a non-vetoing diagnostic lens.
  // =========================================================================
  const longestRun = Math.max(0, finite(breath.longestContinuousSec, 0));
  const breathlessWallRatio = clamp01(breath.breathlessWallRatio);

  // 1a. Finite-lung phrasing & breath support (biological range 0.15s–2.5s)
  let phraseLenScore;
  if (longestRun < 0.15) {
    phraseLenScore = clamp01(longestRun / 0.15);
  } else if (longestRun <= 2.5) {
    phraseLenScore = 1;
  } else {
    phraseLenScore = Math.max(0.2, 1 - (longestRun - 2.5) / 2.5);
  }
  const isMetronomic = onsetCount >= 4 && ioiCv < 0.06;
  const metronomicPenalty = isMetronomic ? 0.35 : 1;
  const lungSupport = clamp01(phraseLenScore * (1 - 0.45 * breathlessWallRatio) * metronomicPenalty);

  // 1b. Natural dynamic / breath arc ("時間の矢": smooth onset, natural taper, living micro-variation)
  const tailTruncated = finite(feat.tailTruncatedAtEof, 0) >= 0.5;
  const onsetSmooth = 1 - clamp01((maxAttackSlope - 0.35) / 0.65);
  const tailScore = tailTruncated ? 0.75 : clamp01(tailDecaySec / 0.16);
  const swellScore = clamp01(activeRmsCv / 0.45);
  const organicShimmer = clamp01((shimmer - 0.008) / 0.035) * (1 - 0.5 * clamp01((shimmer - 0.45) / 0.55));
  const organicJitter = clamp01((jitter - 0.0005) / 0.004) * (1 - 0.7 * clamp01((jitter - 0.08) / 0.14));
  const chaoticJitterDamp = 1 - 0.45 * clamp01((jitter - 0.10) / 0.15);
  const microVarScore = Math.max(organicShimmer, organicJitter) * chaoticJitterDamp;
  const gatePenalty = !tailTruncated && tailDecaySec < 0.015 ? 0.65 : 1;
  const breathArc = clamp01(
    (0.25 * onsetSmooth + 0.35 * tailScore + 0.18 * swellScore + 0.22 * microVarScore) * gatePenalty
  );

  // 1c. Organic voiced-harmonic / breath coupling (distinct from pure sine beep, unvoiced hiss, or flat static)
  const voicedSupport = clamp01(voicedRatio / 0.75);
  const harmonicWarmth = 1 - clamp01((meanSpectralFlatness - 0.12) / 0.45);
  const couplingSupport = clamp01(commonCauseCoupling / 0.65);
  const sterileTonePenalty = clamp01((meanTop1PeakShare - 0.60) / 0.28);
  const pitchLockedMask =
    voicedRatio > 0.4 && f0RangeSemitones >= 0 && f0RangeSemitones < 1.5
      ? 0.35 + 0.65 * clamp01(f0RangeSemitones / 1.5)
      : 1;
  const rigidElectronicMask =
    voicedRatio > 0.4 && jitter < 0.0008 && shimmer < 0.01 ? 0.35 : 1;
  const organicPhonation = clamp01(
    (0.45 * voicedSupport + 0.25 * harmonicWarmth + 0.30 * couplingSupport) *
      (1 - 0.85 * sterileTonePenalty) *
      pitchLockedMask *
      rigidElectronicMask
  );

  const respiratoryScore = clamp01(
    (0.28 * lungSupport + 0.36 * breathArc + 0.36 * organicPhonation) *
      (0.75 + 0.25 * pitchLockedMask)
  );

  // =========================================================================
  // Axis 2: directnessScore ("誰かに聞かせるために出した音" — Communicative Directness)
  // Provenance note:
  //   - 300–3500 Hz communicative speech band (ITU-T G.711 / P.56)
  //   - 4–16 Hz syllabic/call modulation vs 30–150 Hz roughness (Arnal et al. 2015)
  //   - Blend weights (0.34/0.34/0.32) are heuristic v0.6 engineering weights.
  // =========================================================================
  // 2a. Communicative band focus (300–3500 Hz intelligibility share vs rumble / hiss)
  let midOnlyRatio;
  if (Number.isFinite(feat.midOnlyRatio)) {
    midOnlyRatio = clamp01(feat.midOnlyRatio);
  } else {
    const meanCentroid = meanOf(activeFrames.map((fr) => finite(fr.spectralCentroidHz, 0)));
    midOnlyRatio =
      meanCentroid >= 300 && meanCentroid <= 3500
        ? 0.75
        : meanCentroid > 0
          ? clamp01(1 - Math.abs(Math.log2(Math.max(meanCentroid, 30) / 1100)) / 3.5)
          : 0;
  }
  const subBassRatio = Number.isFinite(feat.subBassRatio) ? clamp01(feat.subBassRatio) : 0;
  const rumblePenalty = 1 - 0.55 * clamp01((subBassRatio - 0.20) / 0.50);
  const bandFocus = clamp01(clamp01(midOnlyRatio / 0.50) * rumblePenalty);

  // Trim leading/trailing silence so forgetting to stop recording never inflates figure-ground or modulation scores
  let firstActiveIdx = -1;
  let lastActiveIdx = -1;
  for (let i = 0; i < fList.length; i++) {
    if (finite(fList[i]?.rms, 0) >= activeThresh) {
      if (firstActiveIdx < 0) firstActiveIdx = i;
      lastActiveIdx = i;
    }
  }
  const trimmedSpan =
    firstActiveIdx >= 0 && lastActiveIdx >= firstActiveIdx
      ? fList.slice(firstActiveIdx, lastActiveIdx + 1)
      : activeFrames;
  const trimmedRms = trimmedSpan.map((fr) => finite(fr.rms, 0));
  const meanTrimmedRms = meanOf(trimmedRms);
  const trimmedRmsCv = meanTrimmedRms > 1e-6 ? stdOf(trimmedRms, meanTrimmedRms) / meanTrimmedRms : 0;

  // 2b. Syllabic / call modulation clarity (4–16 Hz speech/call band vs 30–150 Hz harshness & diffuse noise)
  // Guard against trailing-silence step edges mimicking 4–16 Hz modulation on a flat constant tone
  const internalModGate = clamp01(
    Math.max((trimmedRmsCv - 0.06) / 0.14, finite(breath.pauseCount, 0) > 0 ? 1 : 0)
  );
  const mpsSpeech = Math.max(0, finite(feat.activeMpsSpeech4_16 ?? feat.mpsSpeech4_16, 0));
  const mpsRough = Math.max(0, finite(feat.activeMpsRoughness30_150 ?? feat.mpsRoughness30_150, 0));
  const mpsRatio =
    mpsSpeech + mpsRough > 1e-6
      ? mpsSpeech / (mpsSpeech + mpsRough * 1.5 + 0.015)
      : clamp01(activeRmsCv / 0.35) * 0.6;
  const nonDiffuse = 1 - clamp01((meanSpectralFlatness - 0.15) / 0.55);
  const modClarity = clamp01(clamp01(mpsRatio / 0.75) * nonDiffuse * internalModGate);

  // 2c. Figure-ground clarity (audibility + internal trimmed-span dynamic contrast + tonal SNR)
  let peak = Number.isFinite(feat.peak) ? Math.max(0, feat.peak) : 0;
  if (!Number.isFinite(feat.peak)) {
    for (const fr of fList) {
      const p = Math.max(Math.abs(finite(fr.peakPos, 0)), Math.abs(finite(fr.peakNeg, 0)));
      if (p > peak) peak = p;
    }
    if (peak <= 0) peak = maxRms;
  }
  const audibility = clamp01(peak / 0.12);
  const p90Rms = trimmedRms.length > 0 ? percentile(trimmedRms, 0.9) : maxRms;
  const p10Rms = trimmedRms.length > 0 ? percentile(trimmedRms, 0.1) : 0;
  const envContrast = p90Rms > 1e-6 ? clamp01((p90Rms - p10Rms) / p90Rms) : 0;
  const meanHnrDb = Number.isFinite(feat.meanVoicedHnrDb)
    ? feat.meanVoicedHnrDb
    : voicedFrames.length > 0
      ? meanOf(voicedFrames.map((fr) => finite(fr.hnrDb, 0)))
      : 0;
  const hnrClarity = voicedRatio > 0.1 ? clamp01((meanHnrDb + 5) / 25) : 0;
  const tonalClarity = Math.max(hnrClarity, 1 - meanSpectralFlatness);
  const figureGround = clamp01(audibility * (0.45 * envContrast + 0.55 * tonalClarity));

  const directnessScore = clamp01(
    0.42 * bandFocus + 0.28 * modClarity + 0.30 * figureGround
  );

  let label;
  if (respiratoryScore >= 0.5 && directnessScore >= 0.5) {
    label = "addressed_breath";
  } else if (respiratoryScore >= 0.5 && directnessScore < 0.5) {
    label = "distant_or_private_breath";
  } else if (respiratoryScore < 0.5 && directnessScore >= 0.5) {
    label = "non_breath_signal";
  } else {
    label = "ambient_or_hollow";
  }

  return {
    respiratoryScore: roundTo(respiratoryScore, 4),
    directnessScore: roundTo(directnessScore, 4),
    label,
  };
}

/**
 * Over-Sanitization / Living Imperfection Lens (v0.7 diagnostic lens — NEVER a hard veto):
 * Measures how heavily an audio signal has been smoothed, grid-snapped, brickwalled,
 * or stripped of living micro-variation ("完璧じゃない きれいに整えようとしてない").
 *
 * Combines 4 independent over-polishing cues:
 *   1. microErasure: jitter & shimmer pushed near zero on voiced audio
 *   2. pitchFlattening: narrow f0RangeSemitones (< 1.5 st) or autotune-like flatStepRatio
 *   3. dynamicFlattening: low activeRmsCv & low crestFactorDb (brickwalling)
 *   4. rhythmicSpectralRigidity: metronomic ioiCv (< 0.08 with onsetCount >= 4) or frozen meanSpectralFlux
 *
 * @param {object|null} features
 * @param {object|null} [breathProfile=null]
 * @returns {{
 *   sanitizationScore: number,
 *   imperfectionLabel: "silent" | "alive_unpolished" | "balanced" | "over_sanitized",
 *   cues: {
 *     microErasure: number,
 *     pitchFlattening: number,
 *     dynamicFlattening: number,
 *     rhythmicSpectralRigidity: number,
 *   }
 * }}
 */
export function computeSanitizationIndex(features, breathProfile = null) {
  const feat = features && typeof features === "object" ? features : null;
  const activeFrames = feat ? finite(feat.activeFrameCount, 0) : 0;
  const peak = feat ? finite(feat.peak, 0) : 0;
  const isSilent =
    !feat ||
    activeFrames <= 0 ||
    peak < 1e-4 ||
    (breathProfile && breathProfile.cadenceLabel === "silent");

  if (isSilent) {
    return {
      sanitizationScore: 0,
      imperfectionLabel: "silent",
      cues: {
        microErasure: 0,
        pitchFlattening: 0,
        dynamicFlattening: 0,
        rhythmicSpectralRigidity: 0,
      },
    };
  }

  const voicedRatio = clamp01(finite(feat.voicedRatio, 0));
  const voicedGate = clamp01((voicedRatio - 0.1) / 0.3);

  // 1. Micro-variation erasure (sterile smoothness in jitter & shimmer)
  const jitter = Math.max(0, finite(feat.jitter, 0));
  const shimmer = Math.max(0, finite(feat.shimmer, 0));
  const jitterErasure = 1 - clamp01((jitter - 0.0004) / 0.0056);
  const shimmerErasure = 1 - clamp01((shimmer - 0.006) / 0.044);
  const microErasure = clamp01(voicedGate * (0.55 * jitterErasure + 0.45 * shimmerErasure));

  // 2. Pitch / prosody flattening or grid-snapping
  const f0Range = Math.max(0, finite(feat.f0RangeSemitones, 0));
  const flatStepRatio = clamp01(finite(feat.flatStepRatio, 0));
  const narrowF0 = 1 - clamp01(f0Range / 1.5);
  const gridSnap = clamp01((flatStepRatio - 0.45) / 0.45);
  const pitchFlattening = clamp01(voicedGate * Math.max(narrowF0, gridSnap));

  // 3. Dynamic flattening / brickwalling
  const activeRmsCv = Math.max(0, finite(feat.activeRmsCv, 0));
  const crestFactorDb = Math.max(0, finite(feat.crestFactorDb, 0));
  const lowCv = 1 - clamp01((activeRmsCv - 0.05) / 0.18);
  const lowCrest = 1 - clamp01((crestFactorDb - 2.0) / 4.0);
  const dynamicFlattening = clamp01(0.55 * lowCv + 0.45 * lowCrest);

  // 4. Rhythmic / spectral rigidity
  const onsetCount = Math.max(0, finite(feat.onsetCount, 0));
  const ioiCv = Math.max(0, finite(feat.ioiCv, 0));
  const meanSpectralFlux = Math.max(0, finite(feat.meanSpectralFlux, 0));
  const metronomic = onsetCount >= 4 ? clamp01((0.08 - ioiCv) / 0.08) : 0;
  const frozenFlux = 1 - clamp01((meanSpectralFlux - 0.0002) / 0.0013);
  const rhythmicSpectralRigidity = clamp01(Math.max(metronomic, frozenFlux));

  const weightedMean =
    0.28 * microErasure +
    0.30 * pitchFlattening +
    0.22 * dynamicFlattening +
    0.20 * rhythmicSpectralRigidity;
  const sortedCues = [
    microErasure,
    pitchFlattening,
    dynamicFlattening,
    rhythmicSpectralRigidity,
  ].sort((a, b) => b - a);
  const top2Mean = 0.5 * (sortedCues[0] + sortedCues[1]);
  const sanitizationScore = clamp01(0.65 * weightedMean + 0.35 * top2Mean);

  let imperfectionLabel;
  if (sanitizationScore < 0.35) {
    imperfectionLabel = "alive_unpolished";
  } else if (sanitizationScore < 0.60) {
    imperfectionLabel = "balanced";
  } else {
    imperfectionLabel = "over_sanitized";
  }

  return {
    sanitizationScore: roundTo(sanitizationScore, 4),
    imperfectionLabel,
    cues: {
      microErasure: roundTo(microErasure, 4),
      pitchFlattening: roundTo(pitchFlattening, 4),
      dynamicFlattening: roundTo(dynamicFlattening, 4),
      rhythmicSpectralRigidity: roundTo(rhythmicSpectralRigidity, 4),
    },
  };
}

/**
 * Time-Segmented Mirror: divides audio into compact windows (default 0.5s) and tracks
 * per-window Presence (voiced/HNR/coupling) vs MPS 30–150Hz Roughness vs median F0 so LLMs
 * can inspect coexisting kawaii + unkawaii across time.
 *
 * @param {object|null} profile - AudioProfile from extractAudioProfile (extracted automatically if null)
 * @param {Float32Array|ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {{ windowSec?: number }} [opts={ windowSec: 0.5 }]
 */
export function extractSegmentTimeline(profile, samples, sampleRate, opts = { windowSec: 0.5 }) {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : (profile?.sampleRate || 24000);
  const sig = samples ?? new Float32Array(0);
  const n = sig.length;
  const durationSec = n > 0 ? n / sr : finite(profile?.durationSec, 0);
  const windowSec = Math.max(0.1, Math.min(5.0, finite(opts?.windowSec, 0.5)));

  const prof = profile && Array.isArray(profile.frames)
    ? profile
    : extractAudioProfile(sig, sr);
  const frames = prof.frames || [];
  const breath = computeBreathPauseProfile(frames, durationSec);

  const segments = [];
  if (durationSec <= 0 || n === 0) {
    const voiceCompass = computeVoiceCompass(frames, { durationSec: 0, peak: 0 }, breath);
    return {
      schema: "unkawaii_timeline/v0.5",
      windowSec: roundTo(windowSec, 3),
      durationSec: 0,
      sampleRate: sr,
      breath,
      voiceCompass,
      segments,
    };
  }

  const numWindows = Math.max(1, Math.ceil(durationSec / windowSec));
  for (let w = 0; w < numWindows; w++) {
    const startSec = w * windowSec;
    const endSec = Math.min(durationSec, (w + 1) * windowSec);
    if (endSec - startSec < 0.02 && w > 0) break;

    const s0 = Math.max(0, Math.floor(startSec * sr));
    const s1 = Math.min(n, Math.ceil(endSec * sr));
    const slice = typeof sig.subarray === "function" ? sig.subarray(s0, s1) : sig.slice(s0, s1);
    const mps = computeMpsRoughness(slice, sr);

    const winFrames = frames.filter((f) => f.timeSec >= startSec && f.timeSec < endSec + (w === numWindows - 1 ? 1e-6 : 0));
    const activeWin = winFrames.filter((f) => f.rms >= 0.03);
    const activeRatio = winFrames.length > 0 ? activeWin.length / winFrames.length : 0;
    const voicedWin = activeWin.filter((f) => f.voiced && f.f0 > 0);
    const voicedRatio = activeWin.length > 0 ? voicedWin.length / activeWin.length : 0;
    const meanHnrDb = voicedWin.length > 0 ? meanOf(voicedWin.map((f) => f.hnrDb)) : 0;
    const medianF0 = voicedWin.length > 0 ? median(voicedWin.map((f) => f.f0)) : 0;
    const meanRms = winFrames.length > 0 ? meanOf(winFrames.map((f) => f.rms)) : 0;

    let coupling = 0;
    if (activeWin.length >= 3) {
      const cHf = Math.abs(pearson(activeWin.map((f) => f.rms), activeWin.map((f) => f.hfRatio)));
      const cF0 = voicedWin.length >= 3
        ? Math.abs(pearson(voicedWin.map((f) => f.rms), voicedWin.map((f) => f.f0)))
        : 0;
      coupling = Math.max(cHf, cF0);
    }

    const hnrNorm = Math.max(0, Math.min(1, (meanHnrDb + 5) / 30));
    const presence = activeWin.length > 0
      ? Math.max(0, Math.min(1, 0.45 * voicedRatio + 0.35 * hnrNorm * (voicedRatio > 0 ? 1 : 0) + 0.2 * coupling))
      : 0;

    segments.push({
      startSec: roundTo(startSec, 2),
      endSec: roundTo(endSec, 2),
      presence: roundTo(presence, 3),
      activeRatio: roundTo(activeRatio, 3),
      voicedRatio: roundTo(voicedRatio, 3),
      meanHnrDb: roundTo(meanHnrDb, 1),
      coupling: roundTo(coupling, 3),
      mpsSpeech4_16: roundTo(mps.mpsSpeech4_16, 4),
      mpsRoughness30_150: roundTo(mps.mpsRoughness30_150, 4),
      medianF0: roundTo(medianF0, 1),
      rms: roundTo(meanRms, 3),
    });
  }

  // Share exact full-clip features so Voice Compass matches extractFeatures bit-for-bit
  const fullFeatures =
    opts?.features && typeof opts.features === "object"
      ? opts.features
      : extractFeatures(sig, sr);
  const voiceCompass =
    Number.isFinite(fullFeatures?.respiratoryScore) && Number.isFinite(fullFeatures?.directnessScore)
      ? {
          respiratoryScore: fullFeatures.respiratoryScore,
          directnessScore: fullFeatures.directnessScore,
          label:
            fullFeatures.respiratoryScore >= 0.5 && fullFeatures.directnessScore >= 0.5
              ? "addressed_breath"
              : fullFeatures.respiratoryScore >= 0.5
                ? "distant_or_private_breath"
                : fullFeatures.directnessScore >= 0.5
                  ? "non_breath_signal"
                  : "ambient_or_hollow",
        }
      : computeVoiceCompass(frames, fullFeatures, breath);

  return {
    schema: "unkawaii_timeline/v0.5",
    windowSec: roundTo(windowSec, 3),
    durationSec: roundTo(durationSec, 3),
    sampleRate: sr,
    breath,
    voiceCompass,
    segments,
  };
}
