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

function genToneBurstTrack(durationSec, intervals, f0 = 320, amp = 0.45) {
  const n = Math.round(SR * durationSec);
  const out = new Float32Array(n);
  for (const [s0, s1] of intervals) {
    const i0 = Math.max(0, Math.round(s0 * SR));
    const i1 = Math.min(n, Math.round(s1 * SR));
    const len = i1 - i0;
    const fade = Math.min(Math.round(0.015 * SR), Math.floor(len / 3));
    for (let i = i0; i < i1; i++) {
      const k = i - i0;
      let env = 1;
      if (fade > 0 && k < fade) env = k / fade;
      else if (fade > 0 && k >= len - fade) env = (len - 1 - k) / fade;
      const t = i / SR;
      out[i] =
        amp *
        env *
        (0.75 * Math.sin(2 * Math.PI * f0 * t) + 0.25 * Math.sin(2 * Math.PI * 2 * f0 * t));
    }
  }
  return out;
}

function genRigidFlattenedTone(durationSec = 1.0, f0 = 300) {
  const n = Math.round(SR * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Perfectly sterile, pitch-locked, dynamics-flattened tone (no jitter/shimmer/contour)
    out[i] =
      0.5 *
      (0.75 * Math.sin(2 * Math.PI * f0 * t) +
        0.2 * Math.sin(2 * Math.PI * 2 * f0 * t) +
        0.05 * Math.sin(2 * Math.PI * 3 * f0 * t));
  }
  return out;
}

function genAbruptCutPhrase(totalSec = 1.0, cutSec = 0.55, f0 = 330) {
  const n = Math.round(SR * totalSec);
  const cutIdx = Math.round(SR * cutSec);
  const out = new Float32Array(n);
  const fadeIn = Math.round(0.02 * SR);
  for (let i = 0; i < cutIdx && i < n; i++) {
    const t = i / SR;
    const env = i < fadeIn ? i / fadeIn : 1;
    out[i] =
      0.48 *
      env *
      (0.72 * Math.sin(2 * Math.PI * f0 * t) +
        0.2 * Math.sin(2 * Math.PI * 2 * f0 * t) +
        0.08 * Math.sin(2 * Math.PI * 3 * f0 * t));
  }
  return out;
}

describe("v0.7: Over-Sanitization Lens, Relational Dialogue Mirror & Breath-Release Counterfactual", () => {
  it("re-exports all v0.7 public API symbols", () => {
    for (const sym of [
      "computeSanitizationIndex",
      "analyzeDialogue",
      "renderDialogueMap",
    ]) {
      assert.equal(typeof yata[sym], "function", `Missing export: ${sym}`);
    }
  });

  it("computeSanitizationIndex separates alive_unpolished warm voice from over_sanitized rigid tone and emits --compare warning", () => {
    const corpus = yata.buildCorpus();
    const warmVoice = corpus.positives.find((p) => p.id === "pos_warm_voice");
    assert.ok(warmVoice, "Expected pos_warm_voice in synthetic corpus");

    const warmFeat = yata.extractFeatures(warmVoice.samples, warmVoice.sampleRate);
    const warmSan = yata.computeSanitizationIndex(warmFeat);
    assert.equal(warmSan.imperfectionLabel, "alive_unpolished");
    assert.ok(
      warmSan.sanitizationScore >= 0 && warmSan.sanitizationScore < 0.35,
      `Expected warmVoice sanitizationScore < 0.35, got ${warmSan.sanitizationScore}`
    );
    assert.equal(warmFeat.sanitizationScore, warmSan.sanitizationScore);

    const rigidSamples = genRigidFlattenedTone(1.0, 300);
    const rigidFeat = yata.extractFeatures(rigidSamples, SR);
    const rigidSan = yata.computeSanitizationIndex(rigidFeat);
    assert.equal(rigidSan.imperfectionLabel, "over_sanitized");
    assert.ok(
      rigidSan.sanitizationScore >= 0.6,
      `Expected rigid tone sanitizationScore >= 0.60, got ${rigidSan.sanitizationScore}`
    );
    assert.ok(
      warmSan.sanitizationScore < rigidSan.sanitizationScore,
      `Expected warm (${warmSan.sanitizationScore}) < rigid (${rigidSan.sanitizationScore})`
    );

    // Silence -> 0 / "silent"
    const silence = new Float32Array(Math.round(SR * 0.5));
    const silFeat = yata.extractFeatures(silence, SR);
    const silSan = yata.computeSanitizationIndex(silFeat);
    assert.equal(silSan.imperfectionLabel, "silent");
    assert.equal(silSan.sanitizationScore, 0);
    assert.equal(silFeat.sanitizationScore, 0);

    // compareReports emits OVER-SANITIZATION WARNING when B is over-sanitized relative to A
    const repA = yata.analyzeSamples(warmVoice.samples, warmVoice.sampleRate, { label: "original_warm" });
    const repB = yata.analyzeSamples(rigidSamples, SR, { label: "flattened_rigid" });
    const cmp = yata.compareReports(repA, repB);
    assert.ok(cmp.sanitizationDelta >= 0.15, `Expected sanitizationDelta >= 0.15, got ${cmp.sanitizationDelta}`);
    assert.ok(
      typeof cmp.overSanitizationWarning === "string" &&
        cmp.overSanitizationWarning.includes("OVER-SANITIZATION WARNING"),
      `Expected OVER-SANITIZATION WARNING, got ${cmp.overSanitizationWarning}`
    );

    const cmpText = yata.formatCompareForLLM(cmp);
    assert.match(cmpText, /OVER-SANITIZATION WARNING: B is more sanitized \(\+\d\.\d{2}\) than A/);

    // Reversed comparison (B is MORE alive than A) should NOT emit warning
    const cmpRev = yata.compareReports(repB, repA);
    assert.equal(cmpRev.overSanitizationWarning, null);
    assert.doesNotMatch(yata.formatCompareForLLM(cmpRev), /OVER-SANITIZATION WARNING/);

    // renderTextVision surfaces SAN=0.XX while honoring line budgets (compact <= 32, micro <= 15)
    const profA = yata.extractAudioProfile(warmVoice.samples, warmVoice.sampleRate);
    const compactView = yata.renderTextVision(profA, repA, { mode: "compact" });
    const fullView = yata.renderTextVision(profA, repA, { mode: "full" });
    const microView = yata.renderTextVision(profA, repA, { mode: "micro" });
    assert.ok(countLines(compactView) <= 32, `compact exceeded 32 lines: ${countLines(compactView)}`);
    assert.ok(countLines(microView) <= 15, `micro exceeded 15 lines: ${countLines(microView)}`);
    assert.match(compactView, /SAN=\d\.\d{2}/);
    assert.match(fullView, /SAN=\d\.\d{2}/);
  });

  it("analyzeDialogue and renderDialogueMap cleanly distinguish responsive_dialogue, overlapping_clash, disconnected_monologue, and silent_void in 5 lines", () => {
    // 1. Responsive dialogue: alternating A -> pause -> B -> pause -> A
    const respA = genToneBurstTrack(2.4, [[0.05, 0.55], [1.45, 1.95]], 310);
    const respB = genToneBurstTrack(2.4, [[0.75, 1.25], [2.10, 2.35]], 420);
    const resp = yata.analyzeDialogue(respA, SR, respB, SR);
    assert.equal(resp.relationLabel, "responsive_dialogue");
    assert.ok(resp.turnCount >= 2, `Expected >= 2 turns, got ${resp.turnCount}`);
    assert.ok(resp.overlapRatio < 0.1, `Expected low overlap, got ${resp.overlapRatio}`);
    assert.ok(resp.meanTurnGapSec > 0 && resp.meanTurnGapSec <= 0.5, `Expected clean gap, got ${resp.meanTurnGapSec}`);

    const respMapAscii = yata.renderDialogueMap(resp, { width: 48, charset: "ascii" });
    const respMapUni = yata.renderDialogueMap(resp, { width: 48, charset: "unicode" });
    assert.equal(countLines(respMapAscii), 5);
    assert.equal(countLines(respMapUni), 5);
    assert.ok(!/[^\x00-\x7f]/.test(respMapAscii), "ASCII dialogue map must be 7-bit ASCII");
    assert.match(respMapAscii, /\[YATA DIALOGUE\].*\[responsive_dialogue\]/);
    assert.match(respMapAscii, /TRACK A \|/);
    assert.match(respMapAscii, /TRACK B \|/);
    assert.match(respMapAscii, /REL\s+\|.*A.*B/);

    // 2. Overlapping clash: A and B talking over each other simultaneously
    const clashA = genToneBurstTrack(1.5, [[0.1, 1.3]], 300);
    const clashB = genToneBurstTrack(1.5, [[0.2, 1.4]], 450);
    const clash = yata.analyzeDialogue(clashA, SR, clashB, SR);
    assert.equal(clash.relationLabel, "overlapping_clash");
    assert.ok(clash.overlapRatio >= 0.7, `Expected high overlapRatio, got ${clash.overlapRatio}`);
    const clashMap = yata.renderDialogueMap(clash);
    assert.equal(countLines(clashMap), 5);
    assert.match(clashMap, /\[overlapping_clash\]/);
    assert.match(clashMap, /REL\s+\|.*X/);

    // 3a. Disconnected monologue: only A speaks
    const monoA = genToneBurstTrack(1.5, [[0.1, 1.1]], 310);
    const monoB = new Float32Array(Math.round(SR * 1.5));
    const mono = yata.analyzeDialogue(monoA, SR, monoB, SR);
    assert.equal(mono.relationLabel, "disconnected_monologue");
    assert.equal(mono.turnCount, 0);
    assert.equal(countLines(yata.renderDialogueMap(mono)), 5);

    // 3b. Disconnected monologue: 1.8s dead gap between A and B
    const gapA = genToneBurstTrack(3.0, [[0.05, 0.55]], 310);
    const gapB = genToneBurstTrack(3.0, [[2.35, 2.85]], 420);
    const sluggish = yata.analyzeDialogue(gapA, SR, gapB, SR);
    assert.equal(sluggish.relationLabel, "disconnected_monologue");
    assert.equal(sluggish.turnCount, 1);
    assert.ok(sluggish.meanTurnGapSec >= 1.5, `Expected >= 1.5s dead gap, got ${sluggish.meanTurnGapSec}`);
    assert.equal(countLines(yata.renderDialogueMap(sluggish)), 5);

    // 4. Silent void
    const silA = new Float32Array(Math.round(SR * 1.0));
    const silB = new Float32Array(Math.round(SR * 1.0));
    const voidRes = yata.analyzeDialogue(silA, SR, silB, SR);
    assert.equal(voidRes.relationLabel, "silent_void");
    assert.equal(voidRes.mutualSilenceRatio, 1);
    const voidMap = yata.renderDialogueMap(voidRes);
    assert.equal(countLines(voidMap), 5);
    assert.match(voidMap, /\[silent_void\]/);
  });

  it("generateCounterfactualSlice with mode='breath_tail' softens abrupt cutoff with zero clicks (F6 === false)", () => {
    const abrupt = genAbruptCutPhrase(1.0, 0.55, 330);
    const cf = yata.generateCounterfactualSlice(abrupt, SR, { mode: "breath_tail" });
    assert.equal(cf.mode, "breath_tail");
    assert.equal(cf.samples.length, abrupt.length);
    assert.ok(cf.window.endSec > cf.window.startSec, "Expected non-empty breath_tail window");

    // Verify outside-window samples are bit-for-bit identical
    const startIdx = Math.floor(cf.window.startSec * SR);
    const endIdx = Math.ceil(cf.window.endSec * SR);
    for (let i = 0; i < Math.max(0, startIdx - 1); i++) {
      assert.equal(cf.samples[i], abrupt[i], `Sample before window modified at index ${i}`);
    }
    for (let i = Math.min(abrupt.length, endIdx + 1); i < abrupt.length; i++) {
      assert.equal(cf.samples[i], abrupt[i], `Sample after window modified at index ${i}`);
    }

    // Verify zero clicks / glitches (F6 === false)
    const afterRep = yata.analyzeSamples(cf.samples, SR, { label: "breath_tail_after", policy: "veto_all" });
    const f6 = afterRep.falsifiers.find((f) => f.id === "F6_PHYSICAL_GLITCH");
    assert.ok(f6, "Expected F6_PHYSICAL_GLITCH in report");
    assert.equal(f6.triggered, false, `Expected F6 === false after breath_tail, got evidence: ${f6.evidence}`);

    // Verify release tail actually added gentle non-zero breath decay after 0.55s
    const postStart = Math.round(0.56 * SR);
    const postEnd = Math.round(0.68 * SR);
    let postSq = 0;
    for (let i = postStart; i < postEnd; i++) postSq += cf.samples[i] * cf.samples[i];
    const postRms = Math.sqrt(postSq / (postEnd - postStart));
    assert.ok(postRms > 0.005, `Expected gentle breath-air release tail after cutoff, got RMS=${postRms}`);
  });

  it("CLI --dialogue and --counterfactual --cf-mode breath_tail exit 0 cleanly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yata-v07-test-"));
    try {
      const aPath = path.join(tmpDir, "speaker_a.wav");
      const bPath = path.join(tmpDir, "speaker_b.wav");
      const abruptPath = path.join(tmpDir, "abrupt.wav");
      const cfOutPath = path.join(tmpDir, "abrupt_breath_tail.wav");

      const trackA = genToneBurstTrack(2.0, [[0.05, 0.5], [1.2, 1.65]], 300);
      const trackB = genToneBurstTrack(2.0, [[0.65, 1.05], [1.75, 1.95]], 420);
      fs.writeFileSync(aPath, yata.encodeWavBuffer(trackA, SR));
      fs.writeFileSync(bPath, yata.encodeWavBuffer(trackB, SR));
      fs.writeFileSync(abruptPath, yata.encodeWavBuffer(genAbruptCutPhrase(1.0, 0.55, 330), SR));

      // 1. CLI --dialogue (llm format)
      const resDlg = runCli(["--dialogue", aPath, bPath]);
      assert.equal(resDlg.status, 0, `CLI --dialogue failed: ${resDlg.stderr}`);
      assert.equal(countLines(resDlg.stdout), 5);
      assert.match(resDlg.stdout, /\[YATA DIALOGUE\].*\[responsive_dialogue\]/);

      // 2. CLI --dialogue (json format)
      const resDlgJson = runCli(["--dialogue", aPath, bPath, "--format", "json"]);
      assert.equal(resDlgJson.status, 0, `CLI --dialogue --format json failed: ${resDlgJson.stderr}`);
      const parsedDlg = JSON.parse(resDlgJson.stdout);
      assert.equal(parsedDlg.relationLabel, "responsive_dialogue");
      assert.ok(parsedDlg.turnCount >= 2);

      // 3. CLI --counterfactual --cf-mode breath_tail
      const resCf = runCli([abruptPath, "--counterfactual", cfOutPath, "--cf-mode", "breath_tail"]);
      assert.equal(resCf.status, 0, `CLI --cf-mode breath_tail failed: ${resCf.stderr}`);
      assert.match(resCf.stdout, /mode=breath_tail/);
      assert.ok(fs.existsSync(cfOutPath), "Expected breath_tail counterfactual WAV to be written");
      const decoded = yata.decodeWavBuffer(fs.readFileSync(cfOutPath));
      const rep = yata.analyzeSamples(decoded.samples, decoded.sampleRate, { policy: "veto_all" });
      const f6 = rep.falsifiers.find((f) => f.id === "F6_PHYSICAL_GLITCH");
      assert.equal(f6.triggered, false, "CLI breath_tail output must be click-free (F6 === false)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
