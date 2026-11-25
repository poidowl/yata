// Pure-JS 6-panel diagnostic vector SVG audio vision & A/B diff renderer.
// Embeds compact base64 PNG spectrograms so SVG stays < 50 KB.
// Zero external dependencies. Pure ES Module.

import {
  clamp,
  encodeHeatmapPng,
  finite,
  magmaColor,
  normalizeProfile,
  normalizeReport,
  signedDiffColor,
} from "./png_encoder.mjs";

function n1(v) {
  return finite(v, 0).toFixed(1);
}

function n2(v) {
  return finite(v, 0).toFixed(2);
}

function escXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(str, maxLen) {
  const s = String(str ?? "");
  return s.length <= maxLen ? s : `${s.slice(0, Math.max(1, maxLen - 3))}...`;
}

function fmtFreq(hz) {
  const f = finite(hz, 0);
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k`;
  return `${Math.round(f)}`;
}

function downsampleIndices(len, maxPts) {
  if (len <= 0) return [];
  if (len <= maxPts) {
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = i;
    return out;
  }
  const out = new Array(maxPts);
  for (let i = 0; i < maxPts; i++) {
    out[i] = Math.min(len - 1, Math.round((i * (len - 1)) / (maxPts - 1)));
  }
  return out;
}

function pointsAttr(pts) {
  return pts.map((p) => `${n1(p[0])},${n1(p[1])}`).join(" ");
}

function panelBox(x, y, w, h, title, subtitle = "") {
  const sub = subtitle
    ? `<text x="${n1(x + w - 8)}" y="${n1(y + 16)}" text-anchor="end" font-size="10" fill="#6b7280">${escXml(subtitle)}</text>`
    : "";
  return [
    `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="6" fill="#ffffff" stroke="#dfd9ce" stroke-width="1"/>`,
    `<text x="${n1(x + 10)}" y="${n1(y + 16)}" font-size="11" font-weight="600" fill="#1f2937">${escXml(title)}</text>`,
    sub,
  ].join("");
}

function verdictStyle(verdict) {
  if (verdict === "SURVIVED_KAWAII_CANDIDATE") {
    return { bg: "#dcfce7", fg: "#166534", stroke: "#86efac" };
  }
  if (verdict === "REJECTED_UNKAWAII") {
    return { bg: "#fee2e2", fg: "#991b1b", stroke: "#fca5a5" };
  }
  return { bg: "#e5e7eb", fg: "#374151", stroke: "#d1d5db" };
}

function buildSpectrogramDataUri(prof, outW = 128, outH = 40) {
  const { dbMatrix, minDb, dbSpan } = prof.spectrogram;
  const cols = dbMatrix.length;
  const rows = cols > 0 && dbMatrix[0] ? dbMatrix[0].length : 0;
  const buf = encodeHeatmapPng(
    cols,
    rows,
    (c, r) => {
      const col = dbMatrix[c];
      const v = col && Number.isFinite(col[r]) ? col[r] : minDb;
      return clamp((v - minDb) / dbSpan, 0, 1);
    },
    magmaColor,
    outW,
    outH
  );
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function buildDiffSpectrogramDataUri(profA, profB, outW = 128, outH = 40) {
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

  const buf = encodeHeatmapPng(
    cols,
    rows,
    (c, r) => {
      const a = sampleDb(mA, colsA, rowsA, profA.spectrogram.minDb, c, r);
      const b = sampleDb(mB, colsB, rowsB, profB.spectrogram.minDb, c, r);
      return clamp((b - a) / 24, -1, 1);
    },
    signedDiffColor,
    outW,
    outH
  );
  return `data:image/png;base64,${buf.toString("base64")}`;
}

export function renderSvgVision(profile, report = null, opts = {}) {
  const prof = normalizeProfile(profile);
  const rep = normalizeReport(report);

  const W = 960;
  const H = 640;
  const pad = 14;
  const headerH = 48;
  const colW = (W - pad * 3) / 2;
  const rowH = (H - headerH - pad * 4) / 3;
  const dur = Math.max(0.001, prof.durationSec);
  const frames = prof.frames;
  const vStyle = verdictStyle(rep.verdict);

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">`
  );
  parts.push(`<rect width="${W}" height="${H}" fill="#faf8f5"/>`);

  // Header
  parts.push(`<rect x="0" y="0" width="${W}" height="${headerH}" fill="#f3efe8"/>`);
  parts.push(`<line x1="0" y1="${headerH}" x2="${W}" y2="${headerH}" stroke="#dfd9ce" stroke-width="1"/>`);
  parts.push(
    `<text x="${pad}" y="22" font-size="14" font-weight="700" fill="#111827">YATA Audio Vision — ${escXml(truncate(rep.label, 38))}</text>`
  );
  parts.push(
    `<text x="${pad}" y="38" font-size="10" fill="#4b5563">dur=${n2(prof.durationSec)}s | sr=${prof.sampleRate}Hz | frames=${frames.length} | triggered=${rep.triggeredCount}/${rep.totalFalsifiers}</text>`
  );
  parts.push(
    `<rect x="${W - 240}" y="11" width="226" height="26" rx="13" fill="${vStyle.bg}" stroke="${vStyle.stroke}" stroke-width="1"/>`
  );
  parts.push(
    `<text x="${W - 127}" y="28" text-anchor="middle" font-size="11" font-weight="700" fill="${vStyle.fg}">${escXml(truncate(rep.verdict, 26))}</text>`
  );

  // Panel coordinates
  const px0 = pad;
  const px1 = pad * 2 + colW;
  const py0 = headerH + pad;
  const py1 = py0 + rowH + pad;
  const py2 = py1 + rowH + pad;

  // -------------------------------------------------------------------------
  // Panel 1: Waveform & RMS Envelope + Markers
  // -------------------------------------------------------------------------
  parts.push(panelBox(px0, py0, colW, rowH, "1. Waveform & Envelope", `0..${n2(prof.durationSec)}s`));
  {
    const gx = px0 + 34;
    const gy = py0 + 26;
    const gw = colW - 44;
    const gh = rowH - 44;
    const midY = gy + gh * 0.5;
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="#fcfbf9" stroke="#ece7de"/>`);
    parts.push(`<line x1="${n1(gx)}" y1="${n1(midY)}" x2="${n1(gx + gw)}" y2="${n1(midY)}" stroke="#e5e0d6" stroke-dasharray="3,3"/>`);

    // Tail window shading
    const tw = prof.markers.tailWindow;
    if (tw.endSec > tw.startSec) {
      const tx0 = gx + clamp(tw.startSec / dur, 0, 1) * gw;
      const tx1 = gx + clamp(tw.endSec / dur, 0, 1) * gw;
      parts.push(`<rect x="${n1(tx0)}" y="${n1(gy)}" width="${n1(Math.max(1, tx1 - tx0))}" height="${n1(gh)}" fill="#dbeafe" opacity="0.45"/>`);
    }

    // Hotspot bands
    for (const hs of prof.markers.hotspots.slice(0, 3)) {
      const hx0 = gx + clamp(hs.startSec / dur, 0, 1) * gw;
      const hx1 = gx + clamp(hs.endSec / dur, 0, 1) * gw;
      parts.push(`<rect x="${n1(hx0)}" y="${n1(gy)}" width="${n1(Math.max(2, hx1 - hx0))}" height="${n1(gh)}" fill="#fca5a5" opacity="0.28"/>`);
    }

    const idxs = downsampleIndices(frames.length, 110);
    if (idxs.length > 0) {
      const topPts = [];
      const botPts = [];
      const rmsPts = [];
      for (const idx of idxs) {
        const f = frames[idx];
        const x = gx + clamp(f.timeSec / dur, 0, 1) * gw;
        topPts.push([x, midY - clamp(f.peakPos, -1, 1) * (gh * 0.48)]);
        botPts.push([x, midY - clamp(f.peakNeg, -1, 1) * (gh * 0.48)]);
        rmsPts.push([x, gy + gh - clamp(f.rms, 0, 1) * gh]);
      }
      const polyPts = [...topPts, ...botPts.reverse()];
      parts.push(`<polygon points="${pointsAttr(polyPts)}" fill="#93c5fd" opacity="0.45"/>`);
      parts.push(`<polyline points="${pointsAttr(rmsPts)}" fill="none" stroke="#1d4ed8" stroke-width="1.5"/>`);
    }

    // Onsets & clips
    for (const t of prof.markers.onsets.slice(0, 20)) {
      const x = gx + clamp(t / dur, 0, 1) * gw;
      parts.push(`<line x1="${n1(x)}" y1="${n1(gy)}" x2="${n1(x)}" y2="${n1(gy + 8)}" stroke="#059669" stroke-width="1.2"/>`);
    }
    for (const t of prof.markers.clips.slice(0, 20)) {
      const x = gx + clamp(t / dur, 0, 1) * gw;
      parts.push(`<line x1="${n1(x)}" y1="${n1(gy)}" x2="${n1(x)}" y2="${n1(gy + gh)}" stroke="#dc2626" stroke-width="1" opacity="0.65"/>`);
    }

    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + 8)}" text-anchor="end" font-size="9" fill="#6b7280">+1</text>`);
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(midY + 3)}" text-anchor="end" font-size="9" fill="#6b7280">0</text>`);
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + gh)}" text-anchor="end" font-size="9" fill="#6b7280">-1</text>`);
    parts.push(`<text x="${n1(gx)}" y="${n1(gy + gh + 12)}" font-size="9" fill="#6b7280">0.00s</text>`);
    parts.push(`<text x="${n1(gx + gw)}" y="${n1(gy + gh + 12)}" text-anchor="end" font-size="9" fill="#6b7280">${n2(prof.durationSec)}s</text>`);
  }

  // -------------------------------------------------------------------------
  // Panel 2: Mel Spectrogram (Inline Base64 Magma PNG)
  // -------------------------------------------------------------------------
  const specMin = Math.round(prof.spectrogram.minDb);
  const specMax = Math.round(prof.spectrogram.maxDb);
  parts.push(panelBox(px1, py0, colW, rowH, "2. Mel Spectrogram (Magma)", `${specMin}..${specMax} dB`));
  {
    const gx = px1 + 38;
    const gy = py0 + 26;
    const gw = colW - 48;
    const gh = rowH - 44;
    const dataUri = buildSpectrogramDataUri(prof, 128, 40);
    parts.push(
      `<image x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" href="${dataUri}" preserveAspectRatio="none"/>`
    );
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="none" stroke="#374151" stroke-width="0.8"/>`);

    for (const hs of prof.markers.hotspots.slice(0, 3)) {
      const hx0 = gx + clamp(hs.startSec / dur, 0, 1) * gw;
      const hx1 = gx + clamp(hs.endSec / dur, 0, 1) * gw;
      parts.push(
        `<rect x="${n1(hx0)}" y="${n1(gy)}" width="${n1(Math.max(2, hx1 - hx0))}" height="${n1(gh)}" fill="none" stroke="#fde047" stroke-width="1" stroke-dasharray="3,2"/>`
      );
    }

    const freqs = prof.spectrogram.freqsHz;
    const fLo = freqs.length ? freqs[0] : 60;
    const fMid = freqs.length ? freqs[Math.floor(freqs.length / 2)] : 1200;
    const fHi = freqs.length ? freqs[freqs.length - 1] : 8000;
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + 8)}" text-anchor="end" font-size="9" fill="#6b7280">${fmtFreq(fHi)}</text>`);
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + gh * 0.5 + 3)}" text-anchor="end" font-size="9" fill="#6b7280">${fmtFreq(fMid)}</text>`);
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + gh)}" text-anchor="end" font-size="9" fill="#6b7280">${fmtFreq(fLo)}</text>`);
    parts.push(`<text x="${n1(gx)}" y="${n1(gy + gh + 12)}" font-size="9" fill="#6b7280">0.00s</text>`);
    parts.push(`<text x="${n1(gx + gw)}" y="${n1(gy + gh + 12)}" text-anchor="end" font-size="9" fill="#6b7280">${n2(prof.durationSec)}s</text>`);
  }

  // -------------------------------------------------------------------------
  // Panel 3: Pitch (F0 / domHz) & HNR
  // -------------------------------------------------------------------------
  parts.push(panelBox(px0, py1, colW, rowH, "3. Pitch (F0/domHz) & HNR", "blue=F0 amber=HNR"));
  {
    const gx = px0 + 38;
    const gy = py1 + 26;
    const gw = colW - 48;
    const gh = rowH - 44;
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="#fcfbf9" stroke="#ece7de"/>`);

    const idxs = downsampleIndices(frames.length, 110);
    const maxPitch = Math.max(
      600,
      ...idxs.map((i) => (frames[i].f0 > 0 ? frames[i].f0 : frames[i].domHz))
    );
    const f0Pts = [];
    const hnrPts = [];
    for (const idx of idxs) {
      const f = frames[idx];
      const x = gx + clamp(f.timeSec / dur, 0, 1) * gw;
      const pVal = f.f0 > 0 ? f.f0 : f.domHz;
      if (pVal > 0) {
        f0Pts.push([x, gy + gh - clamp(pVal / maxPitch, 0, 1) * gh]);
      }
      hnrPts.push([x, gy + gh - clamp((f.hnrDb + 10) / 45, 0, 1) * gh]);
    }
    if (hnrPts.length > 1) {
      parts.push(`<polyline points="${pointsAttr(hnrPts)}" fill="none" stroke="#d97706" stroke-width="1.2" opacity="0.75"/>`);
    }
    if (f0Pts.length > 1) {
      parts.push(`<polyline points="${pointsAttr(f0Pts)}" fill="none" stroke="#2563eb" stroke-width="1.6"/>`);
    }
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + 8)}" text-anchor="end" font-size="9" fill="#6b7280">${Math.round(maxPitch)}</text>`);
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + gh)}" text-anchor="end" font-size="9" fill="#6b7280">0Hz</text>`);
    parts.push(`<text x="${n1(gx)}" y="${n1(gy + gh + 12)}" font-size="9" fill="#6b7280">0.00s</text>`);
    parts.push(`<text x="${n1(gx + gw)}" y="${n1(gy + gh + 12)}" text-anchor="end" font-size="9" fill="#6b7280">${n2(prof.durationSec)}s</text>`);
  }

  // -------------------------------------------------------------------------
  // Panel 4: Spectral Slice (meanDb & peakDb vs log Hz)
  // -------------------------------------------------------------------------
  parts.push(panelBox(px1, py1, colW, rowH, "4. Spectral Slice (Mean / Peak)", "log-Hz"));
  {
    const gx = px1 + 38;
    const gy = py1 + 26;
    const gw = colW - 48;
    const gh = rowH - 44;
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="#fcfbf9" stroke="#ece7de"/>`);

    const { freqsHz, meanDb, peakDb, peaks } = prof.spectralSlice;
    const fMin = Math.max(20, freqsHz[0] ?? 20);
    const fMax = Math.max(fMin + 10, freqsHz[freqsHz.length - 1] ?? 12000);
    const logMin = Math.log10(fMin);
    const logSpan = Math.max(0.1, Math.log10(fMax) - logMin);
    const xOfHz = (hz) => gx + clamp((Math.log10(Math.max(fMin, hz)) - logMin) / logSpan, 0, 1) * gw;
    const yOfDb = (db) => gy + gh - clamp((db + 100) / 100, 0, 1) * gh;

    const idxs = downsampleIndices(freqsHz.length, 96);
    if (idxs.length > 1) {
      const peakPts = idxs.map((i) => [xOfHz(freqsHz[i]), yOfDb(peakDb[i] ?? -100)]);
      const meanPts = idxs.map((i) => [xOfHz(freqsHz[i]), yOfDb(meanDb[i] ?? -100)]);
      parts.push(`<polyline points="${pointsAttr(peakPts)}" fill="none" stroke="#9ca3af" stroke-width="1"/>`);
      parts.push(`<polyline points="${pointsAttr(meanPts)}" fill="none" stroke="#7c3aed" stroke-width="1.6"/>`);
    }

    for (const pk of peaks.slice(0, 3)) {
      const cx = xOfHz(pk.hz);
      const cy = yOfDb(pk.db);
      parts.push(`<circle cx="${n1(cx)}" cy="${n1(cy)}" r="2.5" fill="#dc2626"/>`);
      parts.push(`<text x="${n1(cx + 4)}" y="${n1(Math.max(gy + 10, cy - 3))}" font-size="8.5" fill="#991b1b">${fmtFreq(pk.hz)}</text>`);
    }

    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + 8)}" text-anchor="end" font-size="9" fill="#6b7280">0dB</text>`);
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + gh)}" text-anchor="end" font-size="9" fill="#6b7280">-100</text>`);
    parts.push(`<text x="${n1(gx)}" y="${n1(gy + gh + 12)}" font-size="9" fill="#6b7280">${fmtFreq(fMin)}Hz</text>`);
    parts.push(`<text x="${n1(gx + gw)}" y="${n1(gy + gh + 12)}" text-anchor="end" font-size="9" fill="#6b7280">${fmtFreq(fMax)}Hz</text>`);
  }

  // -------------------------------------------------------------------------
  // Panel 5: Phase-Space Loop (Tension vs Breath)
  // -------------------------------------------------------------------------
  parts.push(panelBox(px0, py2, colW, rowH, "5. Phase-Space Loop (Tension vs Breath)", "green=start red=tail"));
  {
    const gx = px0 + 38;
    const gy = py2 + 26;
    const gw = colW - 48;
    const gh = rowH - 44;
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="#fcfbf9" stroke="#ece7de"/>`);
    parts.push(`<line x1="${n1(gx)}" y1="${n1(gy + gh)}" x2="${n1(gx + gw)}" y2="${n1(gy)}" stroke="#e5e0d6" stroke-dasharray="3,3"/>`);

    const loop = prof.phaseLoop;
    const idxs = downsampleIndices(loop.length, 110);
    if (idxs.length > 0) {
      const pts = idxs.map((i) => [
        gx + clamp(loop[i].tension, 0, 1) * gw,
        gy + gh - clamp(loop[i].breath, 0, 1) * gh,
      ]);
      if (pts.length > 1) {
        parts.push(`<polyline points="${pointsAttr(pts)}" fill="none" stroke="#0f766e" stroke-width="1.4" opacity="0.85"/>`);
      }
      // Highlight tail segment
      const tw = prof.markers.tailWindow;
      if (tw.endSec > tw.startSec) {
        const tailPts = idxs
          .filter((i) => loop[i].t >= tw.startSec && loop[i].t <= tw.endSec)
          .map((i) => [
            gx + clamp(loop[i].tension, 0, 1) * gw,
            gy + gh - clamp(loop[i].breath, 0, 1) * gh,
          ]);
        if (tailPts.length > 1) {
          parts.push(`<polyline points="${pointsAttr(tailPts)}" fill="none" stroke="#dc2626" stroke-width="2"/>`);
        }
      }
      parts.push(`<circle cx="${n1(pts[0][0])}" cy="${n1(pts[0][1])}" r="3" fill="#16a34a"/>`);
      parts.push(`<circle cx="${n1(pts[pts.length - 1][0])}" cy="${n1(pts[pts.length - 1][1])}" r="3" fill="#dc2626"/>`);
    }

    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + 8)}" text-anchor="end" font-size="9" fill="#6b7280">B=1</text>`);
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + gh)}" text-anchor="end" font-size="9" fill="#6b7280">0</text>`);
    parts.push(`<text x="${n1(gx)}" y="${n1(gy + gh + 12)}" font-size="9" fill="#6b7280">Tension 0</text>`);
    parts.push(`<text x="${n1(gx + gw)}" y="${n1(gy + gh + 12)}" text-anchor="end" font-size="9" fill="#6b7280">1.0</text>`);
  }

  // -------------------------------------------------------------------------
  // Panel 6: Falsifier Scoreboard (Top 8 veto-first; quarantined excluded)
  // -------------------------------------------------------------------------
  const visibleFalsifiers = rep.falsifiers.filter(
    (f) => f.gateTag !== "quarantined" || (f.triggered && !f.diagnostic)
  );
  const diagCount = visibleFalsifiers.filter((f) => f.triggered && f.diagnostic).length;
  const qHidden = rep.quarantinedHidden || 0;
  const sbSubtitle =
    diagCount > 0 || qHidden > 0
      ? `${rep.triggeredCount} veto, ${diagCount} diag${qHidden ? `, ${qHidden}q hidden` : ""}`
      : `${rep.triggeredCount}/${rep.totalFalsifiers} veto`;
  parts.push(panelBox(px1, py2, colW, rowH, "6. Falsifier Scoreboard", sbSubtitle));
  {
    const gx = px1 + 10;
    const gy = py2 + 28;
    const labelW = 148;
    const barX = gx + labelW;
    const barW = colW - labelW - 56;
    const ranked = [...visibleFalsifiers]
      .sort(
        (a, b) =>
          Number(b.triggered && !b.diagnostic) - Number(a.triggered && !a.diagnostic) ||
          Number(b.triggered) - Number(a.triggered) ||
          b.score - a.score
      )
      .slice(0, 8);

    if (ranked.length === 0) {
      parts.push(`<text x="${n1(gx + 8)}" y="${n1(gy + 24)}" font-size="11" fill="#6b7280">No falsifier report provided.</text>`);
    } else {
      const step = (rowH - 38) / Math.max(1, ranked.length);
      const barH = Math.max(8, Math.min(12, step - 4));
      ranked.forEach((f, i) => {
        const y = gy + i * step;
        const isVeto = f.triggered && !f.diagnostic;
        const isDiag = f.triggered && f.diagnostic;
        const fill = isVeto ? "#dc2626" : isDiag ? "#d97706" : "#64748b";
        const textFill = isVeto ? "#991b1b" : isDiag ? "#92400e" : "#374151";
        const prefix = isVeto ? "[!] " : isDiag ? "[d] " : "";
        const wFill = clamp(f.score, 0, 1) * barW;
        const thrX = barX + clamp(f.threshold, 0, 1) * barW;
        parts.push(
          `<text x="${n1(gx)}" y="${n1(y + barH - 1)}" font-size="9.5" fill="${textFill}">${escXml(truncate(prefix + f.id, 22))}</text>`
        );
        parts.push(`<rect x="${n1(barX)}" y="${n1(y)}" width="${n1(barW)}" height="${n1(barH)}" rx="2" fill="#f1f5f9"/>`);
        parts.push(`<rect x="${n1(barX)}" y="${n1(y)}" width="${n1(wFill)}" height="${n1(barH)}" rx="2" fill="${fill}"/>`);
        parts.push(`<line x1="${n1(thrX)}" y1="${n1(y - 1)}" x2="${n1(thrX)}" y2="${n1(y + barH + 1)}" stroke="#111827" stroke-width="1"/>`);
        parts.push(
          `<text x="${n1(barX + barW + 6)}" y="${n1(y + barH - 1)}" font-size="9" fill="#374151">${n2(f.score)}</text>`
        );
      });
    }
  }

  parts.push("</svg>");
  return parts.join("\n");
}

export function renderSvgDiff(profileA, profileB, reportA = null, reportB = null, opts = {}) {
  const profA = normalizeProfile(profileA);
  const profB = normalizeProfile(profileB);
  const repA = normalizeReport(reportA);
  const repB = normalizeReport(reportB);

  const W = 960;
  const H = 640;
  const pad = 14;
  const headerH = 48;
  const colW = (W - pad * 3) / 2;
  const rowH = (H - headerH - pad * 4) / 3;
  const durMax = Math.max(0.001, profA.durationSec, profB.durationSec);

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">`
  );
  parts.push(`<rect width="${W}" height="${H}" fill="#faf8f5"/>`);

  // Header
  parts.push(`<rect x="0" y="0" width="${W}" height="${headerH}" fill="#f3efe8"/>`);
  parts.push(`<line x1="0" y1="${headerH}" x2="${W}" y2="${headerH}" stroke="#dfd9ce" stroke-width="1"/>`);
  parts.push(
    `<text x="${pad}" y="21" font-size="13.5" font-weight="700" fill="#111827">YATA A/B Diff — A:${escXml(truncate(repA.label, 22))} vs B:${escXml(truncate(repB.label, 22))}</text>`
  );
  parts.push(
    `<text x="${pad}" y="38" font-size="10" fill="#2563eb">A(blue): ${escXml(repA.verdict)} (${repA.triggeredCount}/${repA.totalFalsifiers})</text>`
  );
  parts.push(
    `<text x="${pad + 340}" y="38" font-size="10" fill="#dc2626">B(red): ${escXml(repB.verdict)} (${repB.triggeredCount}/${repB.totalFalsifiers})</text>`
  );

  const px0 = pad;
  const px1 = pad * 2 + colW;
  const py0 = headerH + pad;
  const py1 = py0 + rowH + pad;
  const py2 = py1 + rowH + pad;

  // Panel 1: Envelope A vs B
  parts.push(panelBox(px0, py0, colW, rowH, "1. RMS Envelope Overlay", "blue=A red=B"));
  {
    const gx = px0 + 34;
    const gy = py0 + 26;
    const gw = colW - 44;
    const gh = rowH - 44;
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="#fcfbf9" stroke="#ece7de"/>`);
    const drawEnv = (prof, color) => {
      const idxs = downsampleIndices(prof.frames.length, 100);
      if (idxs.length < 2) return;
      const pts = idxs.map((i) => [
        gx + clamp(prof.frames[i].timeSec / durMax, 0, 1) * gw,
        gy + gh - clamp(prof.frames[i].rms, 0, 1) * gh,
      ]);
      parts.push(`<polyline points="${pointsAttr(pts)}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.85"/>`);
    };
    drawEnv(profA, "#2563eb");
    drawEnv(profB, "#dc2626");
    parts.push(`<text x="${n1(gx)}" y="${n1(gy + gh + 12)}" font-size="9" fill="#6b7280">0.00s</text>`);
    parts.push(`<text x="${n1(gx + gw)}" y="${n1(gy + gh + 12)}" text-anchor="end" font-size="9" fill="#6b7280">${n2(durMax)}s</text>`);
  }

  // Panel 2: Signed Mel Spectrogram Delta (B - A)
  parts.push(panelBox(px1, py0, colW, rowH, "2. Mel Spectrogram Delta (B - A)", "blue=A>B red=B>A"));
  {
    const gx = px1 + 38;
    const gy = py0 + 26;
    const gw = colW - 48;
    const gh = rowH - 44;
    const dataUri = buildDiffSpectrogramDataUri(profA, profB, 128, 40);
    parts.push(
      `<image x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" href="${dataUri}" preserveAspectRatio="none"/>`
    );
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="none" stroke="#374151" stroke-width="0.8"/>`);
    parts.push(`<text x="${n1(gx)}" y="${n1(gy + gh + 12)}" font-size="9" fill="#6b7280">0.00s</text>`);
    parts.push(`<text x="${n1(gx + gw)}" y="${n1(gy + gh + 12)}" text-anchor="end" font-size="9" fill="#6b7280">${n2(durMax)}s</text>`);
  }

  // Panel 3: Pitch F0/domHz A vs B
  parts.push(panelBox(px0, py1, colW, rowH, "3. Pitch Contour Overlay", "blue=A red=B"));
  {
    const gx = px0 + 38;
    const gy = py1 + 26;
    const gw = colW - 48;
    const gh = rowH - 44;
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="#fcfbf9" stroke="#ece7de"/>`);
    const allP = [
      ...profA.frames.map((f) => (f.f0 > 0 ? f.f0 : f.domHz)),
      ...profB.frames.map((f) => (f.f0 > 0 ? f.f0 : f.domHz)),
    ];
    const maxPitch = Math.max(600, ...allP);
    const drawPitch = (prof, color) => {
      const idxs = downsampleIndices(prof.frames.length, 100);
      const pts = [];
      for (const i of idxs) {
        const f = prof.frames[i];
        const p = f.f0 > 0 ? f.f0 : f.domHz;
        if (p > 0) {
          pts.push([
            gx + clamp(f.timeSec / durMax, 0, 1) * gw,
            gy + gh - clamp(p / maxPitch, 0, 1) * gh,
          ]);
        }
      }
      if (pts.length > 1) {
        parts.push(`<polyline points="${pointsAttr(pts)}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.85"/>`);
      }
    };
    drawPitch(profA, "#2563eb");
    drawPitch(profB, "#dc2626");
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + 8)}" text-anchor="end" font-size="9" fill="#6b7280">${Math.round(maxPitch)}</text>`);
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + gh)}" text-anchor="end" font-size="9" fill="#6b7280">0Hz</text>`);
  }

  // Panel 4: Spectral Slice Overlay A vs B
  parts.push(panelBox(px1, py1, colW, rowH, "4. Mean Spectral Slice Overlay", "blue=A red=B"));
  {
    const gx = px1 + 38;
    const gy = py1 + 26;
    const gw = colW - 48;
    const gh = rowH - 44;
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="#fcfbf9" stroke="#ece7de"/>`);
    const drawSlice = (prof, color) => {
      const { freqsHz, meanDb } = prof.spectralSlice;
      if (freqsHz.length < 2) return;
      const fMin = Math.max(20, freqsHz[0]);
      const fMax = Math.max(fMin + 10, freqsHz[freqsHz.length - 1]);
      const logMin = Math.log10(fMin);
      const logSpan = Math.max(0.1, Math.log10(fMax) - logMin);
      const idxs = downsampleIndices(freqsHz.length, 96);
      const pts = idxs.map((i) => [
        gx + clamp((Math.log10(Math.max(fMin, freqsHz[i])) - logMin) / logSpan, 0, 1) * gw,
        gy + gh - clamp(((meanDb[i] ?? -100) + 100) / 100, 0, 1) * gh,
      ]);
      parts.push(`<polyline points="${pointsAttr(pts)}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.85"/>`);
    };
    drawSlice(profA, "#2563eb");
    drawSlice(profB, "#dc2626");
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + 8)}" text-anchor="end" font-size="9" fill="#6b7280">0dB</text>`);
    parts.push(`<text x="${n1(gx - 4)}" y="${n1(gy + gh)}" text-anchor="end" font-size="9" fill="#6b7280">-100</text>`);
  }

  // Panel 5: Phase-Space Overlay A vs B
  parts.push(panelBox(px0, py2, colW, rowH, "5. Phase-Space Loop Overlay", "blue=A red=B"));
  {
    const gx = px0 + 38;
    const gy = py2 + 26;
    const gw = colW - 48;
    const gh = rowH - 44;
    parts.push(`<rect x="${n1(gx)}" y="${n1(gy)}" width="${n1(gw)}" height="${n1(gh)}" fill="#fcfbf9" stroke="#ece7de"/>`);
    const drawLoop = (prof, color) => {
      const idxs = downsampleIndices(prof.phaseLoop.length, 100);
      if (idxs.length < 2) return;
      const pts = idxs.map((i) => [
        gx + clamp(prof.phaseLoop[i].tension, 0, 1) * gw,
        gy + gh - clamp(prof.phaseLoop[i].breath, 0, 1) * gh,
      ]);
      parts.push(`<polyline points="${pointsAttr(pts)}" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.8"/>`);
    };
    drawLoop(profA, "#2563eb");
    drawLoop(profB, "#dc2626");
  }

  // Panel 6: Falsifier Score Diff (Top 8 by |delta| or triggered)
  parts.push(panelBox(px1, py2, colW, rowH, "6. Falsifier Score Diff (A vs B)", "top 8 deltas"));
  {
    const gx = px1 + 10;
    const gy = py2 + 28;
    const labelW = 148;
    const barX = gx + labelW;
    const barW = colW - labelW - 60;

    const mapA = new Map(repA.falsifiers.map((f) => [f.id, f]));
    const mapB = new Map(repB.falsifiers.map((f) => [f.id, f]));
    const ids = [...new Set([...mapA.keys(), ...mapB.keys()])];
    const rows = ids
      .filter((id) => {
        const a = mapA.get(id);
        const b = mapB.get(id);
        const vetoA = Boolean(a?.triggered && !a?.diagnostic);
        const vetoB = Boolean(b?.triggered && !b?.diagnostic);
        if (vetoA || vetoB) return true;
        return a?.gateTag !== "quarantined" && b?.gateTag !== "quarantined";
      })
      .map((id) => {
        const a = mapA.get(id);
        const b = mapB.get(id);
        const sA = a?.score ?? 0;
        const sB = b?.score ?? 0;
        const anyVeto = Boolean((a?.triggered && !a?.diagnostic) || (b?.triggered && !b?.diagnostic));
        return {
          id,
          sA,
          sB,
          delta: sB - sA,
          anyVeto,
          anyTrig: Boolean(a?.triggered || b?.triggered),
        };
      })
      .sort(
        (x, y) =>
          Number(y.anyVeto) - Number(x.anyVeto) ||
          Number(y.anyTrig) - Number(x.anyTrig) ||
          Math.abs(y.delta) - Math.abs(x.delta)
      )
      .slice(0, 8);

    if (rows.length === 0) {
      parts.push(`<text x="${n1(gx + 8)}" y="${n1(gy + 24)}" font-size="11" fill="#6b7280">No falsifiers to compare.</text>`);
    } else {
      const step = (rowH - 38) / Math.max(1, rows.length);
      rows.forEach((r, i) => {
        const y = gy + i * step;
        parts.push(`<text x="${n1(gx)}" y="${n1(y + 10)}" font-size="9.5" fill="#374151">${escXml(truncate(r.id, 22))}</text>`);
        parts.push(`<rect x="${n1(barX)}" y="${n1(y + 1)}" width="${n1(barW)}" height="4" fill="#f1f5f9"/>`);
        parts.push(`<rect x="${n1(barX)}" y="${n1(y + 1)}" width="${n1(clamp(r.sA, 0, 1) * barW)}" height="4" fill="#2563eb"/>`);
        parts.push(`<rect x="${n1(barX)}" y="${n1(y + 6)}" width="${n1(barW)}" height="4" fill="#f1f5f9"/>`);
        parts.push(`<rect x="${n1(barX)}" y="${n1(y + 6)}" width="${n1(clamp(r.sB, 0, 1) * barW)}" height="4" fill="#dc2626"/>`);
        const sign = r.delta >= 0 ? "+" : "";
        parts.push(
          `<text x="${n1(barX + barW + 6)}" y="${n1(y + 10)}" font-size="8.5" fill="#374151">${sign}${n2(r.delta)}</text>`
        );
      });
    }
  }

  parts.push("</svg>");
  return parts.join("\n");
}
