import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as yata from "../unkawaii_detector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "unkawaii_detector.mjs");
const SR = 24000;

function countLines(text) {
  const norm = String(text ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return norm.length === 0 ? 0 : norm.split("\n").length;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 20000,
  });
}

function genCleanVoice(durationSec, f0 = 330) {
  const n = Math.round(SR * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t);
    // Gentle 15ms fade in/out to avoid edge clicks
    const fadeIn = Math.min(1, t / 0.015);
    const fadeOut = Math.min(1, (durationSec - t) / 0.015);
    const amp = 0.45 * env * fadeIn * fadeOut;
    out[i] =
      amp *
      (0.7 * Math.sin(2 * Math.PI * f0 * t) +
        0.22 * Math.sin(2 * Math.PI * 2 * f0 * t) +
        0.08 * Math.sin(2 * Math.PI * 3 * f0 * t));
  }
  return out;
}

function genTwoHalfRoughClip() {
  const dur = 2.0;
  const n = Math.round(SR * dur);
  const half = n >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const fadeIn = Math.min(1, t / 0.015);
    const fadeOut = Math.min(1, (dur - t) / 0.015);
    const edge = fadeIn * fadeOut;
    if (i < half) {
      const env = 0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t);
      out[i] =
        0.45 *
        edge *
        env *
        (0.7 * Math.sin(2 * Math.PI * 330 * t) + 0.25 * Math.sin(2 * Math.PI * 660 * t));
    } else {
      // Smooth 20ms crossfade into rough 70 Hz AM second half so transition itself has no click
      const alpha = Math.min(1, (i - half) / (SR * 0.02));
      const cleanVal =
        0.45 *
        (0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t)) *
        (0.7 * Math.sin(2 * Math.PI * 330 * t) + 0.25 * Math.sin(2 * Math.PI * 660 * t));
      const am = 0.5 * (1 + 0.95 * Math.sin(2 * Math.PI * 70 * t));
      const roughVal =
        0.55 * am * (0.6 * Math.sin(2 * Math.PI * 820 * t) + 0.4 * Math.sin(2 * Math.PI * 1240 * t));
      out[i] = edge * (cleanVal * (1 - alpha) + roughVal * alpha);
    }
  }
  return out;
}

describe("v0.6: Breath & Pause Profile, Timeline Diff & Minimal Counterfactual Mirror", () => {
  it("re-exports all v0.6 public API symbols", () => {
    for (const sym of [
      "computeBreathPauseProfile",
      "renderTimelineDiff",
      "findTimelineHotspot",
      "generateCounterfactualSlice",
    ]) {
      assert.equal(typeof yata[sym], "function", `Missing export: ${sym}`);
    }
  });

  it("computeBreathPauseProfile distinguishes silence, brief_glance, phrased_breath, and continuous_wall", () => {
    // 1. Silence
    const silence = new Float32Array(Math.round(SR * 0.5));
    const silProf = yata.extractAudioProfile(silence, SR);
    const silBreath = yata.computeBreathPauseProfile(silProf.frames, 0.5);
    assert.equal(silBreath.cadenceLabel, "silent");
    assert.equal(silBreath.activeDutyCycle, 0);
    assert.equal(silBreath.pauseCount, 0);
    assert.equal(silBreath.breathlessWallRatio, 0);

    // 1b. Ultra-short 15ms clip -> all finite, no NaN/Infinity
    const shortClip = new Float32Array(Math.round(SR * 0.015));
    const shortFeat = yata.extractFeatures(shortClip, SR);
    for (const k of [
      "activeDutyCycle",
      "pauseCount",
      "meanPauseSec",
      "longestContinuousSec",
      "breathlessWallRatio",
    ]) {
      assert.ok(Number.isFinite(shortFeat[k]), `Feature ${k} must be finite on 15ms clip`);
    }

    // 2. Brief 0.05s glance inside 0.5s clip
    const glance = new Float32Array(Math.round(SR * 0.5));
    const blipLen = Math.round(SR * 0.05);
    for (let i = 0; i < blipLen; i++) {
      glance[i] = 0.5 * Math.sin((2 * Math.PI * 330 * i) / SR);
    }
    const glanceTl = yata.extractSegmentTimeline(null, glance, SR);
    assert.equal(glanceTl.breath.cadenceLabel, "brief_glance");
    assert.ok(glanceTl.breath.activeDutyCycle > 0 && glanceTl.breath.activeDutyCycle <= 0.3);
    assert.equal(glanceTl.breath.pauseCount, 0);
    assert.equal(glanceTl.breath.breathlessWallRatio, 0);

    // 3. Phrased speech with 2 internal pauses (3 phrases x 0.45s + 2 pauses x 0.25s = 1.85s)
    const phrased = new Float32Array(Math.round(SR * 1.9));
    const intervals = [
      [0.05, 0.5],
      [0.75, 1.2],
      [1.45, 1.85],
    ];
    for (const [s0, s1] of intervals) {
      const i0 = Math.round(s0 * SR);
      const i1 = Math.round(s1 * SR);
      for (let i = i0; i < i1; i++) {
        const u = (i - i0) / (i1 - i0);
        const env = Math.sin(Math.PI * u);
        phrased[i] = 0.5 * env * Math.sin((2 * Math.PI * 320 * i) / SR);
      }
    }
    const phrasedFeat = yata.extractFeatures(phrased, SR);
    const phrasedTl = yata.extractSegmentTimeline(null, phrased, SR);
    assert.equal(phrasedTl.breath.cadenceLabel, "phrased_breath");
    assert.equal(phrasedTl.breath.pauseCount, 2);
    assert.ok(phrasedTl.breath.meanPauseSec >= 0.15, `Expected meanPauseSec >= 0.15, got ${phrasedTl.breath.meanPauseSec}`);
    assert.equal(phrasedFeat.pauseCount, 2);
    assert.equal(phrasedFeat.breathlessWallRatio, 0);

    // 4. 3.5s continuous breathless wall
    const wall = genCleanVoice(3.5, 280);
    const wallFeat = yata.extractFeatures(wall, SR);
    const wallTl = yata.extractSegmentTimeline(null, wall, SR);
    assert.equal(wallTl.breath.cadenceLabel, "continuous_wall");
    assert.ok(wallTl.breath.longestContinuousSec >= 3.2, `Expected >= 3.2s, got ${wallTl.breath.longestContinuousSec}`);
    assert.ok(wallTl.breath.breathlessWallRatio > 0.4, `Expected > 0.4, got ${wallTl.breath.breathlessWallRatio}`);
    assert.equal(wallFeat.breathlessWallRatio, wallTl.breath.breathlessWallRatio);

    // 5. renderSegmentTimeline preserves 4-line contract and surfaces breath summary in header
    const rendered = yata.renderSegmentTimeline(wallTl, { charset: "ascii" });
    assert.equal(countLines(rendered), 4);
    assert.match(rendered, /duty=\d+%/);
    assert.match(rendered, /pauses=0/);
    assert.match(rendered, /\[continuous_wall\]/);
  });

  it("renderTimelineDiff highlights exact changed 0.5s window in 5 compact lines", () => {
    const clean = genCleanVoice(2.0, 330);
    const modified = new Float32Array(clean);
    // Inject rough 70 Hz AM ONLY in [0.5..1.0s]
    const s0 = Math.round(0.5 * SR);
    const s1 = Math.round(1.0 * SR);
    for (let i = s0; i < s1; i++) {
      const t = i / SR;
      const am = 0.5 * (1 + 0.95 * Math.sin(2 * Math.PI * 70 * t));
      modified[i] = 0.55 * am * (0.6 * Math.sin(2 * Math.PI * 820 * t) + 0.4 * Math.sin(2 * Math.PI * 1240 * t));
    }

    const tlA = yata.extractSegmentTimeline(null, clean, SR, { windowSec: 0.5 });
    const tlB = yata.extractSegmentTimeline(null, modified, SR, { windowSec: 0.5 });

    const diffAscii = yata.renderTimelineDiff(tlA, tlB, { charset: "ascii" });
    const diffUnicode = yata.renderTimelineDiff(tlA, tlB, { charset: "unicode" });

    assert.equal(countLines(diffAscii), 5);
    assert.equal(countLines(diffUnicode), 5);
    assert.ok(!/[^\x00-\x7f]/.test(diffAscii), "ascii timeline diff should be 7-bit ASCII");
    assert.match(diffAscii, /\[YATA TIMELINE DIFF\]/);
    assert.match(diffAscii, /0\.5\.\.1\.0s/, `Expected hotspot 0.5..1.0s in:\n${diffAscii}`);
    assert.match(diffAscii, /dPRES/);
    assert.match(diffAscii, /dACT%/);
    assert.match(diffAscii, /dMPS/);
    assert.match(diffAscii, /dF0/);
    assert.match(diffUnicode, /HOTSPOT Δ: 0\.5\.\.1\.0s/);
  });

  it("generateCounterfactualSlice preserves outside samples bit-for-bit, reduces hotspot MPS, and avoids clicks", () => {
    const mixed = genTwoHalfRoughClip();
    const cf = yata.generateCounterfactualSlice(mixed, SR, {
      windowSec: 0.5,
      crossfadeSec: 0.025,
    });

    assert.ok(cf.samples instanceof Float32Array);
    assert.equal(cf.samples.length, mixed.length);
    assert.ok(
      cf.window.startSec >= 1.0,
      `Expected hotspot in rough second half (>= 1.0s), got ${cf.window.startSec}..${cf.window.endSec}s`
    );

    // Verify samples outside [startSec - crossfade, endSec + crossfade] (and in fact outside [startSec, endSec])
    // are bit-for-bit identical!
    const startIdx = Math.floor(cf.window.startSec * SR);
    const endIdx = Math.ceil(cf.window.endSec * SR);
    for (let i = 0; i < startIdx; i++) {
      assert.equal(cf.samples[i], mixed[i], `Sample before window at idx=${i} was modified`);
    }
    for (let i = endIdx; i < mixed.length; i++) {
      assert.equal(cf.samples[i], mixed[i], `Sample after window at idx=${i} was modified`);
    }

    // Verify MPS roughness in the hotspot window measurably decreased
    const hotSegIdx = Math.round(cf.window.startSec / 0.5);
    const mpsBefore = cf.beforeTimeline.segments[hotSegIdx].mpsRoughness30_150;
    const mpsAfter = cf.afterTimeline.segments[hotSegIdx].mpsRoughness30_150;
    assert.ok(
      mpsAfter < mpsBefore * 0.65,
      `Expected counterfactual to measurably reduce hotspot MPS: before=${mpsBefore}, after=${mpsAfter}`
    );

    // Verify NO click/glitch introduced (F6_PHYSICAL_GLITCH stays false)
    const repAfter = yata.analyzeSamples(cf.samples, SR, { label: "cf_after" });
    const f6 = repAfter.falsifiers.find((f) => f.id === "F6_PHYSICAL_GLITCH");
    assert.equal(f6.triggered, false, `Expected F6_PHYSICAL_GLITCH=false, got evidence: ${f6.evidence}`);

    // Verify timelineDiff is populated
    assert.equal(countLines(cf.timelineDiff), 5);
    assert.match(cf.timelineDiff, /\[YATA TIMELINE DIFF\]/);
  });

  it("CLI --counterfactual and --compare/--diff --timeline and --timeline-diff exit 0 cleanly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yata-v06-cli-"));
    try {
      const mixed = genTwoHalfRoughClip();
      const origPath = path.join(tmpDir, "mixed.wav");
      const cfOutPath = path.join(tmpDir, "mixed_cf.wav");
      fs.writeFileSync(origPath, yata.encodeWavBuffer(mixed, SR));

      // 1. --counterfactual <out.wav>
      const cfRes = runCli([origPath, "--counterfactual", cfOutPath]);
      assert.equal(cfRes.status, 0, cfRes.stderr);
      assert.ok(fs.existsSync(cfOutPath), "Counterfactual WAV should be written");
      assert.match(cfRes.stdout, /\[YATA COUNTERFACTUAL\]/);
      assert.match(cfRes.stdout, /\[YATA TIMELINE DIFF\]/);

      // Decodable WAV with identical sample count
      const decodedCf = yata.decodeWavBuffer(fs.readFileSync(cfOutPath));
      assert.equal(decodedCf.samples.length, mixed.length);

      // 2. --compare a.wav b.wav --timeline
      const cmpTl = runCli(["--compare", origPath, cfOutPath, "--timeline"]);
      assert.equal(cmpTl.status, 0, cmpTl.stderr);
      assert.match(cmpTl.stdout, /UNKAWAII COMPARE/);
      assert.match(cmpTl.stdout, /\[YATA TIMELINE DIFF\]/);

      // 3. --diff a.wav b.wav --timeline
      const diffTl = runCli(["--diff", origPath, cfOutPath, "--timeline"]);
      assert.equal(diffTl.status, 0, diffTl.stderr);
      assert.match(diffTl.stdout, /YATA DIFF/);
      assert.match(diffTl.stdout, /\[YATA TIMELINE DIFF\]/);

      // 4. --timeline-diff a.wav b.wav
      const tlDiff = runCli(["--timeline-diff", origPath, cfOutPath]);
      assert.equal(tlDiff.status, 0, tlDiff.stderr);
      assert.equal(countLines(tlDiff.stdout), 5);
      assert.match(tlDiff.stdout, /\[YATA TIMELINE DIFF\]/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
