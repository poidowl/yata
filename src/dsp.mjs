/**
 * src/dsp.mjs — Zero-dependency pure-JS DSP primitives.
 *
 * Exports:
 *   - fftRadix2(re, im)
 *   - hannWindow(size)
 *   - computeMelFilterbank(fftSize, sampleRate, melBands, fMin, fMax)
 *   - estimateF0Parabolic(frame, sampleRate, fMin, fMax)
 *   - computeCycleJitter(samples, sampleRate, f0Track, hopSize)
 *   - computeRoughness(mag, sampleRate, fftSize, topK)
 *   - computeCepstrumComb(meanLogMag, sampleRate, fftSize, medianF0)
 *   - computeModulationDft(series, hopSec, minHz, maxHz)
 *   - computeMpsRoughness(samples, sampleRate)
 *   - computeSubharmonicRatio(samples, sampleRate, f0Track, hopSize)
 *   - pearson(xs, ys)
 *   - median(arr)
 *   - percentile(arr, p)
 */

// Cached FFT lookup tables by power-of-2 size for speed and zero trig drift
const fftTableCache = new Map();

function getFftTables(n) {
  let entry = fftTableCache.get(n);
  if (entry) return entry;

  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }

  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  const twoPiOverN = (2 * Math.PI) / n;
  for (let k = 0; k < half; k++) {
    const ang = -twoPiOverN * k;
    cos[k] = Math.cos(ang);
    sin[k] = Math.sin(ang);
  }

  entry = { rev, cos, sin };
  fftTableCache.set(n, entry);
  return entry;
}

/**
 * In-place radix-2 Cooley-Tukey FFT.
 * Validates re.length === im.length and power-of-2 length >= 1.
 *
 * @param {Float64Array|Float32Array|number[]} re
 * @param {Float64Array|Float32Array|number[]} im
 */
export function fftRadix2(re, im) {
  if (!re || !im || re.length !== im.length) {
    throw new RangeError("fftRadix2 requires re and im arrays of equal length");
  }
  const n = re.length;
  if (n < 1 || (n & (n - 1)) !== 0) {
    throw new RangeError(`fftRadix2 length must be a power of 2 >= 1, got ${n}`);
  }
  if (n === 1) return;

  const { rev, cos, sin } = getFftTables(n);

  // Bit-reversal permutation
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  // Iterative decimation-in-time butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      let twIdx = 0;
      for (let j = 0; j < half; j++) {
        const wr = cos[twIdx];
        const wi = sin[twIdx];
        twIdx += step;

        const uIdx = i + j;
        const vIdx = uIdx + half;
        const vr = re[vIdx];
        const vi = im[vIdx];
        const tr = wr * vr - wi * vi;
        const ti = wr * vi + wi * vr;

        re[vIdx] = re[uIdx] - tr;
        im[vIdx] = im[uIdx] - ti;
        re[uIdx] += tr;
        im[uIdx] += ti;
      }
    }
  }
}

/**
 * Generate a Hann window of length `size`.
 * @param {number} size
 * @returns {Float32Array}
 */
export function hannWindow(size) {
  const n = Math.max(1, Math.floor(size));
  const win = new Float32Array(n);
  if (n === 1) {
    win[0] = 1;
    return win;
  }
  const denom = n - 1;
  for (let i = 0; i < n; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
  }
  return win;
}

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/**
 * Compute a triangular Mel filterbank for magnitude/power spectra of size `fftSize/2 + 1`.
 *
 * @param {number} fftSize
 * @param {number} sampleRate
 * @param {number} [melBands=48]
 * @param {number} [fMin=30]
 * @param {number} [fMax=8000]
 * @returns {{
 *   bands: Array<{ startBin: number, endBin: number, weights: Float32Array, centerHz: number }>,
 *   centerFreqsHz: number[],
 *   melBands: number,
 *   fftSize: number,
 *   sampleRate: number
 * }}
 */
export function computeMelFilterbank(fftSize, sampleRate, melBands = 48, fMin = 30, fMax = 8000) {
  const numBins = (fftSize >> 1) + 1;
  const nyquist = sampleRate * 0.5;
  const effFMax = Math.max(100, Math.min(fMax, nyquist));
  const effFMin = Math.max(10, Math.min(fMin, effFMax * 0.5));

  const melMin = hzToMel(effFMin);
  const melMax = hzToMel(effFMax);
  const melStep = (melMax - melMin) / (melBands + 1);

  const edgeHz = new Float64Array(melBands + 2);
  const edgeBin = new Float64Array(melBands + 2);
  for (let i = 0; i < melBands + 2; i++) {
    edgeHz[i] = melToHz(melMin + i * melStep);
    edgeBin[i] = (edgeHz[i] * fftSize) / sampleRate;
  }

  const bands = [];
  const centerFreqsHz = [];

  for (let m = 0; m < melBands; m++) {
    const left = edgeBin[m];
    const center = edgeBin[m + 1];
    const right = edgeBin[m + 2];
    const centerHz = edgeHz[m + 1];
    centerFreqsHz.push(centerHz);

    const startBin = Math.max(0, Math.floor(left));
    const endBin = Math.min(numBins - 1, Math.ceil(right));
    const len = Math.max(1, endBin - startBin + 1);
    const weights = new Float32Array(len);

    let sumW = 0;
    for (let b = startBin; b <= endBin; b++) {
      let w = 0;
      if (b >= left && b <= center && center > left) {
        w = (b - left) / (center - left);
      } else if (b > center && b <= right && right > center) {
        w = (right - b) / (right - center);
      }
      weights[b - startBin] = w;
      sumW += w;
    }

    // Ensure narrow low-frequency Mel bands never become empty due to integer bin quantization
    if (sumW <= 1e-9) {
      const nearest = Math.max(startBin, Math.min(endBin, Math.round(center)));
      weights[nearest - startBin] = 1;
      sumW = 1;
    } else {
      for (let k = 0; k < len; k++) {
        weights[k] /= sumW;
      }
    }

    bands.push({ startBin, endBin, weights, centerHz });
  }

  return { bands, centerFreqsHz, melBands, fftSize, sampleRate };
}

// Reusable scratch buffers for FFT-accelerated autocorrelation in estimateF0Parabolic
const acScratchCache = new Map();

function getAcScratch(fftLen, frameLen) {
  const key = fftLen;
  let s = acScratchCache.get(key);
  if (!s || s.prefixSq.length < frameLen + 1) {
    s = {
      re: new Float64Array(fftLen),
      im: new Float64Array(fftLen),
      prefixSq: new Float64Array(Math.max(frameLen + 1, fftLen)),
      r: new Float64Array(fftLen >> 1),
    };
    acScratchCache.set(key, s);
  }
  return s;
}

/**
 * Internal FFT-accelerated exact normalized autocorrelation F0 estimator on a prepared frame.
 */
function runAutocorrF0(sig, sr, fMin, fMax) {
  const n = sig.length;
  const minLag = Math.max(2, Math.floor(sr / fMax));
  const maxLag = Math.min(n - 3, Math.ceil(sr / fMin));
  if (maxLag <= minLag + 1) {
    return { f0: 0, periodicity: 0, hnrDb: 0, totalSq: 0, mean: 0 };
  }

  // Remove frame mean (DC) so DC offset does not bias periodicity
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sig[i];
  mean /= n;

  let fftLen = 1;
  const needed = n + maxLag + 2;
  while (fftLen < needed) fftLen <<= 1;

  const { re, im, prefixSq, r } = getAcScratch(fftLen, n);
  prefixSq[0] = 0;
  let totalSq = 0;
  for (let i = 0; i < n; i++) {
    const x = sig[i] - mean;
    re[i] = x;
    im[i] = 0;
    totalSq += x * x;
    prefixSq[i + 1] = totalSq;
  }

  const rms = Math.sqrt(totalSq / n);
  if (rms < 1e-6) {
    return { f0: 0, periodicity: 0, hnrDb: 0, totalSq, mean };
  }

  re.fill(0, n, fftLen);
  im.fill(0, n, fftLen);

  // Wiener-Khinchin autocorrelation via FFT
  fftRadix2(re, im);
  for (let k = 0; k < fftLen; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  fftRadix2(re, im);

  const invM = 1 / fftLen;
  const lagLo = Math.max(1, minLag - 1);
  const lagHi = Math.min(n - 2, maxLag + 1);

  let globalMax = -1;
  for (let lag = lagLo; lag <= lagHi; lag++) {
    const denA = prefixSq[n - lag];
    const denB = totalSq - prefixSq[lag];
    const denom = Math.sqrt(denA * denB);
    const c = denom > 1e-12 ? (re[lag] * invM) / denom : 0;
    r[lag] = c;
    if (lag >= minLag && lag <= maxLag && c > globalMax) {
      globalMax = c;
    }
  }

  if (globalMax <= 0.05) {
    return { f0: 0, periodicity: Math.max(0, globalMax), hnrDb: -20, totalSq, mean };
  }

  // Octave-halving guard: choose the smallest lag local maximum reaching >= 92% of globalMax
  const threshold = globalMax * 0.92;
  let bestLag = -1;
  let bestVal = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    const c = r[lag];
    if (c >= r[lag - 1] && c >= r[lag + 1] && c >= threshold) {
      bestLag = lag;
      bestVal = c;
      break;
    }
  }

  // Fallback to global maximum if no interior local peak met threshold
  if (bestLag < 0) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (r[lag] > bestVal) {
        bestVal = r[lag];
        bestLag = lag;
      }
    }
  }

  // Parabolic peak interpolation around bestLag
  let refinedLag = bestLag;
  let refinedPeak = bestVal;
  if (bestLag > lagLo && bestLag < lagHi) {
    const y0 = r[bestLag - 1];
    const y1 = r[bestLag];
    const y2 = r[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      let delta = (0.5 * (y0 - y2)) / denom;
      if (delta < -0.5) delta = -0.5;
      else if (delta > 0.5) delta = 0.5;
      refinedLag = bestLag + delta;
      refinedPeak = y1 - 0.25 * (y0 - y2) * delta;
    }
  }

  const periodicity = Math.max(0, Math.min(1, refinedPeak));
  const f0 = refinedLag > 0 ? sr / refinedLag : 0;

  // Boersma autocorrelation HNR in dB, clamped to [-20, 40]
  const rClamped = Math.max(1e-6, Math.min(0.9999, periodicity));
  const hnrDb = Math.max(-20, Math.min(40, 10 * Math.log10(rClamped / (1 - rClamped))));

  return { f0, periodicity, hnrDb, totalSq, mean };
}

/**
 * Zero-phase (forward + backward) 1st-order RC high-pass filter for <80 Hz rumble rejection.
 */
function highPassZeroPhase(sig, mean, sr, fcHz = 110) {
  const n = sig.length;
  const alpha = 1 / (1 + (2 * Math.PI * fcHz) / sr);
  const fwd = new Float32Array(n);
  let prevX = sig[0] - mean;
  let prevY = 0;
  fwd[0] = 0;
  for (let i = 1; i < n; i++) {
    const x = sig[i] - mean;
    const y = alpha * (prevY + x - prevX);
    fwd[i] = y;
    prevX = x;
    prevY = y;
  }

  const out = new Float32Array(n);
  prevX = fwd[n - 1];
  prevY = 0;
  out[n - 1] = 0;
  let hpSq = 0;
  for (let i = n - 2; i >= 0; i--) {
    const x = fwd[i];
    const y = alpha * (prevY + x - prevX);
    out[i] = y;
    hpSq += y * y;
    prevX = x;
    prevY = y;
  }
  return { out, hpSq };
}

/**
 * Estimate fundamental frequency F0 via FFT-accelerated exact normalized autocorrelation
 * with octave-halving guard, parabolic peak interpolation, and <80 Hz wind/handling
 * rumble F0-hijack guard.
 *
 * @param {Float32Array|ArrayLike<number>} frame
 * @param {number} sampleRate
 * @param {number} [fMin=55]
 * @param {number} [fMax=1000]
 * @returns {{ f0: number, periodicity: number, hnrDb: number }}
 */
export function estimateF0Parabolic(frame, sampleRate, fMin = 55, fMax = 1000) {
  const rawN = frame?.length ?? 0;
  if (rawN < 16 || sampleRate <= 0) {
    return { f0: 0, periodicity: 0, hnrDb: 0 };
  }

  // 2x box-average decimation for high sample rates (>= 32 kHz): halves FFT size
  // while keeping Nyquist >= 16 kHz (far above fMax <= 1500 Hz) and preserving accuracy.
  let sig = frame;
  let sr = sampleRate;
  if (sampleRate >= 32000 && fMax <= 1500 && rawN >= 64) {
    const decN = rawN >> 1;
    const dec = new Float32Array(decN);
    for (let i = 0; i < decN; i++) {
      dec[i] = 0.5 * (frame[i << 1] + frame[(i << 1) + 1]);
    }
    sig = dec;
    sr = sampleRate * 0.5;
  }

  const raw = runAutocorrF0(sig, sr, fMin, fMax);

  // Guard against <80 Hz microphone handling / wind rumble hijacking F0 when
  // substantial mid/high vocal energy (>110 Hz) is present in the frame.
  // True 60 Hz mains hum has tiny >110 Hz energy (hpRatio < 0.08) and true deep
  // harmonic voices (e.g. 70 Hz with 140/210/280 Hz harmonics) still peak at ~70 Hz
  // after high-pass filtering, so both remain intact.
  if (raw.f0 > 0 && raw.f0 < 85 && fMin < 85 && raw.totalSq > 1e-12) {
    const { out: hpSig, hpSq } = highPassZeroPhase(sig, raw.mean, sr, 110);
    const hpRatio = hpSq / raw.totalSq;
    if (hpRatio >= 0.08) {
      const hpEst = runAutocorrF0(hpSig, sr, fMin, fMax);
      if (hpEst.f0 >= 85 && hpEst.periodicity >= 0.5) {
        return { f0: hpEst.f0, periodicity: hpEst.periodicity, hnrDb: hpEst.hnrDb };
      }
      if (hpRatio >= 0.2 && hpEst.periodicity < 0.35) {
        return { f0: hpEst.f0, periodicity: hpEst.periodicity, hnrDb: hpEst.hnrDb };
      }
    }
  }

  return { f0: raw.f0, periodicity: raw.periodicity, hnrDb: raw.hnrDb };
}

/**
 * Cycle-to-cycle local period jitter via 2nd-order detrended Relative Average Perturbation (RAP):
 *   RAP = mean_k( |T_k - 0.5 * (T_{k-1} + T_{k+1})| ) / mean(T)
 *
 * Unlike frame-to-frame F0 differencing, 2nd-order cycle-period detrending is invariant to
 * smooth pitch glides (where T_k ≈ 0.5 * (T_{k-1} + T_{k+1})) while accurately measuring
 * true cycle-to-cycle period perturbation.
 *
 * @param {Float32Array|ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {ArrayLike<number>} f0Track - Per-frame F0 in Hz (<= 0 for unvoiced frames)
 * @param {number} hopSize - Samples per frame hop
 * @returns {number} Relative cycle-to-cycle jitter (>= 0)
 */
export function computeCycleJitter(samples, sampleRate, f0Track, hopSize) {
  const n = samples?.length ?? 0;
  const numFrames = f0Track?.length ?? 0;
  if (n < 16 || sampleRate <= 0 || numFrames === 0 || !Number.isFinite(hopSize) || hopSize <= 0) {
    return 0;
  }

  let rapDiffSum = 0;
  let periodSum = 0;
  let rapCount = 0;

  const refinePeak = (idx, sign) => {
    if (idx <= 0 || idx >= n - 1) return idx;
    const y0 = sign * samples[idx - 1];
    const y1 = sign * samples[idx];
    const y2 = sign * samples[idx + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom < -1e-12) {
      let delta = (0.5 * (y0 - y2)) / denom;
      if (delta < -0.5) delta = -0.5;
      else if (delta > 0.5) delta = 0.5;
      return idx + delta;
    }
    return idx;
  };

  const flushRun = (periods) => {
    if (periods.length < 3) return;
    for (let k = 1; k + 1 < periods.length; k++) {
      const avgNeighbor = 0.5 * (periods[k - 1] + periods[k + 1]);
      rapDiffSum += Math.abs(periods[k] - avgNeighbor);
      periodSum += periods[k];
      rapCount++;
    }
  };

  let f = 0;
  while (f < numFrames) {
    while (f < numFrames && !(f0Track[f] > 40)) f++;
    if (f >= numFrames) break;
    const fStart = f;
    while (f < numFrames && f0Track[f] > 40) f++;
    const fEnd = f - 1;

    const sStart = Math.max(1, Math.floor(fStart * hopSize));
    const sEnd = Math.min(n - 2, Math.floor((fEnd + 1) * hopSize));
    if (sEnd - sStart < 8) continue;

    const f0Init = f0Track[fStart];
    const tInit = sampleRate / f0Init;
    const firstWindowEnd = Math.min(sEnd, sStart + Math.max(4, Math.ceil(tInit)));

    // Choose dominant polarity in the opening period so inverted glottal pulses track cleanly
    let maxPos = -Infinity;
    let maxPosIdx = sStart;
    let minNeg = Infinity;
    let minNegIdx = sStart;
    for (let i = sStart; i <= firstWindowEnd; i++) {
      const v = samples[i];
      if (v > maxPos) {
        maxPos = v;
        maxPosIdx = i;
      }
      if (v < minNeg) {
        minNeg = v;
        minNegIdx = i;
      }
    }
    const sign = Math.abs(minNeg) > maxPos * 1.15 ? -1 : 1;
    let prevPos = refinePeak(sign > 0 ? maxPosIdx : minNegIdx, sign);

    let runPeriods = [];
    let guard = 0;
    const maxCycles = Math.ceil((sEnd - sStart) / Math.max(2, sampleRate / 1200)) + 4;

    while (guard++ < maxCycles) {
      const fIdx = Math.min(fEnd, Math.max(fStart, Math.floor(prevPos / hopSize)));
      const localF0 = f0Track[fIdx];
      if (!(localF0 > 40)) break;
      const tExp = sampleRate / localF0;

      const lo = Math.max(Math.floor(prevPos) + 1, Math.round(prevPos + 0.72 * tExp));
      const hi = Math.min(sEnd, Math.round(prevPos + 1.28 * tExp));
      if (lo >= hi || lo >= sEnd) break;

      let bestIdx = -1;
      let bestVal = -Infinity;
      for (let i = lo; i <= hi; i++) {
        const v = sign * samples[i];
        if (v >= sign * samples[i - 1] && v >= sign * samples[i + 1] && v > bestVal) {
          bestVal = v;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) {
        for (let i = lo; i <= hi; i++) {
          const v = sign * samples[i];
          if (v > bestVal) {
            bestVal = v;
            bestIdx = i;
          }
        }
      }
      if (bestIdx < 0) break;

      const currPos = refinePeak(bestIdx, sign);
      const period = currPos - prevPos;
      if (period >= 0.65 * tExp && period <= 1.35 * tExp) {
        runPeriods.push(period);
      } else {
        flushRun(runPeriods);
        runPeriods = [];
      }
      prevPos = currPos;
    }

    flushRun(runPeriods);
  }

  if (rapCount === 0 || periodSum <= 1e-9) return 0;
  return rapDiffSum / periodSum;
}

/**
 * Plomp-Levelt / Sethares (1993) sensory roughness across top-K local spectral peaks.
 * Harmonic tones score low (< 0.16); closely-spaced beating clusters score high (> 0.28).
 *
 * Academic reference:
 *   Sethares, W. A. (1993). "Local consonance and the relationship between timbre and scale."
 *   Journal of the Acoustical Society of America (JASA), 94(3), 1218–1228.
 *   Parametrizes Plomp & Levelt (1965) critical-band dissonance curves via:
 *     d(f1, f2) = a1 * a2 * (exp(-3.5 * s * |f2 - f1|) - exp(-5.75 * s * |f2 - f1|)),
 *     s = 0.24 / (0.021 * min(f1, f2) + 19).
 *
 * @param {Float32Array|ArrayLike<number>} mag - Linear magnitude spectrum (length fftSize/2 + 1)
 * @param {number} sampleRate
 * @param {number} fftSize
 * @param {number} [topK=12]
 * @returns {number} Roughness in [0, 1]
 */
export function computeRoughness(mag, sampleRate, fftSize, topK = 12) {
  if (!mag || mag.length < 4 || sampleRate <= 0 || fftSize <= 0) return 0;

  const binHz = sampleRate / fftSize;
  const minBin = Math.max(1, Math.ceil(50 / binHz));
  const maxBin = Math.min(mag.length - 2, Math.floor(Math.min(8000, sampleRate * 0.5) / binHz));
  if (maxBin <= minBin) return 0;

  // Find local spectral peaks above -40 dB of frame peak with parabolic frequency refinement
  let maxMag = 0;
  for (let b = minBin; b <= maxBin; b++) {
    if (mag[b] > maxMag) maxMag = mag[b];
  }
  const ampFloor = Math.max(1e-8, maxMag * 0.01);

  const peaks = [];
  for (let b = minBin; b <= maxBin; b++) {
    const v = mag[b];
    if (v > ampFloor && v > mag[b - 1] && v >= mag[b + 1]) {
      const y0 = mag[b - 1];
      const y2 = mag[b + 1];
      const denom = y0 - 2 * v + y2;
      let delta = 0;
      if (Math.abs(denom) > 1e-12) {
        delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
      }
      peaks.push({ hz: (b + delta) * binHz, amp: v });
    }
  }

  if (peaks.length < 2) return 0;

  peaks.sort((a, b) => b.amp - a.amp);
  const k = Math.min(topK, peaks.length);

  let energySum = 0;
  for (let i = 0; i < k; i++) {
    energySum += peaks[i].amp * peaks[i].amp;
  }
  if (energySum <= 1e-18) return 0;

  // Sethares (1993) sensory dissonance kernel normalized so kernel peak = 1.0
  // Max of exp(-3.5*x) - exp(-5.75*x) is ~0.163625
  const invKernelMax = 1 / 0.163625;
  let dissonance = 0;

  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const f1 = Math.min(peaks[i].hz, peaks[j].hz);
      const f2 = Math.max(peaks[i].hz, peaks[j].hz);
      const df = f2 - f1;
      if (df < 1) continue;
      const s = 0.24 / (0.021 * f1 + 19);
      const x = s * df;
      const kernel = (Math.exp(-3.5 * x) - Math.exp(-5.75 * x)) * invKernelMax;
      if (kernel > 0) {
        dissonance += peaks[i].amp * peaks[j].amp * kernel;
      }
    }
  }

  const normalized = dissonance / (0.5 * energySum);
  return Math.max(0, Math.min(1, normalized));
}

/**
 * Real cepstrum comb-filter detector over the 300–5000 Hz log-magnitude spectrum.
 * Excludes ±15% around pitch quefrency 1/medianF0 and its integer multiples.
 *
 * @param {Float32Array|ArrayLike<number>} meanLogMag - Mean natural-log magnitude spectrum (len fftSize/2 + 1)
 * @param {number} sampleRate
 * @param {number} fftSize
 * @param {number} [medianF0=0]
 * @returns {{ nonPitchCepstralPeak: number, combNotchDepthDb: number, combDelayMs: number }}
 */
export function computeCepstrumComb(meanLogMag, sampleRate, fftSize, medianF0 = 0) {
  if (!meanLogMag || meanLogMag.length < 8 || sampleRate <= 0 || fftSize < 16) {
    return { nonPitchCepstralPeak: 0, combNotchDepthDb: 0, combDelayMs: 0 };
  }

  const half = fftSize >> 1;
  const binHz = sampleRate / fftSize;
  const bMin = Math.max(1, Math.ceil(300 / binHz));
  const bMax = Math.min(half - 1, Math.floor(Math.min(5000, sampleRate * 0.48) / binHz));
  const bandLen = bMax - bMin + 1;
  if (bandLen < 16) {
    return { nonPitchCepstralPeak: 0, combNotchDepthDb: 0, combDelayMs: 0 };
  }

  // Linearly detrend log-magnitude in [bMin, bMax] and apply Hann taper
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (let i = 0; i < bandLen; i++) {
    const y = Number.isFinite(meanLogMag[bMin + i]) ? meanLogMag[bMin + i] : 0;
    sumX += i;
    sumY += y;
    sumXX += i * i;
    sumXY += i * y;
  }
  const denom = bandLen * sumXX - sumX * sumX;
  const slope = Math.abs(denom) > 1e-12 ? (bandLen * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / bandLen;

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  let sumWin = 0;
  for (let i = 0; i < bandLen; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (bandLen - 1)));
    const y = (Number.isFinite(meanLogMag[bMin + i]) ? meanLogMag[bMin + i] : 0) - (intercept + slope * i);
    const val = y * w;
    const bin = bMin + i;
    re[bin] = val;
    re[fftSize - bin] = val;
    sumWin += w;
  }

  if (sumWin <= 1e-9) {
    return { nonPitchCepstralPeak: 0, combNotchDepthDb: 0, combDelayMs: 0 };
  }

  fftRadix2(re, im);

  // Search quefrencies 2 ms .. 15 ms
  const qMin = Math.max(2, Math.ceil(0.002 * sampleRate));
  const qMax = Math.min(half - 1, Math.floor(0.015 * sampleRate));
  if (qMax <= qMin) {
    return { nonPitchCepstralPeak: 0, combNotchDepthDb: 0, combDelayMs: 0 };
  }

  const pitchQ = medianF0 > 40 ? sampleRate / medianF0 : 0;
  const isPitchExcluded = (q) => {
    if (pitchQ <= 0) return false;
    for (let m = 1; m * pitchQ <= qMax * 1.2; m++) {
      const target = m * pitchQ;
      if (Math.abs(q - target) <= 0.15 * target) return true;
    }
    return false;
  };

  // Since both +bin and -bin were populated symmetrically, a cos(2*pi*f*tau) ripple
  // of amplitude A produces |re[q]| = A * sumWin. Thus amplitudeNepers = |re[q]| / sumWin.
  let bestPeak = 0;
  let bestQ = 0;
  for (let q = qMin; q <= qMax; q++) {
    if (isPitchExcluded(q)) continue;
    const amp = Math.abs(re[q]) / sumWin;
    if (amp > bestPeak) {
      bestPeak = amp;
      bestQ = q;
    }
  }

  // Convert sinusoidal ripple amplitude in nepers to peak-to-trough depth in dB: 2 * (20 / ln(10)) * A
  const combNotchDepthDb = bestPeak * (40 / Math.LN10);
  const combDelayMs = bestQ > 0 ? (bestQ / sampleRate) * 1000 : 0;

  return {
    nonPitchCepstralPeak: bestPeak,
    combNotchDepthDb,
    combDelayMs,
  };
}

/**
 * Detrended modulation DFT over [minHz, maxHz].
 * Returns dominant sinusoidal modulation depth, sinusoidality in [0, 1], and frequency in Hz.
 *
 * @param {ArrayLike<number>} series
 * @param {number} hopSec
 * @param {number} minHz
 * @param {number} maxHz
 * @returns {{ depth: number, sinusoidality: number, freqHz: number }}
 */
export function computeModulationDft(series, hopSec, minHz, maxHz) {
  const n = series?.length ?? 0;
  if (n < 8 || hopSec <= 0 || maxHz <= minHz) {
    return { depth: 0, sinusoidality: 0, freqHz: 0 };
  }

  // Linear detrending (removes DC and monotonic drift)
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (let i = 0; i < n; i++) {
    const y = Number.isFinite(series[i]) ? series[i] : 0;
    sumX += i;
    sumY += y;
    sumXX += i * i;
    sumXY += i * y;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = Math.abs(denom) > 1e-12 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;

  const detrended = new Float64Array(n);
  let totalEnergy = 0;
  for (let i = 0; i < n; i++) {
    const y = (Number.isFinite(series[i]) ? series[i] : 0) - (intercept + slope * i);
    detrended[i] = y;
    totalEnergy += y * y;
  }

  if (totalEnergy <= 1e-12) {
    return { depth: 0, sinusoidality: 0, freqHz: 0 };
  }

  const nyquist = 0.5 / hopSec;
  const effMaxHz = Math.min(maxHz, nyquist * 0.95);
  if (effMaxHz <= minHz) {
    return { depth: 0, sinusoidality: 0, freqHz: 0 };
  }

  const numSteps = Math.min(180, Math.max(32, Math.ceil((effMaxHz - minHz) / 0.125)));
  const df = (effMaxHz - minHz) / numSteps;

  let bestMagSq = 0;
  let bestFreq = minHz;

  for (let s = 0; s <= numSteps; s++) {
    const freq = minHz + s * df;
    const omega = 2 * Math.PI * freq * hopSec;
    const cosW = Math.cos(omega);
    const sinW = Math.sin(omega);
    let c = 1;
    let si = 0;
    let sumRe = 0;
    let sumIm = 0;
    for (let i = 0; i < n; i++) {
      const x = detrended[i];
      sumRe += x * c;
      sumIm -= x * si;
      const nextC = c * cosW - si * sinW;
      si = si * cosW + c * sinW;
      c = nextC;
    }
    const magSq = sumRe * sumRe + sumIm * sumIm;
    if (magSq > bestMagSq) {
      bestMagSq = magSq;
      bestFreq = freq;
    }
  }

  const mag = Math.sqrt(bestMagSq);
  const depth = (2 * mag) / n;
  const sinusoidality = Math.max(0, Math.min(1, ((2 * bestMagSq) / n) / totalEnergy));

  return { depth, sinusoidality, freqHz: bestFreq };
}

/**
 * Modulation Power Spectrum (MPS) roughness lens (30–150 Hz vs 4–16 Hz speech rhythm).
 *
 * Academic references:
 *   - Arnal, L. H., Flinker, A., Kleinschmidt, A., Giraud, A.-L., & Poeppel, D. (2015).
 *     "Human screams occupy a privileged niche in the communication soundscape."
 *     Current Biology, 25(15), 2051–2056.
 *   - Arnal, L. H., & Gonçalves, A. (2025).
 *     Philosophical Transactions of the Royal Society B.
 *
 * Normal speech & singing modulate amplitude primarily in 4–16 Hz, whereas human screams,
 * animal distress/threat calls, and artificial alarms occupy a conserved 30–150 Hz roughness
 * niche. Computes the rectified amplitude envelope downsampled to ~600 Hz (Nyquist ~300 Hz)
 * and measures Welch-averaged Hann-windowed modulation power in 4–16 Hz and 30–150 Hz.
 *
 * @param {Float32Array|ArrayLike<number>} samples
 * @param {number} sampleRate
 * @returns {{ mpsSpeech4_16: number, mpsRoughness30_150: number, mpsRoughToSpeechRatio: number }}
 */
export function computeMpsRoughness(samples, sampleRate) {
  const n = samples?.length ?? 0;
  if (n < 32 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { mpsSpeech4_16: 0, mpsRoughness30_150: 0, mpsRoughToSpeechRatio: 0 };
  }

  let mean = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    if (Number.isFinite(x)) mean += x;
  }
  mean /= n;

  // Box-average decimate rectified envelope to ~600 Hz (Nyquist ~300 Hz > 150 Hz)
  const dec = Math.max(1, Math.round(sampleRate / 600));
  const envSr = sampleRate / dec;
  const envLen = Math.floor(n / dec);
  if (envLen < 16 || envSr <= 160) {
    return { mpsSpeech4_16: 0, mpsRoughness30_150: 0, mpsRoughToSpeechRatio: 0 };
  }

  const env = new Float32Array(envLen);
  const invDec = 1 / dec;
  let globalEnvSum = 0;
  for (let i = 0; i < envLen; i++) {
    let s = 0;
    const base = i * dec;
    for (let k = 0; k < dec; k++) {
      const x = samples[base + k];
      s += Math.abs((Number.isFinite(x) ? x : 0) - mean);
    }
    const v = s * invDec;
    env[i] = v;
    globalEnvSum += v;
  }

  if (globalEnvSum / envLen < 1e-6) {
    return { mpsSpeech4_16: 0, mpsRoughness30_150: 0, mpsRoughToSpeechRatio: 0 };
  }

  const blockLen = envLen >= 512 ? 512 : envLen;
  const hop = envLen >= 512 ? 256 : blockLen;
  let fftLen = 32;
  while (fftLen < blockLen) fftLen <<= 1;

  const win = hannWindow(blockLen);
  let winSqSum = 0;
  for (let i = 0; i < blockLen; i++) winSqSum += win[i] * win[i];
  if (winSqSum <= 1e-12) {
    return { mpsSpeech4_16: 0, mpsRoughness30_150: 0, mpsRoughToSpeechRatio: 0 };
  }

  const re = new Float64Array(fftLen);
  const im = new Float64Array(fftLen);
  const half = fftLen >> 1;
  const binHz = envSr / fftLen;
  const scale = 2 / (fftLen * winSqSum);

  let speechNormSum = 0;
  let roughNormSum = 0;
  let validBlocks = 0;

  for (let start = 0; start + blockLen <= envLen; start += hop) {
    let bMean = 0;
    for (let i = 0; i < blockLen; i++) bMean += env[start + i];
    bMean /= blockLen;
    const dcPow = bMean * bMean;
    if (dcPow < 1e-12) continue;

    for (let i = 0; i < blockLen; i++) {
      re[i] = (env[start + i] - bMean) * win[i];
      im[i] = 0;
    }
    for (let i = blockLen; i < fftLen; i++) {
      re[i] = 0;
      im[i] = 0;
    }

    fftRadix2(re, im);

    let acPow = 0;
    let speechPow = 0;
    let roughPow = 0;
    for (let k = 1; k < half; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) * scale;
      acPow += p;
      const hz = k * binHz;
      if (hz >= 4 && hz <= 16) speechPow += p;
      else if (hz >= 30 && hz <= 150) roughPow += p;
    }

    const totalPow = dcPow + acPow;
    if (totalPow > 1e-12) {
      speechNormSum += Math.min(1, speechPow / totalPow);
      roughNormSum += Math.min(1, roughPow / totalPow);
      validBlocks++;
    }
  }

  if (validBlocks === 0) {
    return { mpsSpeech4_16: 0, mpsRoughness30_150: 0, mpsRoughToSpeechRatio: 0 };
  }

  const mpsSpeech4_16 = Math.max(0, Math.min(1, speechNormSum / validBlocks));
  const mpsRoughness30_150 = Math.max(0, Math.min(1, roughNormSum / validBlocks));
  const mpsRoughToSpeechRatio = mpsRoughness30_150 / (mpsSpeech4_16 + 1e-6);

  return { mpsSpeech4_16, mpsRoughness30_150, mpsRoughToSpeechRatio };
}

/**
 * Nonlinear vocal subharmonic ratio (period-doubling f0/2 detector) on voiced frames.
 *
 * Academic references:
 *   - Wilden, I., Herzel, H., Peters, G., & Tembrock, G. (1998).
 *     "Subharmonics, biphonation, and deterministic chaos in mammal vocalization." Bioacoustics.
 *   - Fitch, W. T., Neubauer, J., & Herzel, H. (2002).
 *     "Calls out of chaos: the adaptive significance of nonlinear phenomena in mammalian
 *     vocal production." Animal Behaviour, 63(3), 407–418.
 *   - Anikin, A. (2020).
 *     "A sound synthesizer for studies of emotion and animal communication." Behavior Research Methods.
 *
 * Compares normalized autocorrelation at period 2*T0 vs T0 (and T0/2 when the F0 tracker has
 * already octave-locked onto f0/2) together with Hann-windowed spectral energy at half-integer
 * harmonics (k+0.5)*f0 vs integer harmonics k*f0 (with quarter-harmonic noise floor subtraction).
 *
 * @param {Float32Array|ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {ArrayLike<number>} f0Track - Per-frame F0 in Hz (<= 0 for unvoiced frames)
 * @param {number} hopSize - Samples per frame hop
 * @returns {number} Subharmonic ratio in [0, 1]
 */
export function computeSubharmonicRatio(samples, sampleRate, f0Track, hopSize) {
  const n = samples?.length ?? 0;
  const numFrames = f0Track?.length ?? 0;
  if (n < 64 || !Number.isFinite(sampleRate) || sampleRate <= 0 || numFrames === 0 || !Number.isFinite(hopSize) || hopSize <= 0) {
    return 0;
  }

  const voicedFrames = [];
  for (let f = 0; f < numFrames; f++) {
    const hz = f0Track[f];
    if (Number.isFinite(hz) && hz >= 55 && hz <= 1000) {
      voicedFrames.push(f);
    }
  }
  if (voicedFrames.length === 0) return 0;

  const stride = Math.max(1, Math.floor(voicedFrames.length / 24));

  const normAutocorr = (buf, len, lag) => {
    if (lag < 2 || lag >= len - 2) return 0;
    let num = 0;
    let sqA = 0;
    let sqB = 0;
    const m = len - lag;
    for (let i = 0; i < m; i++) {
      const a = buf[i];
      const b = buf[i + lag];
      num += a * b;
      sqA += a * a;
      sqB += b * b;
    }
    const den = Math.sqrt(sqA * sqB);
    return den > 1e-12 ? num / den : 0;
  };

  const maxAutocorrAround = (buf, len, centerLag, radius) => {
    let best = -1;
    const lo = Math.max(2, centerLag - radius);
    const hi = Math.min(len - 3, centerLag + radius);
    for (let lag = lo; lag <= hi; lag++) {
      const c = normAutocorr(buf, len, lag);
      if (c > best) best = c;
    }
    return best > -1 ? best : 0;
  };

  const tonePower = (buf, len, win, freqHz, sr) => {
    if (freqHz <= 0 || freqHz >= sr * 0.48) return 0;
    const omega = (2 * Math.PI * freqHz) / sr;
    const cosW = Math.cos(omega);
    const sinW = Math.sin(omega);
    let c = 1;
    let s = 0;
    let re = 0;
    let im = 0;
    for (let i = 0; i < len; i++) {
      const x = buf[i] * win[i];
      re += x * c;
      im -= x * s;
      const nc = c * cosW - s * sinW;
      s = s * cosW + c * sinW;
      c = nc;
    }
    return re * re + im * im;
  };

  let subSum = 0;
  let validCount = 0;

  for (let idx = 0; idx < voicedFrames.length; idx += stride) {
    const f = voicedFrames[idx];
    const f0 = f0Track[f];
    const t0 = sampleRate / f0;

    // Need at least ~2.5*T0 to evaluate lag 2*T0 cleanly
    const targetLen = Math.min(n, Math.max(256, Math.min(2048, Math.ceil(3.0 * t0))));
    if (targetLen < 2.2 * t0) continue;

    const center = Math.round((f + 0.5) * hopSize);
    const start = Math.max(0, Math.min(n - targetLen, center - (targetLen >> 1)));

    // Decimate 2x for >= 32 kHz to keep inner loops fast without losing subharmonic harmonics
    const dec = sampleRate >= 32000 && targetLen >= 512 ? 2 : 1;
    const sr = sampleRate / dec;
    const len = Math.floor(targetLen / dec);
    const buf = new Float32Array(len);
    let mean = 0;
    for (let i = 0; i < len; i++) {
      const v = dec === 2
        ? 0.5 * (samples[start + (i << 1)] + samples[start + (i << 1) + 1])
        : samples[start + i];
      const safe = Number.isFinite(v) ? v : 0;
      buf[i] = safe;
      mean += safe;
    }
    mean /= len;

    let sq = 0;
    for (let i = 0; i < len; i++) {
      buf[i] -= mean;
      sq += buf[i] * buf[i];
    }
    if (Math.sqrt(sq / len) < 1e-5) continue;

    const t0Dec = sr / f0;
    const lagT0 = Math.round(t0Dec);
    const lag2T0 = Math.round(2 * t0Dec);
    const lagHalfT0 = Math.round(0.5 * t0Dec);

    const rT0 = maxAutocorrAround(buf, len, lagT0, 2);
    const r2T0 = lag2T0 < len - 4 ? maxAutocorrAround(buf, len, lag2T0, 3) : 0;
    const rHalfT0 = lagHalfT0 >= 4 ? maxAutocorrAround(buf, len, lagHalfT0, 2) : 0;

    const win = hannWindow(len);

    // Case 1: F0 tracked true f0; look for subharmonics at (k + 0.5) * f0 vs integer k * f0
    let eInt = 0;
    let eHalfExcess = 0;
    for (let k = 1; k <= 5; k++) {
      const fh = k * f0;
      if (fh < sr * 0.45) eInt += tonePower(buf, len, win, fh, sr);
      const fSub = (k - 0.5) * f0;
      if (fSub >= 25 && fSub < sr * 0.45) {
        const pSub = tonePower(buf, len, win, fSub, sr);
        const pFloor = tonePower(buf, len, win, (k - 0.25) * f0, sr);
        eHalfExcess += Math.max(0, pSub - pFloor);
      }
    }
    const acSub1 = r2T0 > 0.25 ? Math.max(0, r2T0 - rT0) : 0;
    const specSub1 = eInt + eHalfExcess > 1e-12
      ? (eHalfExcess / (eInt + eHalfExcess)) * Math.max(0, Math.min(1, r2T0))
      : 0;
    const sub1 = 0.5 * Math.min(1, acSub1 * 2.0) + 0.5 * specSub1;

    // Case 2: Strong period-doubling caused F0 tracker to lock onto f0_true / 2
    // Then odd harmonics of tracked f0 (1,3,5*f0) are the subharmonics and even (2,4,6*f0) are the main harmonics.
    let sub2 = 0;
    if (lagHalfT0 >= 4 && rHalfT0 >= 0.35 && rT0 > rHalfT0 + 0.03) {
      let eOdd = 0;
      let eEven = 0;
      for (let m = 1; m <= 3; m++) {
        const fOdd = (2 * m - 1) * f0;
        const fEven = 2 * m * f0;
        if (fOdd < sr * 0.45) eOdd += tonePower(buf, len, win, fOdd, sr);
        if (fEven < sr * 0.45) eEven += tonePower(buf, len, win, fEven, sr);
      }
      if (eEven > eOdd * 1.05 && eEven + eOdd > 1e-12) {
        const acSub2 = Math.max(0, rT0 - rHalfT0);
        const specSub2 = eOdd / (eEven + eOdd);
        sub2 = 0.5 * Math.min(1, acSub2 * 1.8) + 0.5 * specSub2;
      }
    }

    subSum += Math.max(0, Math.min(1, Math.max(sub1, sub2)));
    validCount++;
  }

  if (validCount === 0) return 0;
  return Math.max(0, Math.min(1, subSum / validCount));
}

/**
 * Pearson correlation coefficient between two numeric arrays.
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} ys
 * @returns {number}
 */
export function pearson(xs, ys) {
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0);
  if (n < 3) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx;
    const ay = ys[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  const den = Math.sqrt(dx * dy);
  return den > 1e-9 ? Math.max(-1, Math.min(1, num / den)) : 0;
}

/**
 * Percentile of a numeric array (p in [0, 1]).
 * @param {ArrayLike<number>} arr
 * @param {number} p
 * @returns {number}
 */
export function percentile(arr, p) {
  const n = arr?.length ?? 0;
  if (n === 0) return 0;
  const sorted = Array.from(arr, (v) => (Number.isFinite(v) ? v : 0)).sort((a, b) => a - b);
  const cp = Math.max(0, Math.min(1, p));
  const idx = cp * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Median of a numeric array.
 * @param {ArrayLike<number>} arr
 * @returns {number}
 */
export function median(arr) {
  return percentile(arr, 0.5);
}

/**
 * Normalized Bicoherence (3rd-order cumulant / quadratic phase coupling across
 * fundamental harmonic triplets (h1, h2, h1+h2)).
 * Measures whether harmonics share genuine nonlinear physical phase coupling
 * (organic vocal-fold/string vibration) vs decoupled noise or rigid zero-phase lock.
 *
 * Reference: Kim & Powers (1979), "Digital Bispectral Analysis and Its Applications
 * to Nonlinear Wave Interactions", IEEE Trans. Plasma Sci. 7(2), 120–131.
 *
 * @param {Float32Array|ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {Array<object>} frames
 * @param {number} hopSec
 * @returns {{ bicoherenceMean: number, bicoherenceStd: number, usedFrames: number }}
 */
export function computeBicoherence(samples, sampleRate, frames, hopSec) {
  const n = samples?.length ?? 0;
  if (n < 1024 || sampleRate < 8000 || !Array.isArray(frames) || frames.length < 4) {
    return { bicoherenceMean: 0, bicoherenceStd: 0, usedFrames: 0 };
  }
  const voicedIdx = [];
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    if (fr && fr.voiced && fr.f0 >= 65 && fr.f0 <= 700 && fr.rms >= 0.025) {
      voicedIdx.push(i);
    }
  }
  if (voicedIdx.length < 4) {
    return { bicoherenceMean: 0, bicoherenceStd: 0, usedFrames: voicedIdx.length };
  }

  // Subsample up to 36 voiced frames evenly for speed (~1.5 ms)
  const maxFrames = 36;
  const stride = Math.max(1, Math.floor(voicedIdx.length / maxFrames));
  const picked = [];
  for (let i = 0; i < voicedIdx.length && picked.length < maxFrames; i += stride) {
    picked.push(voicedIdx[i]);
  }

  const N = 1024;
  const half = N >> 1;
  const win = hannWindow(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  // 5 core harmonic triplets: (1,1->2), (1,2->3), (1,3->4), (2,2->4), (2,3->5)
  const triplets = [
    [1, 1, 2],
    [1, 2, 3],
    [1, 3, 4],
    [2, 2, 4],
    [2, 3, 5],
  ];
  const numRe = new Float64Array(triplets.length);
  const numIm = new Float64Array(triplets.length);
  const den12 = new Float64Array(triplets.length);
  const den3 = new Float64Array(triplets.length);
  const counts = new Int32Array(triplets.length);

  for (const fi of picked) {
    const fr = frames[fi];
    const center = Math.round((fr.timeSec ?? fi * hopSec) * sampleRate);
    const start = center - (N >> 1);
    if (start < 0 || start + N > n) continue;
    for (let i = 0; i < N; i++) {
      re[i] = samples[start + i] * win[i];
      im[i] = 0;
    }
    fftRadix2(re, im);

    const f0Bin = (fr.f0 * N) / sampleRate;
    for (let ti = 0; ti < triplets.length; ti++) {
      const [h1, h2, h3] = triplets[ti];
      const b1 = Math.round(h1 * f0Bin);
      const b2 = Math.round(h2 * f0Bin);
      const b3 = Math.round(h3 * f0Bin);
      if (b1 < 1 || b2 < 1 || b3 >= half - 1) continue;

      // Local peak-bin snap (+-1 bin) to handle slight F0 pitch-bin offset
      const snap = (b) => {
        let best = b;
        let bestM = re[b] * re[b] + im[b] * im[b];
        for (const d of [-1, 1]) {
          const k = b + d;
          if (k >= 1 && k < half) {
            const m = re[k] * re[k] + im[k] * im[k];
            if (m > bestM) {
              bestM = m;
              best = k;
            }
          }
        }
        return best;
      };
      const k1 = snap(b1);
      const k2 = snap(b2);
      const k3 = snap(b3);

      const x1r = re[k1], x1i = im[k1];
      const x2r = re[k2], x2i = im[k2];
      const x3r = re[k3], x3i = im[k3];
      // p12 = X(k1) * X(k2)
      const p12r = x1r * x2r - x1i * x2i;
      const p12i = x1r * x2i + x1i * x2r;
      // bispec = p12 * conj(X(k3))
      const br = p12r * x3r + p12i * x3i;
      const bi = p12i * x3r - p12r * x3i;
      numRe[ti] += br;
      numIm[ti] += bi;
      den12[ti] += p12r * p12r + p12i * p12i;
      den3[ti] += x3r * x3r + x3i * x3i;
      counts[ti]++;
    }
  }

  const b2Vals = [];
  for (let ti = 0; ti < triplets.length; ti++) {
    if (counts[ti] >= 4 && den12[ti] > 1e-18 && den3[ti] > 1e-18) {
      const magSq = numRe[ti] * numRe[ti] + numIm[ti] * numIm[ti];
      const b2 = Math.max(0, Math.min(1, magSq / (den12[ti] * den3[ti])));
      b2Vals.push(b2);
    }
  }
  if (b2Vals.length === 0) {
    return { bicoherenceMean: 0, bicoherenceStd: 0, usedFrames: picked.length };
  }
  const mean = b2Vals.reduce((a, b) => a + b, 0) / b2Vals.length;
  const variance = b2Vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / b2Vals.length;
  return {
    bicoherenceMean: mean,
    bicoherenceStd: Math.sqrt(variance),
    usedFrames: picked.length,
  };
}

/**
 * 2nd-order Wavelet-Scattering-inspired Modulation Texture (Mallat 2012) computed
 * directly on the already-extracted 48-band Mel spectrogram (zero extra audio FFT).
 * Separates sub-band envelopes (mid vocal core vs high air/silk band) into smooth
 * 4–16 Hz modulation vs grainy 20–45 Hz modulation, plus mid-high co-modulation.
 *
 * @param {Array<Float32Array>} dbMat - Mel spectrogram dB matrix (frames x 48)
 * @param {Array<object>} frames
 * @param {number} hopSec
 * @returns {{ scatteringSilkRatio: number, scatteringCoMod: number }}
 */
export function computeScatteringTexture(dbMat, frames, hopSec) {
  if (!Array.isArray(dbMat) || dbMat.length < 16 || !Array.isArray(frames) || hopSec <= 0) {
    return { scatteringSilkRatio: 0, scatteringCoMod: 0 };
  }
  const F = dbMat.length;
  const nBands = dbMat[0]?.length ?? 0;
  if (nBands < 44) return { scatteringSilkRatio: 0, scatteringCoMod: 0 };

  const midEnv = new Float64Array(F);
  const hiEnv = new Float64Array(F);
  let midMean = 0;
  let hiMean = 0;
  for (let i = 0; i < F; i++) {
    const row = dbMat[i];
    let m = 0;
    for (let b = 10; b <= 24; b++) m += Math.pow(10, row[b] / 20);
    m /= 15;
    let h = 0;
    for (let b = 28; b <= 43; b++) h += Math.pow(10, row[b] / 20);
    h /= 16;
    midEnv[i] = m;
    hiEnv[i] = h;
    midMean += m;
    hiMean += h;
  }
  midMean /= F;
  hiMean /= F;
  if (midMean < 1e-6 || hiMean < 1e-6) {
    return { scatteringSilkRatio: 0, scatteringCoMod: 0 };
  }

  // Zero-mean normalized envelopes -> radix-2 modulation FFT
  let M = 1;
  while (M < F) M <<= 1;
  if (M < 32) M = 32;
  const mRe = new Float64Array(M);
  const mIm = new Float64Array(M);
  const hRe = new Float64Array(M);
  const hIm = new Float64Array(M);
  for (let i = 0; i < F; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (F - 1));
    mRe[i] = ((midEnv[i] - midMean) / midMean) * w;
    hRe[i] = ((hiEnv[i] - hiMean) / hiMean) * w;
  }
  fftRadix2(mRe, mIm);
  fftRadix2(hRe, hIm);

  const fsMod = 1 / hopSec; // ~100 Hz
  const binHz = fsMod / M;
  const half = M >> 1;

  let hiSmooth = 0; // 4..16 Hz
  let hiGrain = 0;  // 20..45 Hz
  let coNum = 0;
  let coDenM = 0;
  let coDenH = 0;

  for (let k = 1; k < half; k++) {
    const hz = k * binHz;
    const mp = mRe[k] * mRe[k] + mIm[k] * mIm[k];
    const hp = hRe[k] * hRe[k] + hIm[k] * hIm[k];
    if (hz >= 4 && hz <= 16) {
      hiSmooth += hp;
      coNum += Math.sqrt(mp * hp);
      coDenM += mp;
      coDenH += hp;
    } else if (hz >= 20 && hz <= Math.min(45, fsMod * 0.48)) {
      hiGrain += hp;
    }
  }

  const scatteringSilkRatio = hiSmooth + hiGrain > 1e-12 ? hiSmooth / (hiSmooth + hiGrain) : 0;
  const scatteringCoMod =
    coDenM > 1e-12 && coDenH > 1e-12
      ? Math.max(0, Math.min(1, coNum / Math.sqrt(coDenM * coDenH)))
      : 0;

  return { scatteringSilkRatio, scatteringCoMod };
}

/**
 * Normalized Bandt-Pompe (2002) Permutation Entropy of order m=3 (6 ordinal patterns).
 * Returns value in [0, 1]: 0 = strictly monotonic/periodic, 1 = white-noise chaos,
 * ~0.65–0.85 = organic "edge-of-chaos" expressive contour.
 *
 * Reference: Bandt, C. & Pompe, B. (2002). "Permutation Entropy: A Natural Complexity
 * Measure for Time Series." Physical Review Letters, 88(17), 174102.
 *
 * @param {ArrayLike<number>} seq
 * @returns {number} Normalized permutation entropy in [0, 1]
 */
export function computePermutationEntropy(seq) {
  const n = seq?.length ?? 0;
  if (n < 6) return 0;
  const counts = new Int32Array(6);
  let total = 0;
  for (let i = 0; i + 2 < n; i++) {
    const a = seq[i];
    const b = seq[i + 1];
    const c = seq[i + 2];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;
    let code = 0;
    if (a <= b) {
      if (b <= c) code = 0;      // a <= b <= c
      else if (a <= c) code = 1; // a <= c < b
      else code = 2;             // c < a <= b
    } else {
      if (a <= c) code = 3;      // b < a <= c
      else if (b <= c) code = 4; // b <= c < a
      else code = 5;             // c < b < a
    }
    counts[code]++;
    total++;
  }
  if (total < 4) return 0;
  let H = 0;
  for (let k = 0; k < 6; k++) {
    if (counts[k] > 0) {
      const p = counts[k] / total;
      H -= p * Math.log(p);
    }
  }
  return Math.max(0, Math.min(1, H / Math.log(6)));
}

