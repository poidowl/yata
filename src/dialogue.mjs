/**
 * src/dialogue.mjs — Two-Track Relational Dialogue Mirror (v0.7)
 *
 * Implements Domain 5 of docs/PHILOSOPHY.md ("関係の断絶・間"):
 * Aligns two audio tracks over time to inspect call-and-response turn-taking,
 * shared breathing pauses, overlapping clashes, and disconnected monologues.
 *
 * Zero external dependencies. Pure ES Module.
 */

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, lo, hi) {
  const f = finite(v, lo);
  return f < lo ? lo : f > hi ? hi : f;
}

function roundTo(v, digits) {
  const f = finite(v, 0);
  const scale = Math.pow(10, digits);
  return Math.round(f * scale) / scale;
}

function frameRms(samples, startIdx, endIdx) {
  if (!samples || endIdx <= startIdx) return 0;
  let sq = 0;
  const len = endIdx - startIdx;
  for (let i = startIdx; i < endIdx; i++) {
    const x = Number.isFinite(samples[i]) ? samples[i] : 0;
    sq += x * x;
  }
  return Math.sqrt(sq / len);
}

/**
 * Analyze two aligned audio tracks for turn-taking, overlap, and shared silence.
 *
 * @param {Float32Array|ArrayLike<number>} samplesA
 * @param {number} sampleRateA
 * @param {Float32Array|ArrayLike<number>} samplesB
 * @param {number} sampleRateB
 * @param {{
 *   frameMs?: number,
 *   activeRmsThresh?: number,
 *   labelA?: string,
 *   labelB?: string,
 * }} [opts={}]
 */
export function analyzeDialogue(samplesA, sampleRateA, samplesB, sampleRateB, opts = {}) {
  const sigA = samplesA ?? new Float32Array(0);
  const sigB = samplesB ?? new Float32Array(0);
  const srA = Number.isFinite(sampleRateA) && sampleRateA > 0 ? sampleRateA : 24000;
  const srB = Number.isFinite(sampleRateB) && sampleRateB > 0 ? sampleRateB : 24000;

  const durA = sigA.length / srA;
  const durB = sigB.length / srB;
  const durationSec = Math.max(durA, durB);

  const frameMs = clamp(finite(opts?.frameMs, 10), 2, 100);
  const frameSec = frameMs / 1000;
  const activeRmsThresh = clamp(finite(opts?.activeRmsThresh, 0.03), 1e-4, 0.5);

  const labelA = typeof opts?.labelA === "string" && opts.labelA.trim() ? opts.labelA.trim() : "A";
  const labelB = typeof opts?.labelB === "string" && opts.labelB.trim() ? opts.labelB.trim() : "B";

  if (durationSec <= 0) {
    return {
      schema: "unkawaii_dialogue/v0.7",
      labelA,
      labelB,
      durationSec: 0,
      frameSec: roundTo(frameSec, 4),
      frameCount: 0,
      activeRatioA: 0,
      activeRatioB: 0,
      bothActiveRatio: 0,
      overlapRatio: 0,
      turnCount: 0,
      meanTurnGapSec: 0,
      mutualSilenceRatio: 1,
      relationLabel: "silent_void",
      states: "",
    };
  }

  const numFrames = Math.max(1, Math.ceil(durationSec / frameSec));
  const statesArr = new Array(numFrames);

  let countA = 0;
  let countB = 0;
  let countBoth = 0;
  let countUnion = 0;
  let countNeither = 0;

  // Turn-taking tracker
  let lastSoleSpeaker = null; // "A" | "B"
  let lastSoleEndFrame = -1;
  let sawOverlapSinceLastSole = false;
  let turnCount = 0;
  const turnGaps = [];

  for (let k = 0; k < numFrames; k++) {
    const t0 = k * frameSec;
    const t1 = Math.min(durationSec, (k + 1) * frameSec);

    const a0 = Math.max(0, Math.min(sigA.length, Math.floor(t0 * srA)));
    const a1 = Math.max(a0, Math.min(sigA.length, Math.ceil(t1 * srA)));
    const b0 = Math.max(0, Math.min(sigB.length, Math.floor(t0 * srB)));
    const b1 = Math.max(b0, Math.min(sigB.length, Math.ceil(t1 * srB)));

    const actA = frameRms(sigA, a0, a1) >= activeRmsThresh;
    const actB = frameRms(sigB, b0, b1) >= activeRmsThresh;

    let st;
    if (actA && actB) {
      st = "X";
      countA++;
      countB++;
      countBoth++;
      countUnion++;
      if (lastSoleSpeaker !== null) {
        sawOverlapSinceLastSole = true;
      }
    } else if (actA) {
      st = "A";
      countA++;
      countUnion++;
      if (lastSoleSpeaker === "B") {
        turnCount++;
        const gapSec = sawOverlapSinceLastSole
          ? 0
          : Math.max(0, (k - lastSoleEndFrame - 1) * frameSec);
        turnGaps.push(gapSec);
        sawOverlapSinceLastSole = false;
      } else if (lastSoleSpeaker === "A") {
        sawOverlapSinceLastSole = false;
      }
      lastSoleSpeaker = "A";
      lastSoleEndFrame = k;
    } else if (actB) {
      st = "B";
      countB++;
      countUnion++;
      if (lastSoleSpeaker === "A") {
        turnCount++;
        const gapSec = sawOverlapSinceLastSole
          ? 0
          : Math.max(0, (k - lastSoleEndFrame - 1) * frameSec);
        turnGaps.push(gapSec);
        sawOverlapSinceLastSole = false;
      } else if (lastSoleSpeaker === "B") {
        sawOverlapSinceLastSole = false;
      }
      lastSoleSpeaker = "B";
      lastSoleEndFrame = k;
    } else {
      st = ".";
      countNeither++;
    }

    statesArr[k] = st;
  }

  const activeRatioA = countA / numFrames;
  const activeRatioB = countB / numFrames;
  const bothActiveRatio = countBoth / numFrames;
  const overlapRatio = countUnion > 0 ? countBoth / countUnion : 0;
  const mutualSilenceRatio = countNeither / numFrames;
  const meanTurnGapSec =
    turnGaps.length > 0 ? turnGaps.reduce((s, v) => s + v, 0) / turnGaps.length : 0;

  let relationLabel;
  if (countUnion === 0) {
    relationLabel = "silent_void";
  } else if (overlapRatio >= 0.35) {
    relationLabel = "overlapping_clash";
  } else if (turnCount >= 1 && overlapRatio < 0.35 && meanTurnGapSec <= 1.2) {
    relationLabel = "responsive_dialogue";
  } else {
    relationLabel = "disconnected_monologue";
  }

  return {
    schema: "unkawaii_dialogue/v0.7",
    labelA,
    labelB,
    durationSec: roundTo(durationSec, 3),
    frameSec: roundTo(frameSec, 4),
    frameCount: numFrames,
    activeRatioA: roundTo(activeRatioA, 4),
    activeRatioB: roundTo(activeRatioB, 4),
    bothActiveRatio: roundTo(bothActiveRatio, 4),
    overlapRatio: roundTo(overlapRatio, 4),
    turnCount,
    meanTurnGapSec: roundTo(meanTurnGapSec, 3),
    mutualSilenceRatio: roundTo(mutualSilenceRatio, 4),
    relationLabel,
    states: statesArr.join(""),
  };
}

/**
 * Render an ultra-compact 5-line two-track relational dialogue visual mirror.
 *
 * @param {object} dialogue - Output of analyzeDialogue
 * @param {{ width?: number, charset?: "ascii" | "unicode" }} [opts={}]
 * @returns {string}
 */
export function renderDialogueMap(dialogue, opts = {}) {
  const width = clamp(Math.floor(finite(opts?.width, 48)), 16, 120);
  const unicode = opts?.charset === "unicode";
  const vSep = unicode ? "│" : "|";
  const onChar = unicode ? "█" : "#";
  const offChar = unicode ? "·" : ".";

  const dur = finite(dialogue?.durationSec, 0);
  const turns = Math.round(finite(dialogue?.turnCount, 0));
  const overlapPct = Math.round(clamp(finite(dialogue?.overlapRatio, 0), 0, 1) * 100);
  const gapSec = finite(dialogue?.meanTurnGapSec, 0);
  const relLabel = dialogue?.relationLabel || "silent_void";

  const activeAPct = Math.round(clamp(finite(dialogue?.activeRatioA, 0), 0, 1) * 100);
  const activeBPct = Math.round(clamp(finite(dialogue?.activeRatioB, 0), 0, 1) * 100);
  const silencePct = Math.round(clamp(finite(dialogue?.mutualSilenceRatio, 0), 0, 1) * 100);

  const states = typeof dialogue?.states === "string" ? dialogue.states : "";
  const n = states.length;

  let trackA = "";
  let trackB = "";
  let relTrack = "";

  if (n === 0) {
    trackA = offChar.repeat(width);
    trackB = offChar.repeat(width);
    relTrack = offChar.repeat(width);
  } else {
    for (let col = 0; col < width; col++) {
      const i0 = Math.floor((col * n) / width);
      const i1 = Math.max(i0 + 1, Math.floor(((col + 1) * n) / width));
      let hasA = false;
      let hasB = false;
      let hasX = false;
      let cntA = 0;
      let cntB = 0;
      for (let i = i0; i < Math.min(n, i1); i++) {
        const ch = states[i];
        if (ch === "X") {
          hasA = true;
          hasB = true;
          hasX = true;
        } else if (ch === "A") {
          hasA = true;
          cntA++;
        } else if (ch === "B") {
          hasB = true;
          cntB++;
        }
      }
      trackA += hasA ? onChar : offChar;
      trackB += hasB ? onChar : offChar;
      if (hasX || (hasA && hasB)) {
        relTrack += "X";
      } else if (cntA > 0) {
        relTrack += "A";
      } else if (cntB > 0) {
        relTrack += "B";
      } else {
        relTrack += offChar;
      }
    }
  }

  let assessment;
  if (relLabel === "silent_void") {
    assessment = "both tracks silent";
  } else if (relLabel === "overlapping_clash") {
    assessment = `heavy overlap (${overlapPct}% of active time talking over each other)`;
  } else if (relLabel === "responsive_dialogue") {
    assessment = `clean call-and-response (${turns} handoff${turns === 1 ? "" : "s"}, avg gap ${gapSec.toFixed(2)}s)`;
  } else if (turns === 0) {
    assessment = "one-sided monologue (no speaker handoffs)";
  } else {
    assessment = `sluggish turn-taking (avg gap ${gapSec.toFixed(2)}s > 1.20s)`;
  }

  return [
    `[YATA DIALOGUE] dur=${dur.toFixed(2)}s turns=${turns} overlap=${overlapPct}% gap=${gapSec.toFixed(2)}s [${relLabel}]`,
    `TRACK A ${vSep}${trackA}${vSep}`,
    `TRACK B ${vSep}${trackB}${vSep}`,
    `REL     ${vSep}${relTrack}${vSep}`,
    `SUMMARY A=${activeAPct}% B=${activeBPct}% silence=${silencePct}% | ${assessment}`,
  ].join("\n");
}
