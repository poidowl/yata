import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { analyzeSamples, formatForLLM, ORIGINAL_6_FALSIFIERS, buildCorpus } from "../unkawaii_detector.mjs";
import { QUARANTINED, TOKIKO_DERIVED } from "../src/falsifiers/gate.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const AUD = path.join(ROOT, "bench/real_audio_audit");
const json = (f) => JSON.parse(fs.readFileSync(path.join(AUD, f), "utf8"));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.m?js$/.test(e.name) ? [path.join(d, e.name)] : []);

describe("real-voice gate tags", () => {
  it("core-6 are never gated; gate tags never decide the verdict", () => {
    for (const f of ORIGINAL_6_FALSIFIERS) assert.ok(!QUARANTINED[f.id] && !TOKIKO_DERIVED[f.id], f.id);
    const sr = 24000, x = Float32Array.from({ length: sr }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 300 * i) / sr) * Math.min(1, i / 2000, (sr - i) / 4000));
    const r = analyzeSamples(x, sr);
    for (const f of r.falsifiers) if (f.gate) assert.ok(!f.triggered || f.diagnostic, `${f.id} gated but vetoing`);
    const q = r.falsifiers.filter((f) => f.triggered && f.diagnostic && f.gate?.tag === "quarantined");
    assert.equal(r.quarantinedCount, q.length);
    const txt = formatForLLM(r);
    for (const f of q) assert.ok(!txt.includes(f.id), `quarantined ${f.id} leaked into default text`);
    const qid = Object.keys(QUARANTINED)[0];
    if (qid) {
      const forced = { ...r, falsifiers: r.falsifiers.map((f) => (f.id === qid ? { ...f, triggered: true, diagnostic: true, score: 1, gate: { tag: "quarantined", note: "t" } } : f)) };
      const t2 = formatForLLM(forced);
      assert.ok(!t2.includes(qid) && /QUARANTINED: \d+ hidden/.test(t2), "forced quarantined id must be hidden and counted");
    }
  });
});

describe("held-out hygiene", () => {
  const ho = json("heldout_pd_cc0_manifest.json").clips, tu = json("tuning_pd_cc0_manifest.json").clips;
  it("held-out and tuning ids/sources are disjoint; every clip has trim + SHA + PD/CC0 license", () => {
    const hoSrc = new Set(ho.map((c) => c.sourceUrl));
    for (const c of tu) assert.ok(!hoSrc.has(c.sourceUrl) && !ho.some((h) => h.id === c.id || h.id === c.formerId), c.id);
    for (const c of [...ho, ...tu]) {
      assert.ok(Number.isFinite(c.trimStartSec) && Number.isFinite(c.trimDurationSec), `${c.id} trim`);
      assert.match(c.sourceSha256 || "", /^[0-9a-f]{64}$/, `${c.id} sourceSha256`);
      assert.match(c.license, /^(public domain|cc0)/i, `${c.id} license`);
      assert.doesNotMatch(`${c.license} ${c.sourceUrl}`, /\bBY\b|\bSA\b|voicevox/i, c.id);
    }
  });
  it("no held-out clip id or source file name appears in threshold code or tests (best effort)", () => {
    const keys = ho.flatMap((c) => [c.id, decodeURIComponent(c.sourceUrl.split("/").pop()).replace(/\.\w+$/, "")]);
    const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "test")).filter((f) => !f.endsWith("gate.test.mjs"))];
    for (const f of files) {
      const s = fs.readFileSync(f, "utf8");
      for (const k of keys) assert.ok(!s.includes(k), `held-out key "${k}" found in ${path.relative(ROOT, f)}: move that clip to tuning`);
    }
  });
});

describe("pass-side references are synthetic or PD/CC0 (no VOICEVOX)", () => {
  it("synthetic positive controls trip none of F33+", () => {
    for (const p of buildCorpus({ sampleRate: 24000, seed: 2026 }).positives) {
      const r = analyzeSamples(p.samples, p.sampleRate, p.channels ? { channels: p.channels } : {});
      const hit = r.falsifiers.filter((f) => f.triggered && +f.id.slice(1).split("_")[0] >= 33).map((f) => f.id);
      assert.deepEqual(hit, [], `${p.id}: ${hit.join(",")}`);
    }
  });
});
