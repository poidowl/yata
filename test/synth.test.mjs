import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCorpus,
  runDiscoveryLoop,
  formatDiscoveryForLLM,
  analyzeSamples,
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
} from "../unkawaii_detector.mjs";

describe("M4A: Synthetic Corpus & Discovery Loop", () => {
  it("buildCorpus is deterministic for the same seed and sampleRate", () => {
    const a = buildCorpus({ sampleRate: 24000, seed: 2026 });
    const b = buildCorpus({ sampleRate: 24000, seed: 2026 });

    assert.equal(a.positives.length, b.positives.length);
    assert.equal(a.counterexamples.length, b.counterexamples.length);
    assert.equal(a.legacyNegatives.length, b.legacyNegatives.length);

    for (let i = 0; i < a.positives.length; i++) {
      assert.equal(a.positives[i].id, b.positives[i].id);
      assert.deepEqual(a.positives[i].samples, b.positives[i].samples);
    }
    for (let i = 0; i < a.counterexamples.length; i++) {
      assert.equal(a.counterexamples[i].id, b.counterexamples[i].id);
      assert.deepEqual(a.counterexamples[i].samples, b.counterexamples[i].samples);
    }
  });

  it("all >= 8 diverse positive controls survive 0/32 on DEFAULT_FALSIFIERS", () => {
    const corpus = buildCorpus({ sampleRate: 24000, seed: 2026 });
    assert.ok(corpus.positives.length >= 8, `Expected >= 8 positives, got ${corpus.positives.length}`);

    for (const item of corpus.positives) {
      const rep = analyzeSamples(item.samples, item.sampleRate, {
        label: item.id,
        falsifiers: DEFAULT_FALSIFIERS,
        ...(item.channels ? { channels: item.channels } : {}),
      });
      const triggered = rep.falsifiers.filter((f) => f.triggered).map((f) => `${f.id}(${f.score})`);
      assert.equal(
        rep.verdict,
        "SURVIVED_KAWAII_CANDIDATE",
        `${item.id} failed to survive: ${triggered.join(", ")}`
      );
      assert.equal(rep.triggeredCount, 0);
    }
  });

  it("all 26 counterexamples ce_F7..ce_F32 trigger their targetFalsifier and demonstrate slip-through capture", () => {
    const corpus = buildCorpus({ sampleRate: 24000, seed: 2026 });
    assert.equal(corpus.counterexamples.length, 26);

    let slippedAndCaught = 0;
    for (let i = 0; i < 26; i++) {
      const expectedNum = i + 7;
      const item = corpus.counterexamples[i];
      assert.equal(item.id, `ce_F${expectedNum}`);
      assert.ok(item.targetFalsifier.startsWith(`F${expectedNum}_`));

      const chOpt = item.channels ? { channels: item.channels } : {};
      const repCore = analyzeSamples(item.samples, item.sampleRate, {
        label: item.id,
        falsifiers: ORIGINAL_6_FALSIFIERS,
        ...chOpt,
      });
      const repAll = analyzeSamples(item.samples, item.sampleRate, {
        label: item.id,
        falsifiers: DEFAULT_FALSIFIERS,
        ...chOpt,
      });

      const targetRes = repAll.falsifiers.find((f) => f.id === item.targetFalsifier);
      assert.ok(targetRes, `Missing target falsifier ${item.targetFalsifier}`);
      assert.equal(
        targetRes.triggered,
        true,
        `${item.id} did not trigger ${item.targetFalsifier}: score=${targetRes.score}, evidence=${targetRes.evidence}`
      );
      if (repCore.verdict === "SURVIVED_KAWAII_CANDIDATE" && repAll.verdict === "REJECTED_UNKAWAII") {
        slippedAndCaught++;
      }
    }

    assert.ok(
      slippedAndCaught >= 15,
      `Expected >= 15 clean slip-throughs past ORIGINAL_6 caught by DEFAULT_32, got ${slippedAndCaught}`
    );
  });

  it("legacy negatives (ナル, ナッタ, F1-F6) trigger their target falsifiers", () => {
    const corpus = buildCorpus({ sampleRate: 24000, seed: 2026 });
    assert.ok(corpus.legacyNegatives.some((x) => x.id === "neg_naru_kata"));
    assert.ok(corpus.legacyNegatives.some((x) => x.id === "neg_natta_kata"));

    for (const item of corpus.legacyNegatives) {
      const rep = analyzeSamples(item.samples, item.sampleRate, {
        label: item.id,
        falsifiers: DEFAULT_FALSIFIERS,
      });
      assert.equal(rep.verdict, "REJECTED_UNKAWAII", `${item.id} should be rejected`);
      const target = rep.falsifiers.find((f) => f.id === item.targetFalsifier);
      assert.equal(target?.triggered, true, `${item.id} should trigger ${item.targetFalsifier}`);
    }
  });

  it("runDiscoveryLoop summarizes positives, slip-throughs, perFalsifier, and compact dossiers", () => {
    const res = runDiscoveryLoop({ sampleRate: 24000, seed: 2026, maxDossiers: 4 });
    assert.equal(res.schema, "unkawaii_discovery/v0.2");
    assert.equal(res.positivesSurvived, res.positivesTotal);
    assert.equal(res.falsePositives.length, 0);
    assert.equal(res.targetHits, 26);
    assert.equal(res.caughtByAll32, 26);
    assert.ok(res.caughtByAll32 > res.caughtByCore6);
    assert.ok(res.caughtByNewFalsifiers > 0);
    assert.equal(res.perFalsifier.length, 26);
    assert.equal(res.dossiers.length, 4);
    for (const d of res.dossiers) {
      assert.ok(typeof d.textVision === "string" && d.textVision.trim().length > 0);
    }

    const llmText = formatDiscoveryForLLM(res, { view: true, maxViews: 2 });
    assert.match(llmText, /UNKAWAII DISCOVERY LOOP/);
    assert.match(llmText, /VISUAL DOSSIERS/);
  });
});
