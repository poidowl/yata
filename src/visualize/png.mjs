// Pure-JS 6-panel raster PNG audio vision & A/B diff renderer.
// Uses Canvas + Magma/signed-diff colormaps + 5x7 ASCII bitmap font from png_encoder.mjs.
// Zero external dependencies. Pure ES Module.

import {
  Canvas,
  clamp,
  finite,
  magmaColor,
  normalizeProfile,
  normalizeReport,
  signedDiffColor,
} from "./png_encoder.mjs";

const C_BG = [250, 248, 245, 255];
const C_HEADER = [243, 239, 232, 255];
const C_PANEL = [255, 255, 255, 255];
const C_PLOT_BG = [252, 251, 249, 255];
const C_BORDER = [215, 209, 198, 255];
const C_GRID = [232, 227, 218, 255];
const C_TEXT = [31, 41, 55, 255];
const C_MUTED = [107, 114, 128, 255];
const C_BLUE = [37, 99, 235, 255];
const C_BLUE_FILL = [147, 197, 253, 130];
const C_RED = [220, 38, 38, 255];
const C_RED_SOFT = [252, 165, 165, 95];
const C_GREEN = [22, 163, 74, 255];
const C_AMBER = [217, 119, 6, 255];
const C_PURPLE = [124, 58, 237, 255];
const C_TEAL = [15, 118, 110, 255];
const C_SLATE = [100, 116, 139, 255];
const C_TAIL = [219, 234, 254, 150];
const C_YELLOW = [250, 204, 21, 255];
const C_BAR_BG = [241, 245, 249, 255];

function asciiSafe(str) {
  return String(str ?? "").replace(/[^\x20-\x7e]/g, "?");
}

function truncate(str, maxLen) {
  const s = asciiSafe(str);
  return s.length <= maxLen ? s : `${s.slice(0, Math.max(1, maxLen - 3))}...`;
}

function fmtFreq(hz) {
  const f = finite(hz, 0);
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k`;
  return `${Math.round(f)}`;
}

function drawPanelFrame(canvas, x, y, w, h, title, subtitle = "") {
  canvas.fillRect(x, y, w, h, C_PANEL);
  canvas.strokeRect(x, y, w, h, C_BORDER, 1);
  canvas.drawText(x + 8, y + 8, truncate(title, 36), C_TEXT, 1, "left");
  if (subtitle) {
    canvas.drawText(x + w - 8, y + 8, truncate(subtitle, 22), C_MUTED, 1, "right");
  }
}

function verdictColors(verdict) {
  if (verdict === "SURVIVED_KAWAII_CANDIDATE") {
    return { bg: [220, 252, 231, 255], fg: [22, 101, 52, 255], border: [134, 239, 172, 255] };
  }
  if (verdict === "REJECTED_UNKAWAII") {
    return { bg: [254, 226, 226, 255], fg: [153, 27, 27, 255], border: [252, 165, 165, 255] };
  }
  return { bg: [229, 231, 235, 255], fg: [55, 65, 81, 255], border: [209, 213, 219, 255] };
}

export function renderPngVision(profile, report = null, opts = {}) {
  const prof = normalizeProfile(profile);
  const rep = normalizeReport(report);

  const W = clamp(Math.floor(finite(opts.width, 960)), 480, 1920);
  const H = clamp(Math.floor(finite(opts.height, 640)), 360, 1280);
  const canvas = new Canvas(W, H, C_BG);

  const pad = 12;
  const headerH = 44;
  const colW = Math.floor((W - pad * 3) / 2);
  const rowH = Math.floor((H - headerH - pad * 4) / 3);
  const dur = Math.max(0.001, prof.durationSec);
  const frames = prof.frames;

  // Header bar
  canvas.fillRect(0, 0, W, headerH, C_HEADER);
  canvas.drawLine(0, headerH, W, headerH, C_BORDER, 1);
  canvas.drawText(pad, 9, `YATA AUDIO VISION - ${truncate(rep.label, 38)}`, C_TEXT, 1, "left");
  canvas.drawText(
    pad,
    24,
    `dur=${prof.durationSec.toFixed(2)}s sr=${prof.sampleRate}Hz frames=${frames.length} trig=${rep.triggeredCount}/${rep.totalFalsifiers}`,
    C_MUTED,
    1,
    "left"
  );

  const vc = verdictColors(rep.verdict);
  const badgeW = 210;
  const badgeX = W - badgeW - pad;
  canvas.fillRect(badgeX, 10, badgeW, 24, vc.bg);
  canvas.strokeRect(badgeX, 10, badgeW, 24, vc.border, 1);
  canvas.drawText(badgeX + badgeW / 2, 19, truncate(rep.verdict, 26), vc.fg, 1, "center");

  const px0 = pad;
  const px1 = pad * 2 + colW;
  const py0 = headerH + pad;
  const py1 = py0 + rowH + pad;
  const py2 = py1 + rowH + pad;

  // -------------------------------------------------------------------------
  // Panel 1: Waveform & RMS Envelope
  // -------------------------------------------------------------------------
  drawPanelFrame(canvas, px0, py0, colW, rowH, "1. Waveform & Envelope", `0..${prof.durationSec.toFixed(2)}s`);
  {
    const gx = px0 + 36;
    const gy = py0 + 22;
    const gw = colW - 46;
    const gh = rowH - 38;
    const midY = gy + Math.floor(gh / 2);
    canvas.fillRect(gx, gy, gw, gh, C_PLOT_BG);
    canvas.strokeRect(gx, gy, gw, gh, C_GRID, 1);
    canvas.drawLine(gx, midY, gx + gw, midY, C_GRID, 1);

    const tw = prof.markers.tailWindow;
    if (tw.endSec > tw.startSec) {
      const tx0 = gx + clamp(tw.startSec / dur, 0, 1) * gw;
      const tx1 = gx + clamp(tw.endSec / dur, 0, 1) * gw;
      canvas.fillRect(tx0, gy, Math.max(2, tx1 - tx0), gh, C_TAIL);
    }

    for (const hs of prof.markers.hotspots.slice(0, 3)) {
      const hx0 = gx + clamp(hs.startSec / dur, 0, 1) * gw;
      const hx1 = gx + clamp(hs.endSec / dur, 0, 1) * gw;
      canvas.fillRect(hx0, gy, Math.max(2, hx1 - hx0), gh, C_RED_SOFT);
    }

    const rmsPts = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const x = gx + clamp(f.timeSec / dur, 0, 1) * gw;
      const yTop = midY - clamp(f.peakPos, -1, 1) * (gh * 0.46);
      const yBot = midY - clamp(f.peakNeg, -1, 1) * (gh * 0.46);
      canvas.drawLine(x, yTop, x, yBot, C_BLUE_FILL, 1);
      rmsPts.push([x, gy + gh - clamp(f.rms, 0, 1) * gh]);
    }
    canvas.drawPolyline(rmsPts, C_BLUE, 2);

    for (const t of prof.markers.onsets.slice(0, 24)) {
      const x = gx + clamp(t / dur, 0, 1) * gw;
      canvas.drawLine(x, gy, x, gy + 8, C_GREEN, 1);
    }
    for (const t of prof.markers.clips.slice(0, 24)) {
      const x = gx + clamp(t / dur, 0, 1) * gw;
      canvas.drawLine(x, gy, x, gy + gh, C_RED, 1);
    }

    canvas.drawText(gx - 4, gy + 2, "+1", C_MUTED, 1, "right");
    canvas.drawText(gx - 4, midY - 3, "0", C_MUTED, 1, "right");
    canvas.drawText(gx - 4, gy + gh - 7, "-1", C_MUTED, 1, "right");
    canvas.drawText(gx, gy + gh + 4, "0.00s", C_MUTED, 1, "left");
    canvas.drawText(gx + gw, gy + gh + 4, `${prof.durationSec.toFixed(2)}s`, C_MUTED, 1, "right");
  }

  // -------------------------------------------------------------------------
  // Panel 2: Mel Spectrogram (Magma)
  // -------------------------------------------------------------------------
  drawPanelFrame(
    canvas,
    px1,
    py0,
    colW,
    rowH,
    "2. Mel Spectrogram (Magma)",
    `${Math.round(prof.spectrogram.minDb)}..${Math.round(prof.spectrogram.maxDb)}dB`
  );
  {
    const gx = px1 + 38;
    const gy = py0 + 22;
    const gw = colW - 48;
    const gh = rowH - 38;
    const { dbMatrix, minDb, dbSpan, freqsHz } = prof.spectrogram;
    const cols = dbMatrix.length;
    const rows = cols > 0 && dbMatrix[0] ? dbMatrix[0].length : 0;

    if (cols > 0 && rows > 0) {
      canvas.blitHeatmap(
        gx,
        gy,
        gw,
        gh,
        cols,
        rows,
        (c, r) => {
          const v = dbMatrix[c]?.[r];
          return clamp(((Number.isFinite(v) ? v : minDb) - minDb) / dbSpan, 0, 1);
        },
        magmaColor
      );
    } else {
      canvas.fillRect(gx, gy, gw, gh, magmaColor(0));
    }
    canvas.strokeRect(gx, gy, gw, gh, C_TEXT, 1);

    for (const hs of prof.markers.hotspots.slice(0, 3)) {
      const hx0 = gx + clamp(hs.startSec / dur, 0, 1) * gw;
      const hx1 = gx + clamp(hs.endSec / dur, 0, 1) * gw;
      canvas.strokeRect(hx0, gy, Math.max(3, hx1 - hx0), gh, C_YELLOW, 1);
    }

    const fLo = freqsHz.length ? freqsHz[0] : 60;
    const fMid = freqsHz.length ? freqsHz[Math.floor(freqsHz.length / 2)] : 1200;
    const fHi = freqsHz.length ? freqsHz[freqsHz.length - 1] : 8000;
    canvas.drawText(gx - 4, gy + 2, fmtFreq(fHi), C_MUTED, 1, "right");
    canvas.drawText(gx - 4, gy + gh / 2 - 3, fmtFreq(fMid), C_MUTED, 1, "right");
    canvas.drawText(gx - 4, gy + gh - 7, fmtFreq(fLo), C_MUTED, 1, "right");
    canvas.drawText(gx, gy + gh + 4, "0.00s", C_MUTED, 1, "left");
    canvas.drawText(gx + gw, gy + gh + 4, `${prof.durationSec.toFixed(2)}s`, C_MUTED, 1, "right");
  }

  // -------------------------------------------------------------------------
  // Panel 3: Pitch (F0 / domHz) & HNR
  // -------------------------------------------------------------------------
  drawPanelFrame(canvas, px0, py1, colW, rowH, "3. Pitch (F0/domHz) & HNR", "blue=F0 amber=HNR");
  {
    const gx = px0 + 38;
    const gy = py1 + 22;
    const gw = colW - 48;
    const gh = rowH - 38;
    canvas.fillRect(gx, gy, gw, gh, C_PLOT_BG);
    canvas.strokeRect(gx, gy, gw, gh, C_GRID, 1);

    const maxPitch = Math.max(
      600,
      ...frames.map((f) => (f.f0 > 0 ? f.f0 : f.domHz))
    );
    const f0Pts = [];
    const hnrPts = [];
    for (const f of frames) {
      const x = gx + clamp(f.timeSec / dur, 0, 1) * gw;
      const pVal = f.f0 > 0 ? f.f0 : f.domHz;
      if (pVal > 0) {
        f0Pts.push([x, gy + gh - clamp(pVal / maxPitch, 0, 1) * gh]);
      } else {
        f0Pts.push(null);
      }
      hnrPts.push([x, gy + gh - clamp((f.hnrDb + 10) / 45, 0, 1) * gh]);
    }
    canvas.drawPolyline(hnrPts, C_AMBER, 1);
    canvas.drawPolyline(f0Pts, C_BLUE, 2);

    canvas.drawText(gx - 4, gy + 2, `${Math.round(maxPitch)}`, C_MUTED, 1, "right");
    canvas.drawText(gx - 4, gy + gh - 7, "0Hz", C_MUTED, 1, "right");
    canvas.drawText(gx, gy + gh + 4, "0.00s", C_MUTED, 1, "left");
    canvas.drawText(gx + gw, gy + gh + 4, `${prof.durationSec.toFixed(2)}s`, C_MUTED, 1, "right");
  }

  // -------------------------------------------------------------------------
  // Panel 4: Spectral Slice (Mean & Peak dB)
  // -------------------------------------------------------------------------
  drawPanelFrame(canvas, px1, py1, colW, rowH, "4. Spectral Slice (Mean/Peak)", "log-Hz");
  {
    const gx = px1 + 38;
    const gy = py1 + 22;
    const gw = colW - 48;
    const gh = rowH - 38;
    canvas.fillRect(gx, gy, gw, gh, C_PLOT_BG);
    canvas.strokeRect(gx, gy, gw, gh, C_GRID, 1);

    const { freqsHz, meanDb, peakDb, peaks } = prof.spectralSlice;
    const fMin = Math.max(20, freqsHz[0] ?? 20);
    const fMax = Math.max(fMin + 10, freqsHz[freqsHz.length - 1] ?? 12000);
    const logMin = Math.log10(fMin);
    const logSpan = Math.max(0.1, Math.log10(fMax) - logMin);
    const xOfHz = (hz) => gx + clamp((Math.log10(Math.max(fMin, hz)) - logMin) / logSpan, 0, 1) * gw;
    const yOfDb = (db) => gy + gh - clamp((db + 100) / 100, 0, 1) * gh;

    if (freqsHz.length > 1) {
      const peakPts = freqsHz.map((hz, i) => [xOfHz(hz), yOfDb(peakDb[i] ?? -100)]);
      const meanPts = freqsHz.map((hz, i) => [xOfHz(hz), yOfDb(meanDb[i] ?? -100)]);
      canvas.drawPolyline(peakPts, C_SLATE, 1);
      canvas.drawPolyline(meanPts, C_PURPLE, 2);
    }

    for (const pk of peaks.slice(0, 3)) {
      const cx = xOfHz(pk.hz);
      const cy = yOfDb(pk.db);
      canvas.drawCircle(cx, cy, 3, C_RED, true);
      canvas.drawText(cx + 4, Math.max(gy + 2, cy - 8), fmtFreq(pk.hz), C_RED, 1, "left");
    }

    canvas.drawText(gx - 4, gy + 2, "0dB", C_MUTED, 1, "right");
    canvas.drawText(gx - 4, gy + gh - 7, "-100", C_MUTED, 1, "right");
    canvas.drawText(gx, gy + gh + 4, `${fmtFreq(fMin)}Hz`, C_MUTED, 1, "left");
    canvas.drawText(gx + gw, gy + gh + 4, `${fmtFreq(fMax)}Hz`, C_MUTED, 1, "right");
  }

  // -------------------------------------------------------------------------
  // Panel 5: Phase-Space Loop (Tension vs Breath)
  // -------------------------------------------------------------------------
  drawPanelFrame(canvas, px0, py2, colW, rowH, "5. Phase-Space Loop (T vs B)", "grn=start red=tail");
  {
    const gx = px0 + 38;
    const gy = py2 + 22;
    const gw = colW - 48;
    const gh = rowH - 38;
    canvas.fillRect(gx, gy, gw, gh, C_PLOT_BG);
    canvas.strokeRect(gx, gy, gw, gh, C_GRID, 1);
    canvas.drawLine(gx, gy + gh, gx + gw, gy, C_GRID, 1);

    const loop = prof.phaseLoop;
    if (loop.length > 0) {
      const pts = loop.map((p) => [
        gx + clamp(p.tension, 0, 1) * gw,
        gy + gh - clamp(p.breath, 0, 1) * gh,
      ]);
      canvas.drawPolyline(pts, C_TEAL, 2);

      const tw = prof.markers.tailWindow;
      if (tw.endSec > tw.startSec) {
        const tailPts = loop
          .filter((p) => p.t >= tw.startSec && p.t <= tw.endSec)
          .map((p) => [
            gx + clamp(p.tension, 0, 1) * gw,
            gy + gh - clamp(p.breath, 0, 1) * gh,
          ]);
        if (tailPts.length > 1) canvas.drawPolyline(tailPts, C_RED, 2);
      }

      canvas.drawCircle(pts[0][0], pts[0][1], 3.5, C_GREEN, true);
      canvas.drawCircle(pts[pts.length - 1][0], pts[pts.length - 1][1], 3.5, C_RED, true);
    }

    canvas.drawText(gx - 4, gy + 2, "B=1", C_MUTED, 1, "right");
    canvas.drawText(gx - 4, gy + gh - 7, "0", C_MUTED, 1, "right");
    canvas.drawText(gx, gy + gh + 4, "T=0", C_MUTED, 1, "left");
    canvas.drawText(gx + gw, gy + gh + 4, "T=1", C_MUTED, 1, "right");
  }

  // -------------------------------------------------------------------------
  // Panel 6: Falsifier Scoreboard
  // -------------------------------------------------------------------------
  drawPanelFrame(
    canvas,
    px1,
    py2,
    colW,
    rowH,
    "6. Falsifier Scoreboard",
    `${rep.triggeredCount}/${rep.totalFalsifiers} trig`
  );
  {
    const gx = px1 + 8;
    const gy = py2 + 24;
    const labelW = 140;
    const barX = gx + labelW;
    const barW = Math.max(40, colW - labelW - 54);
    const ranked = [...rep.falsifiers]
      .sort((a, b) => Number(b.triggered) - Number(a.triggered) || b.score - a.score)
      .slice(0, 8);

    if (ranked.length === 0) {
      canvas.drawText(gx + 6, gy + 16, "No falsifier report provided.", C_MUTED, 1, "left");
    } else {
      const step = Math.max(12, Math.floor((rowH - 32) / ranked.length));
      const barH = Math.max(7, Math.min(11, step - 4));
      ranked.forEach((f, i) => {
        const y = gy + i * step;
        canvas.drawText(gx, y + 1, truncate(f.id, 22), f.triggered ? C_RED : C_TEXT, 1, "left");
        canvas.fillRect(barX, y, barW, barH, C_BAR_BG);
        canvas.fillRect(barX, y, clamp(f.score, 0, 1) * barW, barH, f.triggered ? C_RED : C_SLATE);
        const thrX = barX + clamp(f.threshold, 0, 1) * barW;
        canvas.drawLine(thrX, y - 1, thrX, y + barH + 1, C_TEXT, 1);
        canvas.drawText(barX + barW + 5, y + 1, f.score.toFixed(2), C_TEXT, 1, "left");
      });
    }
  }

  return canvas.toPngBuffer();
}

export function renderPngDiff(profileA, profileB, reportA = null, reportB = null, opts = {}) {
  const profA = normalizeProfile(profileA);
  const profB = normalizeProfile(profileB);
  const repA = normalizeReport(reportA);
  const repB = normalizeReport(reportB);

  const W = clamp(Math.floor(finite(opts.width, 960)), 480, 1920);
  const H = clamp(Math.floor(finite(opts.height, 640)), 360, 1280);
  const canvas = new Canvas(W, H, C_BG);

  const pad = 12;
  const headerH = 44;
  const colW = Math.floor((W - pad * 3) / 2);
  const rowH = Math.floor((H - headerH - pad * 4) / 3);
  const durMax = Math.max(0.001, profA.durationSec, profB.durationSec);

  // Header
  canvas.fillRect(0, 0, W, headerH, C_HEADER);
  canvas.drawLine(0, headerH, W, headerH, C_BORDER, 1);
  canvas.drawText(
    pad,
    8,
    `YATA A/B DIFF - A:${truncate(repA.label, 22)} vs B:${truncate(repB.label, 22)}`,
    C_TEXT,
    1,
    "left"
  );
  canvas.drawText(
    pad,
    24,
    `A(blue): ${truncate(repA.verdict, 24)} (${repA.triggeredCount}/${repA.totalFalsifiers})`,
    C_BLUE,
    1,
    "left"
  );
  canvas.drawText(
    Math.floor(W / 2),
    24,
    `B(red): ${truncate(repB.verdict, 24)} (${repB.triggeredCount}/${repB.totalFalsifiers})`,
    C_RED,
    1,
    "left"
  );

  const px0 = pad;
  const px1 = pad * 2 + colW;
  const py0 = headerH + pad;
  const py1 = py0 + rowH + pad;
  const py2 = py1 + rowH + pad;

  // Panel 1: Envelope Overlay
  drawPanelFrame(canvas, px0, py0, colW, rowH, "1. RMS Envelope Overlay", "blue=A red=B");
  {
    const gx = px0 + 36;
    const gy = py0 + 22;
    const gw = colW - 46;
    const gh = rowH - 38;
    canvas.fillRect(gx, gy, gw, gh, C_PLOT_BG);
    canvas.strokeRect(gx, gy, gw, gh, C_GRID, 1);
    const drawEnv = (prof, color) => {
      const pts = prof.frames.map((f) => [
        gx + clamp(f.timeSec / durMax, 0, 1) * gw,
        gy + gh - clamp(f.rms, 0, 1) * gh,
      ]);
      canvas.drawPolyline(pts, color, 2);
    };
    drawEnv(profA, C_BLUE);
    drawEnv(profB, C_RED);
    canvas.drawText(gx, gy + gh + 4, "0.00s", C_MUTED, 1, "left");
    canvas.drawText(gx + gw, gy + gh + 4, `${durMax.toFixed(2)}s`, C_MUTED, 1, "right");
  }

  // Panel 2: Signed Spectrogram Delta
  drawPanelFrame(canvas, px1, py0, colW, rowH, "2. Mel Spectrogram Delta (B-A)", "blue=A>B red=B>A");
  {
    const gx = px1 + 38;
    const gy = py0 + 22;
    const gw = colW - 48;
    const gh = rowH - 38;
    const mA = profA.spectrogram.dbMatrix;
    const mB = profB.spectrogram.dbMatrix;
    const colsA = mA.length;
    const colsB = mB.length;
    const rowsA = colsA > 0 && mA[0] ? mA[0].length : 0;
    const rowsB = colsB > 0 && mB[0] ? mB[0].length : 0;
    const cols = Math.max(colsA, colsB, 1);
    const rows = Math.max(rowsA, rowsB, 1);

    const sampleDb = (mat, cLen, rLen, minDb, c, r) => {
      if (cLen <= 0 || rLen <= 0) return minDb;
      const ci = Math.min(cLen - 1, Math.floor((c * cLen) / cols));
      const ri = Math.min(rLen - 1, Math.floor((r * rLen) / rows));
      const v = mat[ci]?.[ri];
      return Number.isFinite(v) ? v : minDb;
    };

    canvas.blitHeatmap(
      gx,
      gy,
      gw,
      gh,
      cols,
      rows,
      (c, r) => {
        const a = sampleDb(mA, colsA, rowsA, profA.spectrogram.minDb, c, r);
        const b = sampleDb(mB, colsB, rowsB, profB.spectrogram.minDb, c, r);
        return clamp((b - a) / 24, -1, 1);
      },
      signedDiffColor
    );
    canvas.strokeRect(gx, gy, gw, gh, C_TEXT, 1);
    canvas.drawText(gx, gy + gh + 4, "0.00s", C_MUTED, 1, "left");
    canvas.drawText(gx + gw, gy + gh + 4, `${durMax.toFixed(2)}s`, C_MUTED, 1, "right");
  }

  // Panel 3: Pitch Contour Overlay
  drawPanelFrame(canvas, px0, py1, colW, rowH, "3. Pitch Contour Overlay", "blue=A red=B");
  {
    const gx = px0 + 38;
    const gy = py1 + 22;
    const gw = colW - 48;
    const gh = rowH - 38;
    canvas.fillRect(gx, gy, gw, gh, C_PLOT_BG);
    canvas.strokeRect(gx, gy, gw, gh, C_GRID, 1);
    const maxPitch = Math.max(
      600,
      ...profA.frames.map((f) => (f.f0 > 0 ? f.f0 : f.domHz)),
      ...profB.frames.map((f) => (f.f0 > 0 ? f.f0 : f.domHz))
    );
    const drawPitch = (prof, color) => {
      const pts = prof.frames.map((f) => {
        const p = f.f0 > 0 ? f.f0 : f.domHz;
        return p > 0
          ? [gx + clamp(f.timeSec / durMax, 0, 1) * gw, gy + gh - clamp(p / maxPitch, 0, 1) * gh]
          : null;
      });
      canvas.drawPolyline(pts, color, 2);
    };
    drawPitch(profA, C_BLUE);
    drawPitch(profB, C_RED);
    canvas.drawText(gx - 4, gy + 2, `${Math.round(maxPitch)}`, C_MUTED, 1, "right");
    canvas.drawText(gx - 4, gy + gh - 7, "0Hz", C_MUTED, 1, "right");
  }

  // Panel 4: Spectral Slice Overlay
  drawPanelFrame(canvas, px1, py1, colW, rowH, "4. Mean Spectral Slice Overlay", "blue=A red=B");
  {
    const gx = px1 + 38;
    const gy = py1 + 22;
    const gw = colW - 48;
    const gh = rowH - 38;
    canvas.fillRect(gx, gy, gw, gh, C_PLOT_BG);
    canvas.strokeRect(gx, gy, gw, gh, C_GRID, 1);
    const drawSlice = (prof, color) => {
      const { freqsHz, meanDb } = prof.spectralSlice;
      if (freqsHz.length < 2) return;
      const fMin = Math.max(20, freqsHz[0]);
      const fMax = Math.max(fMin + 10, freqsHz[freqsHz.length - 1]);
      const logMin = Math.log10(fMin);
      const logSpan = Math.max(0.1, Math.log10(fMax) - logMin);
      const pts = freqsHz.map((hz, i) => [
        gx + clamp((Math.log10(Math.max(fMin, hz)) - logMin) / logSpan, 0, 1) * gw,
        gy + gh - clamp(((meanDb[i] ?? -100) + 100) / 100, 0, 1) * gh,
      ]);
      canvas.drawPolyline(pts, color, 2);
    };
    drawSlice(profA, C_BLUE);
    drawSlice(profB, C_RED);
    canvas.drawText(gx - 4, gy + 2, "0dB", C_MUTED, 1, "right");
    canvas.drawText(gx - 4, gy + gh - 7, "-100", C_MUTED, 1, "right");
  }

  // Panel 5: Phase-Space Overlay
  drawPanelFrame(canvas, px0, py2, colW, rowH, "5. Phase-Space Loop Overlay", "blue=A red=B");
  {
    const gx = px0 + 38;
    const gy = py2 + 22;
    const gw = colW - 48;
    const gh = rowH - 38;
    canvas.fillRect(gx, gy, gw, gh, C_PLOT_BG);
    canvas.strokeRect(gx, gy, gw, gh, C_GRID, 1);
    const drawLoop = (prof, color) => {
      const pts = prof.phaseLoop.map((p) => [
        gx + clamp(p.tension, 0, 1) * gw,
        gy + gh - clamp(p.breath, 0, 1) * gh,
      ]);
      canvas.drawPolyline(pts, color, 2);
    };
    drawLoop(profA, C_BLUE);
    drawLoop(profB, C_RED);
  }

  // Panel 6: Falsifier Score Diff
  drawPanelFrame(canvas, px1, py2, colW, rowH, "6. Falsifier Score Diff (A vs B)", "top 8 deltas");
  {
    const gx = px1 + 8;
    const gy = py2 + 24;
    const labelW = 140;
    const barX = gx + labelW;
    const barW = Math.max(40, colW - labelW - 58);

    const mapA = new Map(repA.falsifiers.map((f) => [f.id, f]));
    const mapB = new Map(repB.falsifiers.map((f) => [f.id, f]));
    const ids = [...new Set([...mapA.keys(), ...mapB.keys()])];
    const rows = ids
      .map((id) => {
        const a = mapA.get(id);
        const b = mapB.get(id);
        const sA = a?.score ?? 0;
        const sB = b?.score ?? 0;
        return { id, sA, sB, delta: sB - sA, anyTrig: Boolean(a?.triggered || b?.triggered) };
      })
      .sort((x, y) => Number(y.anyTrig) - Number(x.anyTrig) || Math.abs(y.delta) - Math.abs(x.delta))
      .slice(0, 8);

    if (rows.length === 0) {
      canvas.drawText(gx + 6, gy + 16, "No falsifiers to compare.", C_MUTED, 1, "left");
    } else {
      const step = Math.max(12, Math.floor((rowH - 32) / rows.length));
      rows.forEach((r, i) => {
        const y = gy + i * step;
        canvas.drawText(gx, y + 1, truncate(r.id, 22), C_TEXT, 1, "left");
        canvas.fillRect(barX, y, barW, 4, C_BAR_BG);
        canvas.fillRect(barX, y, clamp(r.sA, 0, 1) * barW, 4, C_BLUE);
        canvas.fillRect(barX, y + 5, barW, 4, C_BAR_BG);
        canvas.fillRect(barX, y + 5, clamp(r.sB, 0, 1) * barW, 4, C_RED);
        const sign = r.delta >= 0 ? "+" : "";
        canvas.drawText(barX + barW + 5, y + 1, `${sign}${r.delta.toFixed(2)}`, C_TEXT, 1, "left");
      });
    }
  }

  return canvas.toPngBuffer();
}
