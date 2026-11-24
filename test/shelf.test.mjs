import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
  ORTHOGONAL_AXES,
  TOOLBOX_FALSIFIERS,
  analyzeSamples,
  formatForLLM,
  auditFalsifiersAgainstShelf,
  formatShelfAuditForLLM,
  loadEarPrecedents,
  applyEarPrecedents,
  encodeWavBuffer,
  buildCorpus,
} from "../unkawaii_detector.mjs";

const SR = 24000;

function mulberry32(seed = 777) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothEnv(t, dur, atk = 0.08, rel = 0.17) {
  let e = 1;
  if (t < atk && atk > 0) e *= 0.5 - 0.5 * Math.cos((Math.PI * t) / atk);
  const rem = dur - t;
  if (rem < rel && rel > 0) e *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, rem)) / rel);
  return e;
}

function makeWarmVoice(dur = 0.65, seed = 101) {
  const n = Math.round(SR * dur);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  let phase = 0;
  let breath = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const u = t / dur;
    const env = smoothEnv(t, dur, 0.08, 0.17);
    const f0 = 325 + 38 * Math.sin(Math.PI * u) - 16 * u + 1.8 * Math.sin(2 * Math.PI * 1.9 * t);
    phase += (2 * Math.PI * f0) / SR;
    const h2 = 0.28 + 0.08 * env;
    const h3 = 0.11 + 0.04 * env;
    const h4 = 0.045 * env;
    const sig =
      0.62 * Math.sin(phase) +
      h2 * Math.sin(2 * phase + 0.1) +
      h3 * Math.sin(3 * phase + 0.2) +
      h4 * Math.sin(4 * phase + 0.3);
    breath = 0.9 * breath + 0.1 * (rand() * 2 - 1);
    out[i] = 0.42 * env * (sig + 0.018 * breath);
  }
  return out;
}

describe("v0.3: ORTHOGONAL_AXES, Protected Shelf Audit, and core_veto Policy", () => {
  it("exports ORTHOGONAL_AXES (with F30) and TOOLBOX_FALSIFIERS (F7..F32 minus orthogonal) without altering DEFAULT_FALSIFIERS", () => {
    assert.equal(ORIGINAL_6_FALSIFIERS.length, 6);
    assert.equal(DEFAULT_FALSIFIERS.length, 65);
    assert.ok(Array.isArray(ORTHOGONAL_AXES) && ORTHOGONAL_AXES.length >= 1);

    const f30Meta = ORTHOGONAL_AXES.find((a) => a.id === "F30_STEREO_PHASE_DISCOMFORT");
    assert.ok(f30Meta, "Expected F30_STEREO_PHASE_DISCOMFORT in ORTHOGONAL_AXES");
    assert.equal(f30Meta.status, "orthogonal");
    assert.ok(typeof f30Meta.reason === "string" && f30Meta.reason.length > 0);

    const coreIds = new Set(ORIGINAL_6_FALSIFIERS.map((f) => f.id));
    const orthoIds = new Set(ORTHOGONAL_AXES.map((a) => a.id));
    assert.equal(TOOLBOX_FALSIFIERS.length, 65 - coreIds.size - orthoIds.size);
    for (const f of TOOLBOX_FALSIFIERS) {
      assert.ok(!coreIds.has(f.id), `Core axis ${f.id} should not be in TOOLBOX_FALSIFIERS`);
      assert.ok(!orthoIds.has(f.id), `Orthogonal axis ${f.id} should not be in TOOLBOX_FALSIFIERS`);
    }
  });

  it("auditFalsifiersAgainstShelf marks all axes CLEARED on clean shelf and CONTESTED when a shelf item is rejected", () => {
    const cleanVoice = makeWarmVoice(0.65, 101);
    const cleanAudit = auditFalsifiersAgainstShelf([
      {
        id: "loved_warm_voice",
        label: "Loved Warm Voice",
        samples: cleanVoice,
        sampleRate: SR,
        source: "synthetic_control",
        license: "CC0",
      },
    ]);

    assert.equal(cleanAudit.shelfSize, 1);
    assert.equal(cleanAudit.totalFalsifiers, 65);
    assert.equal(cleanAudit.contestedCount, 0);
    assert.equal(cleanAudit.clearedCount, 65);
    assert.equal(cleanAudit.shelfSurvivalRate.core6, 1);
    assert.equal(cleanAudit.shelfSurvivalRate.full, 1);

    const cleanSummary = formatShelfAuditForLLM(cleanAudit);
    assert.ok(cleanSummary.includes("[PROTECTED SHELF AUDIT]"));
    assert.ok(cleanSummary.includes("CONTESTED: none"));

    // Add a second protected sound with gentle enveloped 45 Hz room rumble (passes core6, triggers F13_SUBBASS_RUMBLE)
    const warmRumble = new Float32Array(cleanVoice.length);
    for (let i = 0; i < cleanVoice.length; i++) {
      const t = i / SR;
      const env = smoothEnv(t, 0.65, 0.08, 0.17);
      warmRumble[i] = 0.5 * cleanVoice[i] + 0.42 * env * Math.sin(2 * Math.PI * 45 * t);
    }

    const mixedAudit = auditFalsifiersAgainstShelf([
      { id: "loved_clean", label: "Loved Clean", samples: cleanVoice, sampleRate: SR },
      { id: "loved_room_rumble", label: "Loved Room Rumble", samples: warmRumble, sampleRate: SR },
    ]);

    assert.equal(mixedAudit.shelfSize, 2);
    assert.equal(mixedAudit.shelfSurvivalRate.core6, 1);
    assert.equal(mixedAudit.shelfSurvivalRate.core6Survived, 2);
    assert.equal(mixedAudit.shelfSurvivalRate.full, 0.5);
    assert.equal(mixedAudit.shelfSurvivalRate.fullSurvived, 1);
    assert.ok(mixedAudit.contestedCount >= 1);
    assert.ok(mixedAudit.contestedIds.includes("F13_SUBBASS_RUMBLE"));

    const f13Axis = mixedAudit.axes.find((a) => a.id === "F13_SUBBASS_RUMBLE");
    assert.ok(f13Axis);
    assert.equal(f13Axis.status, "CONTESTED");
    assert.equal(f13Axis.falsePositiveCount, 1);
    assert.equal(f13Axis.falsePositiveRate, 0.5);
    assert.equal(f13Axis.rejectedItems.length, 1);
    assert.equal(f13Axis.rejectedItems[0].id, "loved_room_rumble");

    const f1Axis = mixedAudit.axes.find((a) => a.id === "F1_HARSH_EDGE");
    assert.equal(f1Axis.status, "CLEARED");
    assert.equal(f1Axis.falsePositiveCount, 0);

    const mixedSummary = formatShelfAuditForLLM(mixedAudit);
    assert.ok(mixedSummary.includes("F13_SUBBASS_RUMBLE"));
    assert.ok(mixedSummary.includes("CONTESTED"));
    assert.ok(mixedSummary.includes("Loved Room Rumble"));
    assert.ok(mixedSummary.split("\n").length <= 20, "Shelf audit summary should stay compact");
  });

  it("policy: 'core_veto' reports non-core triggers as diagnostic without vetoing, while still vetoing core F1..F6", () => {
    const cleanVoice = makeWarmVoice(0.65, 202);
    // Sound with enveloped 45 Hz sub-bass only (triggers F13_SUBBASS_RUMBLE, passes F1..F6)
    const subBassOnly = new Float32Array(cleanVoice.length);
    for (let i = 0; i < cleanVoice.length; i++) {
      const t = i / SR;
      const env = smoothEnv(t, 0.65, 0.08, 0.17);
      subBassOnly[i] = 0.5 * cleanVoice[i] + 0.42 * env * Math.sin(2 * Math.PI * 45 * t);
    }

    const vetoAllRep = analyzeSamples(subBassOnly, SR, { label: "sub_veto_all", policy: "veto_all" });
    assert.equal(vetoAllRep.policy, "veto_all");
    assert.equal(vetoAllRep.verdict, "REJECTED_UNKAWAII");
    assert.ok(vetoAllRep.triggeredCount >= 1);
    assert.equal(vetoAllRep.diagnosticCount, 0);

    const coreVetoRep = analyzeSamples(subBassOnly, SR, { label: "sub_core_veto" });
    assert.equal(coreVetoRep.policy, "core_veto");
    assert.equal(coreVetoRep.verdict, "SURVIVED_KAWAII_CANDIDATE");
    assert.equal(coreVetoRep.triggeredCount, 0);
    assert.ok(coreVetoRep.diagnosticCount >= 1);

    const f13Diag = coreVetoRep.falsifiers.find((f) => f.id === "F13_SUBBASS_RUMBLE");
    assert.equal(f13Diag.triggered, true);
    assert.equal(f13Diag.diagnostic, true);

    const llmText = formatForLLM(coreVetoRep);
    assert.ok(llmText.includes("SURVIVED_KAWAII_CANDIDATE"));
    assert.ok(llmText.includes("policy=core_veto"));
    assert.ok(llmText.includes("DIAGNOSTIC"));
    assert.ok(llmText.includes("F13_SUBBASS_RUMBLE"));

    // Sound with full-scale clipping (triggers core F6_PHYSICAL_GLITCH) MUST still be rejected under core_veto
    const clipped = new Float32Array(Math.round(SR * 0.5));
    for (let i = 0; i < clipped.length; i++) {
      clipped[i] = Math.max(-1, Math.min(1, 3.0 * Math.sin((2 * Math.PI * 300 * i) / SR)));
    }
    const coreRejectRep = analyzeSamples(clipped, SR, { label: "clipped_core_veto", policy: "core_veto" });
    assert.equal(coreRejectRep.verdict, "REJECTED_UNKAWAII");
    assert.ok(coreRejectRep.triggeredCount >= 1);
    const f6Res = coreRejectRep.falsifiers.find((f) => f.id === "F6_PHYSICAL_GLITCH");
    assert.equal(f6Res.triggered, true);
    assert.equal(f6Res.diagnostic, undefined);
  });

  it("v0.4 default analyzeSamples uses core_veto (F24-only clip survives with diagnosticCount >= 1)", () => {
    const corpus = buildCorpus({ sampleRate: SR, seed: 2026 });
    const ceF24 = corpus.counterexamples.find((x) => x.id === "ce_F24");
    assert.ok(ceF24, "Expected canonical ce_F24 counterexample in corpus");

    // Default policy (no policy option) must be core_veto
    const defRep = analyzeSamples(ceF24.samples, ceF24.sampleRate, { label: "f24_default" });
    assert.equal(defRep.policy, "core_veto");
    assert.equal(defRep.verdict, "SURVIVED_KAWAII_CANDIDATE");
    assert.equal(defRep.triggeredCount, 0);
    assert.ok(defRep.diagnosticCount >= 1);
    const f24Res = defRep.falsifiers.find((f) => f.id === "F24_CALCULATED_PITCH_LFO");
    assert.equal(f24Res.triggered, true);
    assert.equal(f24Res.diagnostic, true);

    // Explicit veto_all rejects the same clip
    const strictRep = analyzeSamples(ceF24.samples, ceF24.sampleRate, {
      label: "f24_veto_all",
      policy: "veto_all",
    });
    assert.equal(strictRep.policy, "veto_all");
    assert.equal(strictRep.verdict, "REJECTED_UNKAWAII");
    assert.ok(strictRep.triggeredCount >= 1);
  });

  it("v0.4 policy: 'shelf_veto' suspends veto on contestedIds from auditFalsifiersAgainstShelf (including core F5)", () => {
    const cleanVoice = makeWarmVoice(0.65, 505);
    // Loved staccato/short-tail voice: warm voice with abrupt cut-off tail (triggers core F5_ABRUPT_TAIL)
    const shortTail = new Float32Array(cleanVoice.length);
    const cutIdx = Math.round(SR * 0.45);
    for (let i = 0; i < cutIdx; i++) {
      const t = i / SR;
      const atk = t < 0.08 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.08) : 1;
      const env = smoothEnv(t, 0.65, 0.08, 0.17);
      shortTail[i] = env > 0.01 ? (cleanVoice[i] / env) * atk * 0.42 : 0;
    }

    const audit = auditFalsifiersAgainstShelf([
      { id: "loved_clean", label: "Loved Clean", samples: cleanVoice, sampleRate: SR },
      { id: "loved_staccato", label: "Loved Staccato", samples: shortTail, sampleRate: SR },
    ]);
    assert.ok(
      audit.contestedIds.includes("F5_ABRUPT_TAIL"),
      `Expected F5_ABRUPT_TAIL in contestedIds, got ${JSON.stringify(audit.contestedIds)}`
    );

    // Under core_veto, F5_ABRUPT_TAIL rejects shortTail
    const coreRep = analyzeSamples(shortTail, SR, { label: "staccato_core", policy: "core_veto" });
    assert.equal(coreRep.verdict, "REJECTED_UNKAWAII");

    // Under shelf_veto with audit.contestedIds (Array or Set), F5_ABRUPT_TAIL veto is suspended -> SURVIVED_KAWAII_CANDIDATE
    for (const contestedInput of [audit.contestedIds, new Set(audit.contestedIds)]) {
      const shelfRep = analyzeSamples(shortTail, SR, {
        label: "staccato_shelf",
        policy: "shelf_veto",
        contestedIds: contestedInput,
      });
      assert.equal(shelfRep.policy, "shelf_veto");
      assert.equal(shelfRep.verdict, "SURVIVED_KAWAII_CANDIDATE");
      assert.equal(shelfRep.triggeredCount, 0);
      assert.ok(shelfRep.diagnosticCount >= 1);
      const f5Res = shelfRep.falsifiers.find((f) => f.id === "F5_ABRUPT_TAIL");
      assert.equal(f5Res.triggered, true);
      assert.equal(f5Res.diagnostic, true);
      assert.equal(f5Res.contested, true);
    }

    const shelfRep = analyzeSamples(shortTail, SR, {
      label: "staccato_shelf",
      policy: "shelf_veto",
      contestedIds: audit.contestedIds,
    });

    const llmText = formatForLLM(shelfRep);
    assert.ok(llmText.includes("policy=shelf_veto"));
    assert.ok(llmText.includes("[CONTESTED]"));

    // Non-contested axis (e.g. F6_PHYSICAL_GLITCH on clipped audio) MUST still veto under shelf_veto
    const clipped = new Float32Array(Math.round(SR * 0.5));
    for (let i = 0; i < clipped.length; i++) {
      clipped[i] = Math.max(-1, Math.min(1, 3.0 * Math.sin((2 * Math.PI * 300 * i) / SR)));
    }
    const clippedShelfRep = analyzeSamples(clipped, SR, {
      label: "clipped_shelf",
      policy: "shelf_veto",
      contestedIds: audit.contestedIds,
    });
    assert.equal(clippedShelfRep.verdict, "REJECTED_UNKAWAII");
    assert.ok(clippedShelfRep.triggeredCount >= 1);
  });

  it("CLI defaults to --policy core_veto and supports veto_all and shelf_veto with --contested", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yata-policy-"));
    try {
      const cleanVoice = makeWarmVoice(0.65, 303);
      const subBassOnly = new Float32Array(cleanVoice.length);
      for (let i = 0; i < cleanVoice.length; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.08, 0.17);
        subBassOnly[i] = 0.5 * cleanVoice[i] + 0.42 * env * Math.sin(2 * Math.PI * 45 * t);
      }

      const wavPath = path.join(tmpDir, "sub_only.wav");
      fs.writeFileSync(wavPath, encodeWavBuffer(subBassOnly, SR));

      const cliPath = path.resolve("unkawaii_detector.mjs");
      // Default CLI policy is core_veto
      const outDefault = execFileSync(
        process.execPath,
        [cliPath, wavPath, "--format", "json"],
        { encoding: "utf8" }
      );
      const parsedDefault = JSON.parse(outDefault);
      assert.equal(parsedDefault.policy, "core_veto");
      assert.equal(parsedDefault.verdict, "SURVIVED_KAWAII_CANDIDATE");
      assert.equal(parsedDefault.triggeredCount, 0);
      assert.ok(parsedDefault.diagnosticCount >= 1);

      const outAll = execFileSync(
        process.execPath,
        [cliPath, wavPath, "--policy", "veto_all", "--format", "json"],
        { encoding: "utf8" }
      );
      const parsedAll = JSON.parse(outAll);
      assert.equal(parsedAll.policy, "veto_all");
      assert.equal(parsedAll.verdict, "REJECTED_UNKAWAII");

      // shelf_veto with --contested F13_SUBBASS_RUMBLE suspends F13 veto
      const triggeredIds = parsedAll.falsifiers.filter((f) => f.triggered).map((f) => f.id);
      const outShelf = execFileSync(
        process.execPath,
        [
          cliPath,
          wavPath,
          "--policy",
          "shelf_veto",
          "--contested",
          triggeredIds.join(","),
          "--format",
          "json",
        ],
        { encoding: "utf8" }
      );
      const parsedShelf = JSON.parse(outShelf);
      assert.equal(parsedShelf.policy, "shelf_veto");
      assert.equal(parsedShelf.verdict, "SURVIVED_KAWAII_CANDIDATE");
      assert.equal(parsedShelf.triggeredCount, 0);
      assert.ok(parsedShelf.diagnosticCount >= 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("v0.5: loadEarPrecedents & --shelf enforce scope matching and include provenance in tags", () => {
    const precPath = path.resolve("bench/real_audio_audit/ear_precedents.json");
    const precedents = loadEarPrecedents(precPath);
    assert.ok(precedents.precedents.F24_CALCULATED_PITCH_LFO);
    assert.equal(precedents.precedents.F24_CALCULATED_PITCH_LFO.status, "ear_overruled");
    assert.equal(precedents.precedents.F24_CALCULATED_PITCH_LFO.testedCommit, "245ed15");
    assert.equal(precedents.precedents.F30_STEREO_PHASE_DISCOMFORT.status, "orthogonal");

    const corpus = buildCorpus({ sampleRate: SR, seed: 2026 });
    const ceF24 = corpus.counterexamples.find((x) => x.id === "ce_F24");
    assert.ok(ceF24);

    // Without matching scope (e.g. bird_calls or omitted), tokiko_japanese_speech precedent MUST NOT leak onto F24
    const unscopedRep = analyzeSamples(ceF24.samples, ceF24.sampleRate, {
      label: "ce_f24_unscoped",
      precedents,
    });
    assert.equal(
      unscopedRep.falsifiers.find((f) => f.id === "F24_CALCULATED_PITCH_LFO").earPrecedentTag,
      undefined
    );
    // Meanwhile general_audio precedent (F30) STILL applies even without --scope
    assert.equal(
      unscopedRep.falsifiers.find((f) => f.id === "F30_STEREO_PHASE_DISCOMFORT").earPrecedentTag,
      "[ORTHOGONAL (fefbc73)]"
    );

    const birdRep = analyzeSamples(ceF24.samples, ceF24.sampleRate, {
      label: "ce_f24_bird",
      precedents,
      scope: "bird_calls",
    });
    assert.equal(
      birdRep.falsifiers.find((f) => f.id === "F24_CALCULATED_PITCH_LFO").earPrecedentTag,
      undefined
    );

    // With matching scope ("tokiko_japanese_speech"), F24 gets annotated with scope + commit provenance
    const rep = analyzeSamples(ceF24.samples, ceF24.sampleRate, {
      label: "ce_f24_prec",
      precedents,
      scope: "tokiko_japanese_speech",
    });
    const f24 = rep.falsifiers.find((f) => f.id === "F24_CALCULATED_PITCH_LFO");
    assert.equal(f24.triggered, true);
    assert.equal(f24.earPrecedentTag, "[EAR-OVERRULED 5-0 @ tokiko_japanese_speech (245ed15)]");

    const llmText = formatForLLM(rep);
    assert.ok(llmText.includes("F24_CALCULATED_PITCH_LFO"), "Expected F24 in LLM output");
    assert.ok(
      llmText.includes("[EAR-OVERRULED 5-0 @ tokiko_japanese_speech (245ed15)]"),
      `Expected scoped provenance tag in formatForLLM output, got:\n${llmText}`
    );

    // Standalone applyEarPrecedents non-mutating check
    const rawRep = analyzeSamples(ceF24.samples, ceF24.sampleRate, { label: "raw" });
    const annotated = applyEarPrecedents(rawRep, precedents, { scope: "tokiko_japanese_speech" });
    assert.equal(
      rawRep.falsifiers.find((f) => f.id === "F24_CALCULATED_PITCH_LFO").earPrecedentTag,
      undefined
    );
    assert.equal(
      annotated.falsifiers.find((f) => f.id === "F24_CALCULATED_PITCH_LFO").earPrecedentTag,
      "[EAR-OVERRULED 5-0 @ tokiko_japanese_speech (245ed15)]"
    );

    // CLI --shelf + --scope flags
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yata-prec-"));
    try {
      const wavPath = path.join(tmpDir, "ce_f24.wav");
      fs.writeFileSync(wavPath, encodeWavBuffer(ceF24.samples, ceF24.sampleRate));
      const cliPath = path.resolve("unkawaii_detector.mjs");

      // Unscoped CLI MUST NOT leak tokiko precedent onto F24
      const cliUnscoped = execFileSync(
        process.execPath,
        [cliPath, wavPath, "--shelf", precPath],
        { encoding: "utf8" }
      );
      assert.ok(
        !cliUnscoped.includes("EAR-OVERRULED"),
        `Did not expect scoped tokiko precedent without --scope, got:\n${cliUnscoped}`
      );

      // Scoped CLI MUST annotate F24 with provenance
      const cliScoped = execFileSync(
        process.execPath,
        [cliPath, wavPath, "--shelf", precPath, "--scope", "tokiko_japanese_speech"],
        { encoding: "utf8" }
      );
      assert.ok(
        cliScoped.includes("[EAR-OVERRULED 5-0 @ tokiko_japanese_speech (245ed15)]"),
        `Expected scoped provenance tag in CLI --shelf --scope output, got:\n${cliScoped}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
