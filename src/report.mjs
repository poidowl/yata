/**
 * src/report.mjs — Multidimensional Unkawaii Report & Token-Efficient LLM Formatter
 *
 * Exports:
 *   - analyzeSamples(samples, sampleRate, options = {})
 *   - compareReports(reportA, reportB)  (ID-safe lookup)
 *   - formatForLLM(report, opts = { verbose: false })
 *   - formatCompareForLLM(cmp, opts = { verbose: false })
 *
 * Zero external dependencies. Pure ES Module.
 */

import { extractFeatures, extractAudioProfile } from "./features.mjs";
import { DEFAULT_FALSIFIERS } from "./falsifiers/index.mjs";

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function round3(x) {
  return Math.round(clamp01(x) * 1000) / 1000;
}

function formatWhere(where) {
  if (!where || typeof where !== "object") return "";
  const parts = [];
  if (Number.isFinite(where.startSec) && Number.isFinite(where.endSec)) {
    parts.push(`${where.startSec}..${where.endSec}s`);
  } else if (Number.isFinite(where.startSec)) {
    parts.push(`@${where.startSec}s`);
  }
  if (Number.isFinite(where.freqHz) && where.freqHz > 0) {
    parts.push(`${Math.round(where.freqHz)}Hz`);
  }
  return parts.length ? ` [${parts.join(", ")}]` : "";
}

/**
 * Analyze raw audio samples across all configured falsifiers.
 *
 * @param {Float32Array|ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {{
 *   label?: string,
 *   falsifiers?: readonly Array<object>,
 *   channels?: Float32Array[],
 *   includeProfile?: boolean,
 *   thresholds?: Record<string, number | Record<string, number>>
 * }} [options={}]
 */
export function analyzeSamples(samples, sampleRate, options = {}) {
  const label = options.label || "untitled";
  const falsifiers = options.falsifiers || DEFAULT_FALSIFIERS;
  const featOpts = options.channels ? { channels: options.channels } : {};
  const features = extractFeatures(samples, sampleRate, featOpts);
  const thresholds = options.thresholds && typeof options.thresholds === "object" ? options.thresholds : null;

  const results = falsifiers.map((fn) => {
    const override =
      thresholds && Object.prototype.hasOwnProperty.call(thresholds, fn.id)
        ? thresholds[fn.id]
        : undefined;
    const out = fn.detect(features, override) || {};
    const entry = {
      id: fn.id,
      domain: fn.domain,
      name: fn.name,
      triggered: Boolean(out.triggered),
      score: round3(out.score),
      threshold: Number.isFinite(out.threshold) ? out.threshold : 0.5,
      evidence: typeof out.evidence === "string" ? out.evidence : "",
      hint: typeof out.hint === "string" ? out.hint : "",
    };
    if (out.where && typeof out.where === "object") {
      entry.where = out.where;
    }
    return entry;
  });

  const triggered = results.filter((r) => r.triggered);
  const survived = triggered.length === 0;

  const report = {
    schema: "unkawaii_report/v0.2",
    label,
    verdict: survived ? "SURVIVED_KAWAII_CANDIDATE" : "REJECTED_UNKAWAII",
    triggeredCount: triggered.length,
    totalFalsifiers: results.length,
    mirrorSummary: survived
      ? "Mirror clear: failed to detect any 'do-not-want-to-be-with' signature across all dimensions."
      : `Mirror reflects: ${triggered.map((t) => `${t.id} (${t.name})`).join("; ")}.`,
    features,
    falsifiers: results,
  };

  if (options.includeProfile) {
    report.profile = extractAudioProfile(samples, sampleRate, featOpts);
  }

  return report;
}

/**
 * ID-safe comparison between two reports (handles different ordering or subsets of falsifiers).
 *
 * @param {object} reportA
 * @param {object} reportB
 */
export function compareReports(reportA, reportB) {
  const listA = Array.isArray(reportA?.falsifiers) ? reportA.falsifiers : [];
  const listB = Array.isArray(reportB?.falsifiers) ? reportB.falsifiers : [];

  const mapA = new Map();
  for (const fa of listA) mapA.set(fa.id, fa);

  const mapB = new Map();
  for (const fb of listB) mapB.set(fb.id, fb);

  const orderedIds = [];
  const seen = new Set();
  for (const fa of listA) {
    if (!seen.has(fa.id)) {
      seen.add(fa.id);
      orderedIds.push(fa.id);
    }
  }
  for (const fb of listB) {
    if (!seen.has(fb.id)) {
      seen.add(fb.id);
      orderedIds.push(fb.id);
    }
  }

  const deltas = orderedIds.map((id) => {
    const fa = mapA.get(id) || null;
    const fb = mapB.get(id) || null;
    return {
      id,
      name: fa ? fa.name : fb.name,
      domain: fa ? fa.domain : fb.domain,
      aScore: fa ? fa.score : null,
      bScore: fb ? fb.score : null,
      deltaBMinusA: fa && fb ? +(fb.score - fa.score).toFixed(3) : null,
      aTriggered: fa ? fa.triggered : null,
      bTriggered: fb ? fb.triggered : null,
    };
  });

  return {
    schema: "unkawaii_compare/v0.2",
    a: {
      label: reportA?.label ?? "A",
      verdict: reportA?.verdict ?? "UNKNOWN",
      triggeredCount: reportA?.triggeredCount ?? 0,
      totalFalsifiers: reportA?.totalFalsifiers ?? listA.length,
    },
    b: {
      label: reportB?.label ?? "B",
      verdict: reportB?.verdict ?? "UNKNOWN",
      triggeredCount: reportB?.triggeredCount ?? 0,
      totalFalsifiers: reportB?.totalFalsifiers ?? listB.length,
    },
    deltas,
  };
}

/**
 * Token-efficient LLM report formatter.
 * By default (`verbose: false`), emits a compact triggered-first summary.
 * When `verbose: true`, emits all dimensions.
 *
 * @param {object} report
 * @param {{ verbose?: boolean }} [opts={ verbose: false }]
 */
export function formatForLLM(report, opts = { verbose: false }) {
  const verbose = Boolean(opts?.verbose);
  const f = report.features || {};
  const lines = [
    `[UNKAWAII REPORT] ${report.label}`,
    `VERDICT: ${report.verdict} (${report.triggeredCount}/${report.totalFalsifiers} falsifiers triggered)`,
    `MIRROR: ${report.mirrorSummary}`,
    `OBSERVABLES: dur=${f.durationSec}s | atk=${f.maxAttackSlope} | hf=${f.meanHfRatio} | voiced=${f.voicedRatio} | f0=${f.medianF0 ?? 0}Hz | hnr=${f.meanVoicedHnrDb ?? 0}dB | rough=${f.meanRoughness ?? 0} | tail=${f.tailDecaySec}s`,
  ];

  const all = Array.isArray(report.falsifiers) ? report.falsifiers : [];

  if (verbose) {
    lines.push("DIMENSIONS:");
    for (const dim of all) {
      const mark = dim.triggered ? "TRIGGERED" : "clear    ";
      lines.push(
        `  - [${mark}] ${dim.id}${formatWhere(dim.where)} (score=${dim.score}, thr=${dim.threshold}) | ${dim.evidence}`
      );
      if (dim.triggered && dim.hint) {
        lines.push(`      hint: ${dim.hint}`);
      }
    }
    return lines.join("\n");
  }

  // Compact triggered-first summary
  const triggered = all.filter((d) => d.triggered).sort((a, b) => b.score - a.score);
  const clearCount = all.length - triggered.length;

  if (triggered.length === 0) {
    lines.push(`TRIGGERED: none (all ${all.length} dimensions clear)`);
    const nearMiss = all
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (nearMiss.length > 0) {
      lines.push(
        `NEAREST: ${nearMiss.map((d) => `${d.id}=${d.score}/${d.threshold}`).join(" | ")}`
      );
    }
  } else {
    lines.push("TRIGGERED:");
    for (const dim of triggered) {
      lines.push(
        `  - ${dim.id}${formatWhere(dim.where)} (score=${dim.score}, thr=${dim.threshold}) | ${dim.evidence}`
      );
      if (dim.hint) {
        lines.push(`      hint: ${dim.hint}`);
      }
    }
    lines.push(`CLEAR: ${clearCount}/${all.length} dimensions clear (pass { verbose: true } for full dump)`);
  }

  return lines.join("\n");
}

/**
 * Token-efficient LLM comparison formatter.
 *
 * @param {object} cmp
 * @param {{ verbose?: boolean }} [opts={ verbose: false }]
 */
export function formatCompareForLLM(cmp, opts = { verbose: false }) {
  const verbose = Boolean(opts?.verbose);
  const lines = [
    `[UNKAWAII COMPARE] A="${cmp.a.label}" vs B="${cmp.b.label}"`,
    `A: ${cmp.a.verdict} (${cmp.a.triggeredCount} triggered)`,
    `B: ${cmp.b.verdict} (${cmp.b.triggeredCount} triggered)`,
    `DELTAS (B - A; positive = B is MORE unkawaii on that axis):`,
  ];

  const deltas = Array.isArray(cmp.deltas) ? cmp.deltas : [];
  if (verbose) {
    for (const d of deltas) {
      const sign = d.deltaBMinusA !== null && d.deltaBMinusA > 0 ? "+" : "";
      const deltaStr = d.deltaBMinusA !== null ? `${sign}${d.deltaBMinusA}` : "n/a";
      lines.push(
        `  - ${d.id}: A=${d.aScore ?? "n/a"}${d.aTriggered ? "*" : ""} -> B=${d.bScore ?? "n/a"}${d.bTriggered ? "*" : ""} (${deltaStr})`
      );
    }
    return lines.join("\n");
  }

  const notable = deltas
    .filter(
      (d) =>
        d.aTriggered !== d.bTriggered ||
        (d.deltaBMinusA !== null && Math.abs(d.deltaBMinusA) >= 0.05) ||
        d.deltaBMinusA === null
    )
    .sort((a, b) => Math.abs(b.deltaBMinusA ?? 0) - Math.abs(a.deltaBMinusA ?? 0));

  if (notable.length === 0) {
    lines.push(`  (no significant deltas across ${deltas.length} dimensions)`);
  } else {
    for (const d of notable) {
      const sign = d.deltaBMinusA !== null && d.deltaBMinusA > 0 ? "+" : "";
      const deltaStr = d.deltaBMinusA !== null ? `${sign}${d.deltaBMinusA}` : "n/a";
      lines.push(
        `  - ${d.id}: A=${d.aScore ?? "n/a"}${d.aTriggered ? "*" : ""} -> B=${d.bScore ?? "n/a"}${d.bTriggered ? "*" : ""} (${deltaStr})`
      );
    }
    const quiet = deltas.length - notable.length;
    if (quiet > 0) {
      lines.push(`  (${quiet} unchanged dimensions omitted; pass { verbose: true } for all)`);
    }
  }

  return lines.join("\n");
}
