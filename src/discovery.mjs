/**
 * src/discovery.mjs — Counterexample Discovery & LLM Visual Inspection Loop
 *
 * Evaluates the deterministic synthetic corpus against ORIGINAL_6_FALSIFIERS (v0.1)
 * vs DEFAULT_FALSIFIERS (v0.2 32-axis), identifies slip-throughs and false positives,
 * and builds compact LLM-friendly audio-vision dossiers.
 *
 * Zero external dependencies. Pure ES Module.
 */

import { buildCorpus } from "./synth.mjs";
import { ORIGINAL_6_FALSIFIERS, DEFAULT_FALSIFIERS } from "./falsifiers/index.mjs";
import { analyzeSamples } from "./report.mjs";
import { extractAudioProfile } from "./features.mjs";
import { renderTextVision } from "./visualize/index.mjs";

/**
 * Run the counterexample discovery & verification loop.
 *
 * @param {{
 *   sampleRate?: number,
 *   seed?: number,
 *   includeDossiers?: boolean,
 *   maxDossiers?: number,
 *   viewMode?: "micro"|"compact"|"full",
 *   charset?: "ascii"|"unicode",
 *   coreFalsifiers?: readonly Array<object>,
 *   fullFalsifiers?: readonly Array<object>
 * }} [opts={}]
 */
export function runDiscoveryLoop(opts = {}) {
  const sampleRate = opts?.sampleRate ?? 24000;
  const seed = opts?.seed ?? 2026;
  const includeDossiers = opts?.includeDossiers !== false;
  const maxDossiers = Number.isFinite(opts?.maxDossiers) ? opts.maxDossiers : 26;
  const viewMode = opts?.viewMode || "micro";
  const charset = opts?.charset || "ascii";
  const coreFalsifiers = opts?.coreFalsifiers || ORIGINAL_6_FALSIFIERS;
  const fullFalsifiers = opts?.fullFalsifiers || DEFAULT_FALSIFIERS;

  const corpus = buildCorpus({ sampleRate, seed });

  // 1. Evaluate positives (must survive 0/32)
  let positivesSurvived = 0;
  const falsePositives = [];
  const positiveResults = [];
  for (const item of corpus.positives) {
    const chOpt = item.channels ? { channels: item.channels } : {};
    const repAll = analyzeSamples(item.samples, item.sampleRate, {
      label: item.id,
      falsifiers: fullFalsifiers,
      ...chOpt,
    });
    const survived = repAll.verdict === "SURVIVED_KAWAII_CANDIDATE" && repAll.triggeredCount === 0;
    if (survived) {
      positivesSurvived++;
    } else {
      falsePositives.push({
        id: item.id,
        triggeredCount: repAll.triggeredCount,
        triggeredIds: repAll.falsifiers.filter((f) => f.triggered).map((f) => f.id),
      });
    }
    positiveResults.push({
      id: item.id,
      description: item.description,
      verdict: repAll.verdict,
      triggeredCount: repAll.triggeredCount,
    });
  }

  // 2. Evaluate counterexamples (ORIGINAL_6 vs DEFAULT_32)
  let caughtByCore6 = 0;
  let caughtByAll32 = 0;
  let targetHits = 0;
  let slipThroughsFound = 0;
  let caughtByNewFalsifiers = 0;

  const perFalsifier = [];
  const dossiers = [];

  for (const item of corpus.counterexamples) {
    const chOpt = item.channels ? { channels: item.channels } : {};
    const repCore = analyzeSamples(item.samples, item.sampleRate, {
      label: item.id,
      falsifiers: coreFalsifiers,
      ...chOpt,
    });
    const repAll = analyzeSamples(item.samples, item.sampleRate, {
      label: item.id,
      falsifiers: fullFalsifiers,
      ...chOpt,
    });

    const coreCaught = repCore.verdict === "REJECTED_UNKAWAII";
    const allCaught = repAll.verdict === "REJECTED_UNKAWAII";
    const targetRes = repAll.falsifiers.find((f) => f.id === item.targetFalsifier) || null;
    const targetHit = Boolean(targetRes?.triggered);
    const slippedCore6 = !coreCaught;

    if (coreCaught) caughtByCore6++;
    if (allCaught) caughtByAll32++;
    if (targetHit) targetHits++;
    if (slippedCore6) slipThroughsFound++;
    if (slippedCore6 && allCaught) caughtByNewFalsifiers++;

    const triggeredIds = repAll.falsifiers.filter((f) => f.triggered).map((f) => f.id);
    perFalsifier.push({
      id: item.targetFalsifier,
      domain: targetRes?.domain ?? "unknown",
      name: targetRes?.name ?? item.targetFalsifier,
      counterexampleId: item.id,
      slippedCore6,
      caughtByAll32: allCaught,
      targetHit,
      score: targetRes?.score ?? 0,
      threshold: targetRes?.threshold ?? 0.5,
      evidence: targetRes?.evidence ?? "",
      triggeredIds,
    });

    if (includeDossiers && dossiers.length < maxDossiers) {
      const profile = extractAudioProfile(item.samples, item.sampleRate, chOpt);
      const textVision = renderTextVision(profile, repAll, {
        mode: viewMode,
        charset,
        width: 48,
        specRows: 6,
      });
      dossiers.push({
        id: item.id,
        targetFalsifier: item.targetFalsifier,
        description: item.description,
        slippedCore6,
        core6Triggered: repCore.triggeredCount,
        all32Triggered: repAll.triggeredCount,
        targetHit,
        triggeredIds,
        textVision,
      });
    }
  }

  // 3. Evaluate legacy negatives
  let legacyCaughtByAll32 = 0;
  for (const item of corpus.legacyNegatives) {
    const repAll = analyzeSamples(item.samples, item.sampleRate, {
      label: item.id,
      falsifiers: fullFalsifiers,
    });
    if (repAll.verdict === "REJECTED_UNKAWAII") legacyCaughtByAll32++;
  }

  return {
    schema: "unkawaii_discovery/v0.2",
    sampleRate,
    seed,
    positivesSurvived,
    positivesTotal: corpus.positives.length,
    falsePositives,
    positiveResults,
    counterexamplesTotal: corpus.counterexamples.length,
    caughtByCore6,
    caughtByAll32,
    targetHits,
    slipThroughsFound,
    caughtByNewFalsifiers,
    legacyNegativesTotal: corpus.legacyNegatives.length,
    legacyCaughtByAll32,
    perFalsifier,
    dossiers,
  };
}

/**
 * Token-efficient LLM summary formatter for discovery loop results.
 *
 * @param {object} summary
 * @param {{ view?: boolean, maxViews?: number }} [opts={ view: false }]
 */
export function formatDiscoveryForLLM(summary, opts = {}) {
  const showViews = Boolean(opts?.view);
  const maxViews = Number.isFinite(opts?.maxViews) ? opts.maxViews : 6;

  const lines = [
    `[UNKAWAII DISCOVERY LOOP] seed=${summary.seed} sr=${summary.sampleRate}Hz`,
    `POSITIVES SURVIVED: ${summary.positivesSurvived}/${summary.positivesTotal} (falsePositives=${summary.falsePositives.length})`,
    `COUNTEREXAMPLES (F7-F32): targetHits=${summary.targetHits}/${summary.counterexamplesTotal} | core6Caught=${summary.caughtByCore6} -> all32Caught=${summary.caughtByAll32}`,
    `SLIP-THROUGHS CAUGHT BY NEW AXES: ${summary.caughtByNewFalsifiers}/${summary.slipThroughsFound} slipped past core6 and caught by v0.2`,
    `LEGACY NEGATIVES: ${summary.legacyCaughtByAll32}/${summary.legacyNegativesTotal} caught`,
    `PER-AXIS MATRIX:`,
  ];

  for (const row of summary.perFalsifier) {
    const slipTag = row.slippedCore6 ? "SLIP->CAUGHT" : "core6+new  ";
    const hitTag = row.targetHit ? "HIT " : "MISS";
    lines.push(
      `  - [${hitTag}|${slipTag}] ${row.id} (${row.counterexampleId}): score=${row.score}/${row.threshold} | ${row.evidence}`
    );
  }

  if (showViews && Array.isArray(summary.dossiers) && summary.dossiers.length > 0) {
    const selected = summary.dossiers.filter((d) => d.slippedCore6).slice(0, maxViews);
    lines.push("", `VISUAL DOSSIERS (top ${selected.length} slip-throughs):`);
    for (const d of selected) {
      lines.push(`--- ${d.id} (${d.targetFalsifier}) ---`, d.textVision);
    }
  }

  return lines.join("\n");
}
