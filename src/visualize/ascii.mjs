// Token-efficient progressive text audio vision & A/B diff renderer for LLMs.
// Zero external dependencies. Pure ES Module.

import { clamp, finite, normalizeProfile, normalizeReport } from "./png_encoder.mjs";

const SPARK_ASCII = [" ", ".", ":", "-", "=", "+", "*", "#"];
const SPARK_UNICODE = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

const HEAT_ASCII = [" ", ".", ":", "-", "=", "+", "*", "#", "%", "@"];
const HEAT_UNICODE = [" ", "░", "▒", "▓", "█"];

const DIFF_ASCII = ["=", "-", ":", ".", "+", "*", "#"];
const DIFF_UNICODE = ["▼", "▽", "▫", "·", "▪", "△", "▲"];

const BAND_DEFS = [
  { name: "Sub", lo: 20, hi: 90 },
  { name: "Low", lo: 90, hi: 250 },
  { name: "Box", lo: 250, hi: 650 },
  { name: "Mid", lo: 650, hi: 1600 },
  { name: "HiM", lo: 1600, hi: 3200 },
  { name: "Prs", lo: 3200, hi: 5500 },
  { name: "Sib", lo: 5500, hi: 8500 },
  { name: "Air", lo: 8500, hi: 12000 },
];

function fmtNum(v, digits = 2) {
  return finite(v, 0).toFixed(digits);
}

function fmtFreq(hz) {
  const f = finite(hz, 0);
  if (f >= 1000) {
    const k = f / 1000;
    return k >= 10 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
  }
  return `${Math.round(f)}`;
}

function truncate(str, maxLen) {
  const s = String(str ?? "");
  if (s.length <= maxLen) return s;
  if (maxLen <= 3) return s.slice(0, maxLen);
  return `${s.slice(0, maxLen - 3)}...`;
}

function pickGlyph(ramp, norm01) {
  const v = clamp(norm01, 0, 1);
  const idx = Math.min(ramp.length - 1, Math.floor(v * ramp.length));
  return ramp[idx];
}

function pickSignedGlyph(ramp, signedVal) {
  const v = clamp(signedVal, -1, 1);
  const u = (v + 1) * 0.5;
  const idx = Math.min(ramp.length - 1, Math.floor(u * ramp.length));
  return ramp[idx];
}

function medianOf(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function parseZoomString(str, durationSec) {
  const s = String(str).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s)?\s*(?:\.\.|[-–—]|to)\s*(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
  if (!m) return null;
  let a = Number.parseFloat(m[1]);
  let b = Number.parseFloat(m[3]);
  if (m[2] && m[2].toLowerCase() === "ms") a /= 1000;
  if (m[4] && m[4].toLowerCase() === "ms") b /= 1000;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a > b) [a, b] = [b, a];
  const dur = Math.max(0.001, durationSec);
  const startSec = clamp(a, 0, dur);
  const endSec = clamp(b, startSec, dur);
  return { startSec, endSec, reason: "manual", active: true };
}

function resolveZoomWindow(prof, rep, zoom) {
  const dur = Math.max(0, prof.durationSec);
  const full = { startSec: 0, endSec: dur, reason: "full", active: false };
  if (!zoom || dur <= 0) return full;

  if (typeof zoom === "object" && zoom !== null) {
    const s = finite(zoom.startSec, 0);
    const e = finite(zoom.endSec, dur);
    const lo = clamp(Math.min(s, e), 0, dur);
    const hi = clamp(Math.max(s, e), lo, dur);
    if (hi - lo < 1e-4) return full;
    return { startSec: lo, endSec: hi, reason: zoom.reason || "manual", active: true };
  }

  if (typeof zoom === "string" && zoom.toLowerCase() !== "auto") {
    const parsed = parseZoomString(zoom, dur);
    if (parsed && parsed.endSec - parsed.startSec >= 1e-4) return parsed;
    return full;
  }

  // zoom === "auto"
  const halfWin = clamp(dur * 0.18, 0.06, 0.22);
  const makeWin = (center, reason) => {
    const c = clamp(center, 0, dur);
    let lo = Math.max(0, c - halfWin);
    let hi = Math.min(dur, c + halfWin);
    if (hi - lo < 0.04 && dur >= 0.04) {
      if (lo === 0) hi = Math.min(dur, 0.04);
      else lo = Math.max(0, dur - 0.04);
    }
    return { startSec: lo, endSec: hi, reason, active: true };
  };

  // 1. Triggered falsifier with localized `where`
  for (const f of rep.triggered) {
    if (f.where && Number.isFinite(f.where.startSec)) {
      const ws = f.where.startSec;
      const we = Number.isFinite(f.where.endSec) ? f.where.endSec : ws;
      const span = Math.abs(we - ws);
      if (span < dur * 0.65) {
        return makeWin(0.5 * (ws + we), f.id);
      }
    }
  }

  // 2. Localized click or internal shock feature from report
  if (rep.features && typeof rep.features === "object") {
    if (
      Number.isFinite(rep.features.clickTimeSec) &&
      rep.features.clickTimeSec > 0 &&
      (finite(rep.features.maxClickJump, 0) > 0.15 ||
        rep.triggered.some((f) => f.id.startsWith("F9_") || f.id.startsWith("F6_")))
    ) {
      return makeWin(rep.features.clickTimeSec, "click");
    }
    if (
      Number.isFinite(rep.features.internalShockTimeSec) &&
      rep.features.internalShockTimeSec > 0 &&
      rep.triggered.some((f) => f.id.startsWith("F26_"))
    ) {
      return makeWin(rep.features.internalShockTimeSec, "internal_shock");
    }
  }

  // 3. Localized frame spike detector (catches localized clicks/glitches even without report)
  const frames = prof.frames;
  let bestFrameScore = 0;
  let bestFrameTime = dur * 0.5;
  let bestFrameReason = "peak_anomaly";
  if (frames.length >= 4) {
    const peaks = frames.map((f) => Math.max(Math.abs(f.peakPos), Math.abs(f.peakNeg)));
    const hfs = frames.map((f) => f.hfRatio);
    const fluxes = frames.map((f) => f.spectralFlux);
    const medPeak = Math.max(0.05, medianOf(peaks));
    const medHf = Math.max(0.01, medianOf(hfs));
    const medFlux = Math.max(0.01, medianOf(fluxes));

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const peakExcess = Math.max(0, peaks[i] - medPeak * 1.45) / medPeak;
      const hfExcess = Math.max(0, f.hfRatio - medHf * 2.2) / Math.max(0.05, medHf);
      const fluxExcess = Math.max(0, f.spectralFlux - medFlux * 2.5) / Math.max(0.05, medFlux);
      const curvTerm = f.envelopeCurvature * 2.5;
      const clipTerm = f.clipped ? 2.0 : 0;
      const score = peakExcess * 2.2 + hfExcess * 1.0 + fluxExcess * 0.8 + curvTerm + clipTerm;
      if (score > bestFrameScore) {
        bestFrameScore = score;
        bestFrameTime = f.timeSec;
        bestFrameReason = f.clipped
          ? "clip"
          : peakExcess > 0.6
          ? "transient_spike"
          : curvTerm > 0.6
          ? "curvature_spike"
          : "spectral_spike";
      }
    }
  }

  // 4. Profile hotspots (prefer localized hotspots)
  const localizedHotspot = prof.markers.hotspots.find((h) => h.endSec - h.startSec < dur * 0.65);
  if (bestFrameScore >= 1.2) {
    return makeWin(bestFrameTime, bestFrameReason);
  }
  if (localizedHotspot) {
    return makeWin(0.5 * (localizedHotspot.startSec + localizedHotspot.endSec), localizedHotspot.reason);
  }
  if (prof.markers.hotspots.length > 0) {
    const h = prof.markers.hotspots[0];
    return makeWin(0.5 * (h.startSec + h.endSec), h.reason);
  }
  if (frames.length > 0) {
    // Fallback: center on highest RMS frame
    let maxIdx = 0;
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].rms > frames[maxIdx].rms) maxIdx = i;
    }
    return makeWin(frames[maxIdx].timeSec, "peak_energy");
  }
  return full;
}

function sliceFrames(frames, win) {
  if (!frames.length) return [];
  if (!win.active) return frames;
  const sub = frames.filter((f) => f.timeSec >= win.startSec - 1e-6 && f.timeSec <= win.endSec + 1e-6);
  return sub.length > 0 ? sub : frames;
}

function renderSparkline(values, width, lo, hi, ramp) {
  const w = Math.max(1, width);
  if (!values.length) return ramp[0].repeat(w);
  const span = hi - lo > 1e-9 ? hi - lo : 1;
  let out = "";
  for (let col = 0; col < w; col++) {
    const i0 = Math.floor((col * values.length) / w);
    const i1 = Math.max(i0 + 1, Math.floor(((col + 1) * values.length) / w));
    let peak = values[Math.min(values.length - 1, i0)];
    for (let i = i0 + 1; i < Math.min(values.length, i1); i++) {
      if (values[i] > peak) peak = values[i];
    }
    out += pickGlyph(ramp, (peak - lo) / span);
  }
  return out;
}

function renderMarkerTrack(prof, win, width, unicode) {
  const w = Math.max(1, width);
  const chars = new Array(w).fill(unicode ? "·" : ".");
  const span = Math.max(1e-6, win.endSec - win.startSec);
  const colOf = (t) => {
    if (t < win.startSec || t > win.endSec) return -1;
    return clamp(Math.floor(((t - win.startSec) / span) * w), 0, w - 1);
  };

  // Tail window shading
  const tw = prof.markers.tailWindow;
  if (tw && tw.endSec > tw.startSec) {
    const c0 = clamp(Math.floor(((Math.max(tw.startSec, win.startSec) - win.startSec) / span) * w), 0, w - 1);
    const c1 = clamp(Math.floor(((Math.min(tw.endSec, win.endSec) - win.startSec) / span) * w), 0, w - 1);
    if (tw.endSec >= win.startSec && tw.startSec <= win.endSec) {
      for (let c = c0; c <= c1; c++) chars[c] = unicode ? "─" : "-";
    }
  }

  for (const t of prof.markers.valleys) {
    const c = colOf(t);
    if (c >= 0) chars[c] = "v";
  }
  for (const t of prof.markers.onsets) {
    const c = colOf(t);
    if (c >= 0) chars[c] = unicode ? "▲" : "^";
  }
  for (const t of prof.markers.curvatureSpikes) {
    const c = colOf(t);
    if (c >= 0) chars[c] = "*";
  }
  for (const t of prof.markers.clips) {
    const c = colOf(t);
    if (c >= 0) chars[c] = "!";
  }
  return chars.join("");
}

function resampleSpectrogramGrid(prof, win, width, rows) {
  const { times, freqsHz, dbMatrix, minDb, maxDb, dbSpan } = prof.spectrogram;
  const grid = Array.from({ length: rows }, () => new Float32Array(width));
  const rowFreqs = new Array(rows).fill(0);

  const melCount = freqsHz.length || (dbMatrix[0] ? dbMatrix[0].length : 0);
  if (!dbMatrix.length || melCount === 0) {
    for (let r = 0; r < rows; r++) {
      const frac = rows > 1 ? 1 - r / (rows - 1) : 0.5;
      rowFreqs[r] = 60 * Math.pow(8000 / 60, frac);
      grid[r].fill(minDb);
    }
    return { grid, rowFreqs, minDb, maxDb, dbSpan };
  }

  // Indices of frames inside window
  let tStart = 0;
  let tEnd = dbMatrix.length - 1;
  if (win.active && times.length === dbMatrix.length) {
    tStart = times.findIndex((t) => t >= win.startSec - 1e-6);
    if (tStart < 0) tStart = 0;
    for (let i = times.length - 1; i >= tStart; i--) {
      if (times[i] <= win.endSec + 1e-6) {
        tEnd = i;
        break;
      }
    }
    if (tEnd < tStart) tEnd = tStart;
  }
  const tCount = Math.max(1, tEnd - tStart + 1);

  const fLo = Math.max(30, Math.min(60, freqsHz[0] > 0 ? freqsHz[0] : 60));
  const fHi = Math.max(fLo * 2, freqsHz[melCount - 1] > 0 ? freqsHz[melCount - 1] : 8000);

  for (let r = 0; r < rows; r++) {
    // r=0 is highest frequency, r=rows-1 is lowest (~60-120 Hz for 8 rows)
    const bandLo = fLo * Math.pow(fHi / fLo, (rows - 1 - r) / rows);
    const bandHi = fLo * Math.pow(fHi / fLo, (rows - r) / rows);

    let mLo = -1;
    let mHi = -1;
    if (freqsHz.length === melCount) {
      for (let mi = 0; mi < melCount; mi++) {
        const hz = freqsHz[mi];
        const inLo = r === rows - 1 ? true : hz >= bandLo;
        const inHi = r === 0 ? true : hz < bandHi;
        if (inLo && inHi) {
          if (mLo < 0) mLo = mi;
          mHi = mi;
        }
      }
      if (mLo < 0) {
        // Fallback: pick nearest mel bin to geometric band center
        const targetHz = Math.sqrt(bandLo * bandHi);
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let mi = 0; mi < melCount; mi++) {
          const d = Math.abs(freqsHz[mi] - targetHz);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = mi;
          }
        }
        mLo = bestIdx;
        mHi = bestIdx;
      }
    } else {
      mHi = Math.max(0, Math.min(melCount - 1, Math.floor(((rows - r) * melCount) / rows) - 1));
      mLo = Math.max(0, Math.min(mHi, Math.floor(((rows - 1 - r) * melCount) / rows)));
    }

    const mMid = Math.floor(0.5 * (mLo + mHi));
    rowFreqs[r] = freqsHz[mMid] ?? Math.sqrt(bandLo * bandHi);

    for (let c = 0; c < width; c++) {
      const i0 = tStart + Math.floor((c * tCount) / width);
      const i1 = Math.min(tEnd + 1, Math.max(i0 + 1, tStart + Math.floor(((c + 1) * tCount) / width)));
      let sum = 0;
      let cnt = 0;
      for (let ti = i0; ti < i1; ti++) {
        const colArr = dbMatrix[ti];
        if (!colArr) continue;
        for (let mi = mLo; mi <= mHi; mi++) {
          const v = colArr[mi];
          if (Number.isFinite(v)) {
            sum += v;
            cnt++;
          }
        }
      }
      grid[r][c] = cnt > 0 ? sum / cnt : minDb;
    }
  }
  return { grid, rowFreqs, minDb, maxDb, dbSpan };
}

function compute8BandBalance(prof) {
  const { freqsHz, meanDb } = prof.spectralSlice;
  const bandDbs = BAND_DEFS.map((b) => {
    let sumPow = 0;
    let cnt = 0;
    for (let i = 0; i < freqsHz.length; i++) {
      if (freqsHz[i] >= b.lo && freqsHz[i] <= b.hi) {
        sumPow += Math.pow(10, clamp(meanDb[i], -100, 0) / 10);
        cnt++;
      }
    }
    const db = cnt > 0 ? 10 * Math.log10(Math.max(sumPow / cnt, 1e-10)) : -100;
    return { name: b.name, lo: b.lo, hi: b.hi, db, pow: cnt > 0 ? sumPow : 0 };
  });
  const totalPow = bandDbs.reduce((s, b) => s + b.pow, 0);
  return bandDbs.map((b) => ({
    ...b,
    pct: totalPow > 1e-12 ? Math.round((b.pow / totalPow) * 100) : 0,
  }));
}

function computeSummaryStats(prof, rep) {
  const frames = prof.frames;
  let peak = finite(rep.features?.peak, 0);
  let maxRms = 0;
  const voicedF0s = [];
  const hnrs = [];
  let hfSum = 0;
  for (const f of frames) {
    const p = Math.max(Math.abs(f.peakPos), Math.abs(f.peakNeg));
    if (p > peak) peak = p;
    if (f.rms > maxRms) maxRms = f.rms;
    if (f.voiced && f.f0 > 0) voicedF0s.push(f.f0);
    if (f.voiced) hnrs.push(f.hnrDb);
    hfSum += f.hfRatio;
  }
  const rmsDb = maxRms > 1e-6 ? 20 * Math.log10(maxRms) : -100;
  const medF0 = finite(rep.features?.medianF0, voicedF0s.length ? medianOf(voicedF0s) : 0);
  const meanHnr = finite(
    rep.features?.meanVoicedHnrDb,
    hnrs.length ? hnrs.reduce((a, b) => a + b, 0) / hnrs.length : 0
  );
  const meanHf = finite(rep.features?.meanHfRatio, frames.length ? hfSum / frames.length : 0);
  const mpsRough = finite(rep.features?.mpsRoughness30_150, 0);
  const subh = finite(rep.features?.subharmonicRatio, 0);
  const respiratoryScore = clamp(finite(rep.features?.respiratoryScore, 0), 0, 1);
  const directnessScore = clamp(finite(rep.features?.directnessScore, 0), 0, 1);
  const sanitizationScore = clamp(finite(rep.features?.sanitizationScore, 0), 0, 1);
  const voiceCompassLabel =
    respiratoryScore >= 0.5 && directnessScore >= 0.5
      ? "addressed_breath"
      : respiratoryScore >= 0.5
        ? "distant_or_private_breath"
        : directnessScore >= 0.5
          ? "non_breath_signal"
          : "ambient_or_hollow";
  return {
    peak,
    rmsDb,
    medF0,
    meanHnr,
    meanHf,
    mpsRough,
    subh,
    respiratoryScore,
    directnessScore,
    sanitizationScore,
    voiceCompassLabel,
  };
}

function formatWhere(where) {
  if (!where) return "";
  const parts = [];
  if (Number.isFinite(where.startSec)) {
    if (Number.isFinite(where.endSec) && Math.abs(where.endSec - where.startSec) > 0.005) {
      parts.push(`${fmtNum(where.startSec, 2)}..${fmtNum(where.endSec, 2)}s`);
    } else {
      parts.push(`${fmtNum(where.startSec, 2)}s`);
    }
  }
  if (Number.isFinite(where.freqHz) && where.freqHz > 0) {
    parts.push(`${fmtFreq(where.freqHz)}Hz`);
  }
  return parts.length ? `@${parts.join("/")}` : "";
}

function renderTimeRuler(win, width, prefix) {
  const left = `${fmtNum(win.startSec, 2)}s`;
  const mid = `${fmtNum(0.5 * (win.startSec + win.endSec), 2)}s`;
  const right = `${fmtNum(win.endSec, 2)}s`;
  if (width < left.length + right.length + 2) {
    return `${prefix}${left}..${right}`;
  }
  const buf = new Array(width).fill(" ");
  for (let i = 0; i < left.length && i < width; i++) buf[i] = left[i];
  const rStart = Math.max(left.length + 1, width - right.length);
  for (let i = 0; i < right.length && rStart + i < width; i++) buf[rStart + i] = right[i];
  const mStart = Math.floor((width - mid.length) / 2);
  if (mStart > left.length && mStart + mid.length < rStart) {
    for (let i = 0; i < mid.length; i++) buf[mStart + i] = mid[i];
  }
  return `${prefix}${buf.join("")}`;
}

export function renderTextVision(profile, report = null, opts = {}) {
  const prof = normalizeProfile(profile);
  const rep = normalizeReport(report);

  const mode = opts.mode === "micro" || opts.mode === "full" ? opts.mode : "compact";
  const width = clamp(Math.floor(finite(opts.width, 48)), 16, 120);
  const unicode = opts.charset === "unicode";
  const sparkRamp = unicode ? SPARK_UNICODE : SPARK_ASCII;
  const heatRamp = unicode ? HEAT_UNICODE : HEAT_ASCII;
  const defaultSpecRows = mode === "micro" ? 4 : mode === "full" ? 12 : 8;
  const maxSpecRows = mode === "micro" ? 4 : mode === "compact" ? 8 : 20;
  const specRows = clamp(Math.floor(finite(opts.specRows, defaultSpecRows)), 2, maxSpecRows);

  const win = resolveZoomWindow(prof, rep, opts.zoom ?? null);
  const frames = sliceFrames(prof.frames, win);
  const stats = computeSummaryStats(prof, rep);
  const bands = compute8BandBalance(prof);
  const spec = resampleSpectrogramGrid(prof, win, width, specRows);

  const rmsVals = frames.map((f) => f.rms);
  const maxRms = Math.max(0.01, ...rmsVals);
  const pitchVals = frames.map((f) => (f.f0 > 0 ? f.f0 : f.domHz));
  const maxPitch = Math.max(400, ...pitchVals);
  const hfVals = frames.map((f) => f.hfRatio);

  const envLine = renderSparkline(rmsVals, width, 0, maxRms, sparkRamp);
  const f0Line = renderSparkline(pitchVals, width, 0, maxPitch, sparkRamp);
  const hfLine = renderSparkline(hfVals, width, 0, 1, sparkRamp);
  const vSep = unicode ? "│" : "|";

  // -------------------------------------------------------------------------
  // MICRO MODE (strictly <= 15 lines)
  // -------------------------------------------------------------------------
  if (mode === "micro") {
    const lines = [];
    const zoomTag = win.active
      ? ` ZOOM ${fmtNum(win.startSec, 2)}..${fmtNum(win.endSec, 2)}s(${win.reason})`
      : "";
    lines.push(
      `YATA [${rep.label}] ${rep.verdict} (${rep.triggeredCount}/${rep.totalFalsifiers}) ${fmtNum(prof.durationSec, 2)}s ${prof.sampleRate}Hz pk=${fmtNum(stats.peak, 2)} F0=${Math.round(stats.medF0)}Hz MPS30-150=${fmtNum(stats.mpsRough, 2)} SUBH=${fmtNum(stats.subh, 2)}${zoomTag}`
    );
    lines.push(`ENV ${vSep}${envLine}${vSep}`);
    lines.push(`F0  ${vSep}${f0Line}${vSep}`);
    lines.push(`HF  ${vSep}${hfLine}${vSep}`);
    for (let r = 0; r < specRows; r++) {
      const fLbl = fmtFreq(spec.rowFreqs[r]).padStart(4);
      let rowStr = "";
      for (let c = 0; c < width; c++) {
        rowStr += pickGlyph(heatRamp, (spec.grid[r][c] - spec.minDb) / spec.dbSpan);
      }
      lines.push(`${fLbl}${vSep}${rowStr}${vSep}`);
    }
    lines.push(renderTimeRuler(win, width, "     "));
    const bandInline = bands.map((b) => `${b.name}:${b.pct}%`).join(" ");
    lines.push(`BAND ${bandInline}`);

    if (rep.triggered.length === 0) {
      lines.push(`OK: 0/${rep.totalFalsifiers} triggered (${rep.verdict})`);
    } else {
      const showCount = Math.min(3, rep.triggered.length);
      for (let i = 0; i < showCount; i++) {
        const f = rep.triggered[i];
        const w = formatWhere(f.where);
        lines.push(
          `[!] ${f.id} ${fmtNum(f.score, 2)} ${w ? `${w} ` : ""}${truncate(f.evidence, 42)}`.trim()
        );
      }
      if (rep.triggered.length > showCount) {
        lines.push(`... +${rep.triggered.length - showCount} more triggered`);
      }
    }
    return lines.slice(0, 15).join("\n");
  }

  // -------------------------------------------------------------------------
  // COMPACT MODE (default, strictly <= 32 lines)
  // -------------------------------------------------------------------------
  if (mode === "compact") {
    const lines = [];
    const compassTag = `RESP=${fmtNum(stats.respiratoryScore, 2)} DIR=${fmtNum(stats.directnessScore, 2)} [${stats.voiceCompassLabel}] SAN=${fmtNum(stats.sanitizationScore, 2)}`;
    lines.push(`=== YATA VISION [${rep.label}] ===`);
    lines.push(
      `VERDICT: ${rep.verdict} (${rep.triggeredCount}/${rep.totalFalsifiers}) | dur=${fmtNum(prof.durationSec, 2)}s sr=${prof.sampleRate}Hz | pk=${fmtNum(stats.peak, 2)} rms=${fmtNum(stats.rmsDb, 1)}dB F0=${Math.round(stats.medF0)}Hz HNR=${fmtNum(stats.meanHnr, 1)}dB MPS30-150=${fmtNum(stats.mpsRough, 2)} SUBH=${fmtNum(stats.subh, 2)}`
    );
    lines.push(
      win.active
        ? `ZOOM: ${fmtNum(win.startSec, 2)}s..${fmtNum(win.endSec, 2)}s (reason=${win.reason}) | ${compassTag}`
        : `WINDOW: 0.00s..${fmtNum(prof.durationSec, 2)}s (full) | onsets=${prof.markers.onsets.length} clips=${prof.markers.clips.length} tail=${fmtNum(prof.markers.tailWindow.startSec, 2)}..${fmtNum(prof.markers.tailWindow.endSec, 2)}s | ${compassTag}`
    );
    lines.push(`ENV  ${vSep}${envLine}${vSep}`);
    lines.push(`F0   ${vSep}${f0Line}${vSep}`);
    lines.push(`HF   ${vSep}${hfLine}${vSep}`);
    lines.push(`MARK ${vSep}${renderMarkerTrack(prof, win, width, unicode)}${vSep}`);
    lines.push(`MEL (${specRows}x${width}, ${Math.round(spec.minDb)}..${Math.round(spec.maxDb)}dB):`);
    for (let r = 0; r < specRows; r++) {
      const fLbl = fmtFreq(spec.rowFreqs[r]).padStart(4);
      let rowStr = "";
      for (let c = 0; c < width; c++) {
        rowStr += pickGlyph(heatRamp, (spec.grid[r][c] - spec.minDb) / spec.dbSpan);
      }
      lines.push(`${fLbl} ${vSep}${rowStr}${vSep}`);
    }
    lines.push(renderTimeRuler(win, width, "      "));
    lines.push(`BANDS: ${bands.map((b) => `${b.name}:${b.pct}%`).join(" ")}`);

    if (prof.markers.hotspots.length > 0) {
      const hs = prof.markers.hotspots
        .slice(0, 3)
        .map((h) => `${h.reason}@${fmtNum(h.startSec, 2)}..${fmtNum(h.endSec, 2)}s(${fmtNum(h.severity, 2)})`)
        .join(", ");
      lines.push(`HOTSPOTS: ${hs}`);
    }

    // Budget remaining lines for falsifiers (max 32 total)
    const remaining = Math.max(1, 32 - lines.length);
    if (rep.triggered.length === 0) {
      lines.push(`FALSIFIERS: [OK] 0/${rep.totalFalsifiers} triggered`);
      const runners = [...rep.falsifiers]
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(2, remaining - 1));
      for (const f of runners) {
        lines.push(`  (~) ${f.id} score=${fmtNum(f.score, 2)}/${fmtNum(f.threshold, 2)} ${truncate(f.evidence, 44)}`);
      }
    } else {
      lines.push(`FALSIFIERS (${rep.triggeredCount} triggered):`);
      const maxShown = Math.max(1, remaining - 2);
      const shown = rep.triggered.slice(0, maxShown);
      for (const f of shown) {
        const w = formatWhere(f.where);
        lines.push(
          `  [!] ${f.id} ${fmtNum(f.score, 2)}/${fmtNum(f.threshold, 2)} ${w ? `${w} ` : ""}| ${truncate(f.evidence, 46)}`
        );
      }
      if (rep.triggered.length > shown.length) {
        lines.push(`  ... +${rep.triggered.length - shown.length} more triggered`);
      }
    }

    return lines.slice(0, 32).join("\n");
  }

  // -------------------------------------------------------------------------
  // FULL MODE (comprehensive diagnostic)
  // -------------------------------------------------------------------------
  const lines = [];
  const hnrVals = frames.map((f) => f.hnrDb);
  const fluxVals = frames.map((f) => f.spectralFlux);
  const curvVals = frames.map((f) => f.envelopeCurvature);

  lines.push(`=== YATA FULL AUDIO VISION [${rep.label}] ===`);
  lines.push(
    `VERDICT: ${rep.verdict} (${rep.triggeredCount}/${rep.totalFalsifiers}) | dur=${fmtNum(prof.durationSec, 3)}s | sr=${prof.sampleRate}Hz | frames=${prof.frames.length}`
  );
  lines.push(
    `STATS: peak=${fmtNum(stats.peak, 3)} | rms=${fmtNum(stats.rmsDb, 1)}dB | F0=${Math.round(stats.medF0)}Hz | HNR=${fmtNum(stats.meanHnr, 1)}dB | meanHF=${fmtNum(stats.meanHf, 3)} | MPS30-150=${fmtNum(stats.mpsRough, 3)} | SUBH=${fmtNum(stats.subh, 3)}`
  );
  lines.push(
    `VOICE COMPASS: RESP=${fmtNum(stats.respiratoryScore, 2)} DIR=${fmtNum(stats.directnessScore, 2)} [${stats.voiceCompassLabel}] | SAN=${fmtNum(stats.sanitizationScore, 2)}`
  );
  lines.push(
    win.active
      ? `ZOOM: ${fmtNum(win.startSec, 3)}s..${fmtNum(win.endSec, 3)}s (reason=${win.reason})`
      : `WINDOW: 0.000s..${fmtNum(prof.durationSec, 3)}s (full)`
  );
  lines.push(`ENV  ${vSep}${envLine}${vSep}`);
  lines.push(`F0   ${vSep}${f0Line}${vSep}`);
  lines.push(`HF   ${vSep}${hfLine}${vSep}`);
  lines.push(`HNR  ${vSep}${renderSparkline(hnrVals, width, -10, 35, sparkRamp)}${vSep}`);
  lines.push(`FLUX ${vSep}${renderSparkline(fluxVals, width, 0, 1, sparkRamp)}${vSep}`);
  lines.push(`CURV ${vSep}${renderSparkline(curvVals, width, 0, 0.5, sparkRamp)}${vSep}`);
  lines.push(`MARK ${vSep}${renderMarkerTrack(prof, win, width, unicode)}${vSep} (^onset *curv !clip vval -tail)`);
  lines.push(`MEL SPECTROGRAM (${specRows}x${width}, ${fmtNum(spec.minDb, 1)}..${fmtNum(spec.maxDb, 1)}dB):`);
  for (let r = 0; r < specRows; r++) {
    const fLbl = fmtFreq(spec.rowFreqs[r]).padStart(4);
    let rowStr = "";
    for (let c = 0; c < width; c++) {
      rowStr += pickGlyph(heatRamp, (spec.grid[r][c] - spec.minDb) / spec.dbSpan);
    }
    lines.push(`${fLbl} ${vSep}${rowStr}${vSep}`);
  }
  lines.push(renderTimeRuler(win, width, "      "));

  lines.push("8-BAND SPECTRAL BALANCE:");
  for (const b of bands) {
    const barLen = clamp(Math.round((b.pct / 100) * 24), 0, 24);
    const bar = (unicode ? "█" : "#").repeat(barLen).padEnd(24, unicode ? "░" : ".");
    lines.push(
      `  ${b.name.padEnd(3)} (${String(b.lo).padStart(4)}-${String(b.hi).padEnd(5)}Hz) ${vSep}${bar}${vSep} ${String(b.pct).padStart(3)}% (${fmtNum(b.db, 1)}dB)`
    );
  }

  if (prof.spectralSlice.peaks.length > 0) {
    const pkStr = prof.spectralSlice.peaks
      .slice(0, 6)
      .map((p) => `${fmtFreq(p.hz)}Hz(${fmtNum(p.db, 1)}dB)`)
      .join(", ");
    lines.push(`TOP PEAKS: ${pkStr}`);
  }

  if (prof.phaseLoop.length > 0) {
    const tensions = prof.phaseLoop.map((p) => p.tension);
    const breaths = prof.phaseLoop.map((p) => p.breath);
    const meanT = tensions.reduce((a, b) => a + b, 0) / tensions.length;
    const meanB = breaths.reduce((a, b) => a + b, 0) / breaths.length;
    lines.push(
      `PHASE LOOP: tension=${fmtNum(meanT, 2)} (max ${fmtNum(Math.max(...tensions), 2)}) | breath=${fmtNum(meanB, 2)} (max ${fmtNum(Math.max(...breaths), 2)}) | tail=${fmtNum(prof.markers.tailWindow.startSec, 2)}..${fmtNum(prof.markers.tailWindow.endSec, 2)}s`
    );
  }

  if (prof.markers.hotspots.length > 0) {
    lines.push("HOTSPOTS:");
    for (const h of prof.markers.hotspots) {
      lines.push(`  * ${h.reason} @ ${fmtNum(h.startSec, 3)}..${fmtNum(h.endSec, 3)}s (severity=${fmtNum(h.severity, 2)})`);
    }
  }

  lines.push(`FALSIFIERS (${rep.triggeredCount}/${rep.totalFalsifiers} triggered):`);
  if (rep.triggered.length === 0) {
    lines.push("  [OK] All falsifiers survived — SURVIVED_KAWAII_CANDIDATE");
  } else {
    for (const f of rep.triggered) {
      const w = formatWhere(f.where);
      lines.push(`  [!] ${f.id} [${f.domain}] score=${fmtNum(f.score, 2)} thr=${fmtNum(f.threshold, 2)} ${w}`.trim());
      if (f.evidence) lines.push(`      evidence: ${f.evidence}`);
      if (f.hint) lines.push(`      hint:     ${f.hint}`);
    }
  }

  const nearMiss = rep.falsifiers
    .filter((f) => !f.triggered)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (nearMiss.length > 0) {
    lines.push("NEAR-MISS (untriggered top 5):");
    for (const f of nearMiss) {
      lines.push(`  [ ] ${f.id} score=${fmtNum(f.score, 2)}/${fmtNum(f.threshold, 2)} | ${truncate(f.evidence, 60)}`);
    }
  }

  return lines.join("\n");
}

export function renderTextDiff(profileA, profileB, reportA = null, reportB = null, opts = {}) {
  const profA = normalizeProfile(profileA);
  const profB = normalizeProfile(profileB);
  const repA = normalizeReport(reportA);
  const repB = normalizeReport(reportB);

  const width = clamp(Math.floor(finite(opts.width, 48)), 16, 120);
  const specRows = clamp(Math.floor(finite(opts.specRows, 8)), 2, 16);
  const unicode = opts.charset === "unicode";
  const diffRamp = unicode ? DIFF_UNICODE : DIFF_ASCII;
  const vSep = unicode ? "│" : "|";

  const statsA = computeSummaryStats(profA, repA);
  const statsB = computeSummaryStats(profB, repB);

  const winA = { startSec: 0, endSec: profA.durationSec, active: false };
  const winB = { startSec: 0, endSec: profB.durationSec, active: false };
  const specA = resampleSpectrogramGrid(profA, winA, width, specRows);
  const specB = resampleSpectrogramGrid(profB, winB, width, specRows);

  const signedStr = (d, digits = 2, unit = "") => `${d >= 0 ? "+" : ""}${fmtNum(d, digits)}${unit}`;

  const lines = [];
  lines.push(`=== YATA DIFF [${repA.label}] -> [${repB.label}] ===`);
  lines.push(
    `A: ${repA.verdict} (${repA.triggeredCount}/${repA.totalFalsifiers})  vs  B: ${repB.verdict} (${repB.triggeredCount}/${repB.totalFalsifiers})  | dTrig=${repB.triggeredCount - repA.triggeredCount >= 0 ? "+" : ""}${repB.triggeredCount - repA.triggeredCount}`
  );
  lines.push(
    `DELTA (B-A): dur=${signedStr(profB.durationSec - profA.durationSec, 2, "s")} rms=${signedStr(statsB.rmsDb - statsA.rmsDb, 1, "dB")} F0=${signedStr(statsB.medF0 - statsA.medF0, 0, "Hz")} HNR=${signedStr(statsB.meanHnr - statsA.meanHnr, 1, "dB")} HF=${signedStr(statsB.meanHf - statsA.meanHf, 3)}`
  );
  lines.push(
    `MEL DIFF B-A (${specRows}x${width}, ${unicode ? "▼" : "="}A>B ${unicode ? "·" : "."}0 ${unicode ? "▲" : "#"}B>A, ±24dB):`
  );

  for (let r = 0; r < specRows; r++) {
    const fLbl = fmtFreq(specA.rowFreqs[r]).padStart(4);
    let rowStr = "";
    for (let c = 0; c < width; c++) {
      const deltaDb = specB.grid[r][c] - specA.grid[r][c];
      rowStr += pickSignedGlyph(diffRamp, deltaDb / 24);
    }
    lines.push(`${fLbl} ${vSep}${rowStr}${vSep}`);
  }

  // Falsifier comparison by ID
  const mapA = new Map(repA.falsifiers.map((f) => [f.id, f]));
  const mapB = new Map(repB.falsifiers.map((f) => [f.id, f]));
  const allIds = [...new Set([...mapA.keys(), ...mapB.keys()])];

  const added = [];
  const fixed = [];
  const both = [];
  for (const id of allIds) {
    const a = mapA.get(id);
    const b = mapB.get(id);
    const tA = Boolean(a?.triggered);
    const tB = Boolean(b?.triggered);
    if (!tA && tB) added.push({ id, a, b });
    else if (tA && !tB) fixed.push({ id, a, b });
    else if (tA && tB) both.push({ id, a, b });
  }

  if (added.length === 0 && fixed.length === 0 && both.length === 0) {
    lines.push("FALSIFIER DIFF: Both A and B have 0 triggered falsifiers.");
  } else {
    if (added.length > 0) {
      lines.push(`NEW IN B (${added.length}):`);
      for (const item of added.slice(0, 5)) {
        lines.push(
          `  + ${item.id} ${fmtNum(item.a?.score ?? 0, 2)}->${fmtNum(item.b?.score ?? 0, 2)} | ${truncate(item.b?.evidence ?? "", 44)}`
        );
      }
      if (added.length > 5) lines.push(`  ... +${added.length - 5} more`);
    }
    if (fixed.length > 0) {
      lines.push(`FIXED IN B (${fixed.length}):`);
      for (const item of fixed.slice(0, 5)) {
        lines.push(
          `  - ${item.id} ${fmtNum(item.a?.score ?? 0, 2)}->${fmtNum(item.b?.score ?? 0, 2)}`
        );
      }
      if (fixed.length > 5) lines.push(`  ... +${fixed.length - 5} more`);
    }
    if (both.length > 0) {
      lines.push(`BOTH TRIGGERED (${both.length}):`);
      for (const item of both.slice(0, 4)) {
        lines.push(
          `  = ${item.id} ${fmtNum(item.a?.score ?? 0, 2)}->${fmtNum(item.b?.score ?? 0, 2)}`
        );
      }
      if (both.length > 4) lines.push(`  ... +${both.length - 4} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Ultra-compact 3-track time-segmented mirror renderer (Presence vs MPS 30–150Hz Roughness vs F0).
 * Designed to fit in 4 lines (header + 3 tracks) for low-token LLM inspection of coexisting
 * kawaii + unkawaii segments across time.
 *
 * @param {object} timeline - Output of extractSegmentTimeline
 * @param {{ charset?: "ascii" | "unicode", width?: number }} [opts={}]
 * @returns {string}
 */
export function renderSegmentTimeline(timeline, opts = {}) {
  const segs = Array.isArray(timeline?.segments) ? timeline.segments : [];
  const dur = finite(timeline?.durationSec, 0);
  const winSec = finite(timeline?.windowSec, 0.5);
  const unicode = opts?.charset === "unicode";
  const ramp = unicode ? SPARK_UNICODE : SPARK_ASCII;
  const vSep = unicode ? "│" : "|";

  const b = timeline?.breath;
  const breathTag = b
    ? ` | duty=${Math.round(finite(b.activeDutyCycle, 0) * 100)}% pauses=${Math.round(finite(b.pauseCount, 0))} maxRun=${fmtNum(b.longestContinuousSec, 1)}s [${b.cadenceLabel || "silent"}]`
    : "";

  if (segs.length === 0) {
    return `[YATA TIMELINE] dur=${fmtNum(dur, 2)}s win=${fmtNum(winSec, 2)}s (0 segs — empty/silent)${breathTag}`;
  }

  const width = clamp(Math.floor(finite(opts?.width, Math.max(segs.length * 2, 16))), segs.length, 64);
  const presVals = segs.map((s) => finite(s.presence, 0));
  const mpsVals = segs.map((s) => finite(s.mpsRoughness30_150, 0));
  const f0Vals = segs.map((s) => finite(s.medianF0, 0));

  const maxMps = Math.max(0.25, ...mpsVals);
  const maxF0 = Math.max(400, ...f0Vals);

  const presSpark = renderSparkline(presVals, width, 0, 1, ramp);
  const mpsSpark = renderSparkline(mpsVals, width, 0, maxMps, ramp);
  const f0Spark = renderSparkline(f0Vals, width, 0, maxF0, ramp);

  const maxInline = 8;
  const shown = segs.slice(0, maxInline);
  const suffix = segs.length > maxInline ? ` +${segs.length - maxInline}` : "";
  const presSummary = shown
    .map((s) => `${fmtNum(s.startSec, 1)}s:${fmtNum(s.presence, 2)}(${Math.round(finite(s.activeRatio, 0) * 100)}%)`)
    .join(" ");
  const mpsSummary = shown.map((s) => `${fmtNum(s.startSec, 1)}s:${fmtNum(s.mpsRoughness30_150, 2)}`).join(" ");
  const f0Summary = shown.map((s) => `${Math.round(finite(s.medianF0, 0))}Hz`).join(" ");

  return [
    `[YATA TIMELINE] dur=${fmtNum(dur, 2)}s win=${fmtNum(winSec, 2)}s (${segs.length} segs)${breathTag}`,
    `PRES      ${vSep}${presSpark}${vSep} ${presSummary}${suffix}`,
    `MPS30-150 ${vSep}${mpsSpark}${vSep} ${mpsSummary}${suffix}`,
    `F0        ${vSep}${f0Spark}${vSep} ${f0Summary}${suffix}`,
  ].join("\n");
}

function renderSignedSparkline(values, width, scale, ramp) {
  const w = Math.max(1, width);
  const midChar = ramp[ramp.length >> 1];
  if (!values.length) return midChar.repeat(w);
  const s = scale > 1e-9 ? scale : 1;
  let out = "";
  for (let col = 0; col < w; col++) {
    const i0 = Math.floor((col * values.length) / w);
    const i1 = Math.max(i0 + 1, Math.floor(((col + 1) * values.length) / w));
    let peak = values[Math.min(values.length - 1, i0)];
    for (let i = i0 + 1; i < Math.min(values.length, i1); i++) {
      if (Math.abs(values[i]) > Math.abs(peak)) peak = values[i];
    }
    out += pickSignedGlyph(ramp, peak / s);
  }
  return out;
}

/**
 * Window-by-window timeline diff renderer (B - A) in 5 compact lines:
 * header (with exact hotspot window) + 4 delta tracks (dPRES, dACT%, dMPS, dF0).
 *
 * @param {object} timelineA - Baseline extractSegmentTimeline output
 * @param {object} timelineB - Comparison extractSegmentTimeline output
 * @param {{ charset?: "ascii" | "unicode", width?: number }} [opts={}]
 * @returns {string}
 */
export function renderTimelineDiff(timelineA, timelineB, opts = {}) {
  const segsA = Array.isArray(timelineA?.segments) ? timelineA.segments : [];
  const segsB = Array.isArray(timelineB?.segments) ? timelineB.segments : [];
  const count = Math.max(segsA.length, segsB.length);
  const winSec = finite(timelineB?.windowSec, finite(timelineA?.windowSec, 0.5));
  const unicode = opts?.charset === "unicode";
  const diffRamp = unicode ? DIFF_UNICODE : DIFF_ASCII;
  const vSep = unicode ? "│" : "|";

  if (count === 0) {
    return `[YATA TIMELINE DIFF] (0 segs — empty/silent)`;
  }

  const signed = (v, digits = 2, unit = "") => `${v >= 0 ? "+" : ""}${fmtNum(v, digits)}${unit}`;

  const deltas = [];
  let hotIdx = 0;
  let hotScore = -1;
  for (let i = 0; i < count; i++) {
    const a = segsA[i] || null;
    const b = segsB[i] || null;
    const startSec = finite(a?.startSec, finite(b?.startSec, i * winSec));
    const endSec = finite(b?.endSec, finite(a?.endSec, startSec + winSec));
    const dPres = finite(b?.presence, 0) - finite(a?.presence, 0);
    const dActPct = (finite(b?.activeRatio, 0) - finite(a?.activeRatio, 0)) * 100;
    const dMps = finite(b?.mpsRoughness30_150, 0) - finite(a?.mpsRoughness30_150, 0);
    const dF0 = finite(b?.medianF0, 0) - finite(a?.medianF0, 0);

    const score =
      Math.abs(dMps) * 4.0 +
      Math.abs(dPres) * 1.5 +
      (Math.abs(dActPct) / 100) * 1.0 +
      Math.min(1, Math.abs(dF0) / 100) * 0.5;
    if (score > hotScore) {
      hotScore = score;
      hotIdx = i;
    }
    deltas.push({ startSec, endSec, dPres, dActPct, dMps, dF0 });
  }

  const hot = deltas[hotIdx];
  const width = clamp(Math.floor(finite(opts?.width, Math.max(count * 2, 16))), count, 64);

  const dPresVals = deltas.map((d) => d.dPres);
  const dActVals = deltas.map((d) => d.dActPct);
  const dMpsVals = deltas.map((d) => d.dMps);
  const dF0Vals = deltas.map((d) => d.dF0);

  const presScale = Math.max(0.25, ...dPresVals.map(Math.abs));
  const mpsScale = Math.max(0.15, ...dMpsVals.map(Math.abs));
  const f0Scale = Math.max(80, ...dF0Vals.map(Math.abs));

  const presSpark = renderSignedSparkline(dPresVals, width, presScale, diffRamp);
  const actSpark = renderSignedSparkline(dActVals, width, 100, diffRamp);
  const mpsSpark = renderSignedSparkline(dMpsVals, width, mpsScale, diffRamp);
  const f0Spark = renderSignedSparkline(dF0Vals, width, f0Scale, diffRamp);

  const maxInline = 8;
  const shown = deltas.slice(0, maxInline);
  const suffix = deltas.length > maxInline ? ` +${deltas.length - maxInline}` : "";
  const presSummary = shown.map((d) => `${fmtNum(d.startSec, 1)}s:${signed(d.dPres, 2)}`).join(" ");
  const actSummary = shown.map((d) => `${fmtNum(d.startSec, 1)}s:${signed(d.dActPct, 0, "%")}`).join(" ");
  const mpsSummary = shown.map((d) => `${fmtNum(d.startSec, 1)}s:${signed(d.dMps, 2)}`).join(" ");
  const f0Summary = shown.map((d) => `${signed(d.dF0, 0, "Hz")}`).join(" ");

  const deltaLbl = unicode ? "HOTSPOT Δ" : "HOTSPOT d";
  return [
    `[YATA TIMELINE DIFF] ${count} segs (B-A) | ${deltaLbl}: ${fmtNum(hot.startSec, 1)}..${fmtNum(hot.endSec, 1)}s (dMPS=${signed(hot.dMps, 2)}, dPRES=${signed(hot.dPres, 2)}, dACT=${signed(hot.dActPct, 0, "%")})`,
    `dPRES ${vSep}${presSpark}${vSep} ${presSummary}${suffix}`,
    `dACT% ${vSep}${actSpark}${vSep} ${actSummary}${suffix}`,
    `dMPS  ${vSep}${mpsSpark}${vSep} ${mpsSummary}${suffix}`,
    `dF0   ${vSep}${f0Spark}${vSep} ${f0Summary}${suffix}`,
  ].join("\n");
}
