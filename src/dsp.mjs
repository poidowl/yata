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
 * @param {number} [fMin=60]
 * @param {number} [fMax=8000]
 * @returns {{
 *   bands: Array<{ startBin: number, endBin: number, weights: Float32Array, centerHz: number }>,
 *   centerFreqsHz: number[],
 *   melBands: number,
 *   fftSize: number,
 *   sampleRate: number
 * }}
 */
export function computeMelFilterbank(fftSize, sampleRate, melBands = 48, fMin = 60, fMax = 8000) {
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
 * Estimate fundamental frequency F0 via FFT-accelerated exact normalized autocorrelation
 * with octave-halving guard and parabolic peak interpolation.
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
  let n = rawN;
  if (sampleRate >= 32000 && fMax <= 1500 && rawN >= 64) {
    const decN = rawN >> 1;
    const dec = new Float32Array(decN);
    for (let i = 0; i < decN; i++) {
      dec[i] = 0.5 * (frame[i << 1] + frame[(i << 1) + 1]);
    }
    sig = dec;
    sr = sampleRate * 0.5;
    n = decN;
  }

  const minLag = Math.max(2, Math.floor(sr / fMax));
  const maxLag = Math.min(n - 3, Math.ceil(sr / fMin));
  if (maxLag <= minLag + 1) {
    return { f0: 0, periodicity: 0, hnrDb: 0 };
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
    return { f0: 0, periodicity: 0, hnrDb: 0 };
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
    return { f0: 0, periodicity: Math.max(0, globalMax), hnrDb: -20 };
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

  return { f0, periodicity, hnrDb };
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
