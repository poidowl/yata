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
  encodeWavBuffer,
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
    assert.equal(DEFAULT_FALSIFIERS.length, 32);
    assert.ok(Array.isArray(ORTHOGONAL_AXES) && ORTHOGONAL_AXES.length >= 1);

    const f30Meta = ORTHOGONAL_AXES.find((a) => a.id === "F30_STEREO_PHASE_DISCOMFORT");
    assert.ok(f30Meta, "Expected F30_STEREO_PHASE_DISCOMFORT in ORTHOGONAL_AXES");
    assert.equal(f30Meta.status, "orthogonal");
    assert.ok(typeof f30Meta.reason === "string" && f30Meta.reason.length > 0);

    const coreIds = new Set(ORIGINAL_6_FALSIFIERS.map((f) => f.id));
    const orthoIds = new Set(ORTHOGONAL_AXES.map((a) => a.id));
    assert.equal(TOOLBOX_FALSIFIERS.length, 32 - coreIds.size - orthoIds.size);
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
    assert.equal(cleanAudit.totalFalsifiers, 32);
    assert.equal(cleanAudit.contestedCount, 0);
    assert.equal(cleanAudit.clearedCount, 32);
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

    const vetoAllRep = analyzeSamples(subBassOnly, SR, { label: "sub_veto_all" });
    assert.equal(vetoAllRep.policy, "veto_all");
    assert.equal(vetoAllRep.verdict, "REJECTED_UNKAWAII");
    assert.ok(vetoAllRep.triggeredCount >= 1);
    assert.equal(vetoAllRep.diagnosticCount, 0);

    const coreVetoRep = analyzeSamples(subBassOnly, SR, { label: "sub_core_veto", policy: "core_veto" });
    assert.equal(coreVetoRep.policy, "core_veto");
    assert.equal(coreVetoRep.verdict, "SURVIVED_KAWAII_CANDIDATE");
    assert.equal(coreVetoRep.triggeredCount, 0);
    assert.ok(coreVetoRep.diagnosticCount >= 1);

    const f13Diag = coreVetoRep.falsifiers.find((f) => f.id === "F13_SUBBASS_RUMBLE");
    assert.equal(f13Diag.triggered, true);
    assert.equal(f13Diag.diagnostic, true);

    const llmText = formatForLLM(coreVetoRep);
    assert.ok(llmText.includes("SURVIVED_KAWAII_CANDIDATE"));
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

  it("CLI supports --policy core_veto and --policy veto_all", () => {
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
      const outCore = execFileSync(
        process.execPath,
        [cliPath, wavPath, "--policy", "core_veto", "--format", "json"],
        { encoding: "utf8" }
      );
      const parsedCore = JSON.parse(outCore);
      assert.equal(parsedCore.policy, "core_veto");
      assert.equal(parsedCore.verdict, "SURVIVED_KAWAII_CANDIDATE");
      assert.equal(parsedCore.triggeredCount, 0);
      assert.ok(parsedCore.diagnosticCount >= 1);

      const outAll = execFileSync(
        process.execPath,
        [cliPath, wavPath, "--policy", "veto_all", "--format", "json"],
        { encoding: "utf8" }
      );
      const parsedAll = JSON.parse(outAll);
      assert.equal(parsedAll.policy, "veto_all");
      assert.equal(parsedAll.verdict, "REJECTED_UNKAWAII");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
