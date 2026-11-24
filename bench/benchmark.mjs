#!/usr/bin/env node
/**
 * bench/benchmark.mjs — Detection Matrix & Throughput Benchmark
 *
 * Verifies:
 *   - 0 false positives across all diverse positive controls (SURVIVED_KAWAII_CANDIDATE 0/32)
 *   - 26/26 targeted counterexamples (ce_F7..ce_F32) trigger their target falsifier
 *   - Slip-through capture improvement: ORIGINAL_6_FALSIFIERS -> DEFAULT_FALSIFIERS
 *   - Analysis latency and real-time throughput (RTF)
 *
 * Zero external dependencies. Pure ES Module.
 */

import { performance } from "node:perf_hooks";
import {
  buildCorpus,
  analyzeSamples,
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
} from "../unkawaii_detector.mjs";

const SR = 24000;
const SEED = 2026;

const tBuild0 = performance.now();
const corpus = buildCorpus({ sampleRate: SR, seed: SEED });
const buildMs = performance.now() - tBuild0;

let totalAudioSec = 0;
let totalAnalyzeMs = 0;

// 1. Positives
let posSurvived = 0;
const posFailures = [];
console.log("=== POSITIVE CONTROLS (must survive 0/32) ===");
for (const item of corpus.positives) {
  totalAudioSec += item.samples.length / item.sampleRate;
  const t0 = performance.now();
  const rep = analyzeSamples(item.samples, item.sampleRate, {
    label: item.id,
    falsifiers: DEFAULT_FALSIFIERS,
    policy: "veto_all",
    ...(item.channels ? { channels: item.channels } : {}),
  });
  const dt = performance.now() - t0;
  totalAnalyzeMs += dt;

  const ok = rep.verdict === "SURVIVED_KAWAII_CANDIDATE" && rep.triggeredCount === 0;
  if (ok) {
    posSurvived++;
    console.log(`  [PASS] ${item.id.padEnd(20)} 0/32  (${dt.toFixed(1)} ms)`);
  } else {
    const trig = rep.falsifiers.filter((f) => f.triggered).map((f) => `${f.id}(${f.score})`).join(", ");
    posFailures.push(`${item.id}: ${trig}`);
    console.log(`  [FAIL] ${item.id.padEnd(20)} ${rep.triggeredCount}/32 [${trig}]  (${dt.toFixed(1)} ms)`);
  }
}

// 2. Counterexamples F7..F32
let core6Caught = 0;
let all32Caught = 0;
let targetHits = 0;
let cleanSlipsCaught = 0;
const ceMisses = [];

console.log("\n=== COUNTEREXAMPLES (F7..F32: ORIGINAL_6 vs DEFAULT_32) ===");
for (const item of corpus.counterexamples) {
  totalAudioSec += item.samples.length / item.sampleRate;
  const chOpt = item.channels ? { channels: item.channels } : {};

  const rep6 = analyzeSamples(item.samples, item.sampleRate, {
    label: item.id,
    falsifiers: ORIGINAL_6_FALSIFIERS,
    policy: "veto_all",
    ...chOpt,
  });
  const t0 = performance.now();
  const rep32 = analyzeSamples(item.samples, item.sampleRate, {
    label: item.id,
    falsifiers: DEFAULT_FALSIFIERS,
    policy: "veto_all",
    ...chOpt,
  });
  const dt = performance.now() - t0;
  totalAnalyzeMs += dt;

  const c6 = rep6.verdict === "REJECTED_UNKAWAII";
  const c32 = rep32.verdict === "REJECTED_UNKAWAII";
  const target = rep32.falsifiers.find((f) => f.id === item.targetFalsifier);
  const hit = Boolean(target?.triggered);

  if (c6) core6Caught++;
  if (c32) all32Caught++;
  if (hit) targetHits++;
  if (!c6 && hit) cleanSlipsCaught++;
  if (!hit) ceMisses.push(`${item.id} (${item.targetFalsifier})`);

  const tag = hit ? (!c6 ? "SLIP->CAUGHT" : "CAUGHT      ") : "MISS        ";
  console.log(
    `  [${tag}] ${item.id.padEnd(6)} ${item.targetFalsifier.padEnd(28)} core6=${rep6.triggeredCount} all32=${rep32.triggeredCount} score=${(target?.score ?? 0).toFixed(3)} (${dt.toFixed(1)} ms)`
  );
}

// 3. Legacy Negatives
let legHits = 0;
console.log("\n=== LEGACY NEGATIVES (Katakana & Core F1..F6) ===");
for (const item of corpus.legacyNegatives) {
  totalAudioSec += item.samples.length / item.sampleRate;
  const t0 = performance.now();
  const rep32 = analyzeSamples(item.samples, item.sampleRate, {
    label: item.id,
    falsifiers: DEFAULT_FALSIFIERS,
    policy: "veto_all",
  });
  const dt = performance.now() - t0;
  totalAnalyzeMs += dt;
  const hit = Boolean(rep32.falsifiers.find((f) => f.id === item.targetFalsifier)?.triggered);
  if (hit) legHits++;
  console.log(
    `  [${hit ? "HIT " : "MISS"}] ${item.id.padEnd(16)} ${item.targetFalsifier.padEnd(24)} all32=${rep32.triggeredCount} (${dt.toFixed(1)} ms)`
  );
}

const totalItems = corpus.positives.length + corpus.counterexamples.length + corpus.legacyNegatives.length;
const avgMs = totalAnalyzeMs / Math.max(1, totalItems);
const rtf = (totalAnalyzeMs / 1000) / Math.max(1e-6, totalAudioSec);

console.log("\n=== SUMMARY ===");
console.log(`  Corpus synthesis time : ${buildMs.toFixed(1)} ms (${totalItems} clips, ${totalAudioSec.toFixed(2)}s audio)`);
console.log(`  Analysis throughput   : ${totalAnalyzeMs.toFixed(1)} ms total | ${avgMs.toFixed(1)} ms/clip | RTF=${rtf.toFixed(3)}x`);
console.log(`  Positives survived    : ${posSurvived}/${corpus.positives.length} (false positives: ${posFailures.length})`);
console.log(`  Counterexamples F7-32 : targetHits=${targetHits}/${corpus.counterexamples.length} | core6=${core6Caught} -> all32=${all32Caught} | clean slip-throughs caught=${cleanSlipsCaught}`);
console.log(`  Legacy negatives      : ${legHits}/${corpus.legacyNegatives.length} target hits`);

if (posFailures.length > 0 || ceMisses.length > 0) {
  console.error("\nBENCHMARK FAILED:");
  if (posFailures.length) console.error("  False positives:", posFailures.join("; "));
  if (ceMisses.length) console.error("  Missed targets:", ceMisses.join("; "));
  process.exit(1);
}
