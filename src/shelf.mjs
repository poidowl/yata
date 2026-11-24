/**
 * src/shelf.mjs — Protected Shelf ("落ちたけど、この音は残したい"棚) Audit Engine
 *
 * Audits every falsifier axis against a shelf of loved/protected sounds.
 * Any axis that falsely rejects >= 1 protected shelf item is formally marked
 * "CONTESTED" (its veto power is contested until calibrated or moved to toolbox).
 *
 * Exports:
 *   - auditFalsifiersAgainstShelf(shelfItems, falsifiers = DEFAULT_FALSIFIERS)
 *   - formatShelfAuditForLLM(audit)
 *
 * Zero external dependencies. Pure ES Module.
 */

import {
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
  ORTHOGONAL_AXES,
} from "./falsifiers/index.mjs";
import { analyzeSamples } from "./report.mjs";

const CORE_ID_SET = new Set(ORIGINAL_6_FALSIFIERS.map((f) => f.id));
const ORTHOGONAL_ID_SET = new Set(ORTHOGONAL_AXES.map((a) => a.id));

function round4(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10000) / 10000;
}

/**
 * Audit falsifiers against a protected shelf of loved sounds.
 *
 * @param {Array<{
 *   id: string,
 *   label?: string,
 *   samples: Float32Array|ArrayLike<number>,
 *   sampleRate: number,
 *   channels?: Float32Array[],
 *   source?: string,
 *   license?: string
 * }>} shelfItems
 * @param {readonly Array<object>} [falsifiers=DEFAULT_FALSIFIERS]
 */
export function auditFalsifiersAgainstShelf(shelfItems, falsifiers = DEFAULT_FALSIFIERS) {
  const items = Array.isArray(shelfItems) ? shelfItems : [];
  const activeFalsifiers = Array.isArray(falsifiers) ? falsifiers : DEFAULT_FALSIFIERS;
  const shelfSize = items.length;

  const axisMap = new Map();
  for (const fn of activeFalsifiers) {
    axisMap.set(fn.id, {
      id: fn.id,
      domain: fn.domain,
      name: fn.name,
      isCore: CORE_ID_SET.has(fn.id),
      isOrthogonal: ORTHOGONAL_ID_SET.has(fn.id),
      status: "CLEARED",
      falsePositiveCount: 0,
      falsePositiveRate: 0,
      rejectedItems: [],
    });
  }

  let core6Survived = 0;
  let fullSurvived = 0;
  const itemSummaries = [];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx] || {};
    const itemId = item.id || `shelf_${idx + 1}`;
    const label = item.label || itemId;
    const opts = {
      label,
      falsifiers: activeFalsifiers,
      policy: "veto_all",
    };
    if (item.channels) opts.channels = item.channels;

    const rep = analyzeSamples(item.samples, item.sampleRate, opts);

    const triggeredIds = [];
    const byId = new Map();
    for (const res of rep.falsifiers) {
      byId.set(res.id, res);
      if (res.triggered) {
        triggeredIds.push(res.id);
        const axis = axisMap.get(res.id);
        if (axis) {
          axis.falsePositiveCount++;
          axis.rejectedItems.push({
            id: itemId,
            label,
            score: res.score,
            threshold: res.threshold,
            evidence: res.evidence,
          });
        }
      }
    }

    // Evaluate ORIGINAL_6_FALSIFIERS (reuse from rep if present, else detect on extracted features)
    const coreTriggeredIds = [];
    for (const coreFn of ORIGINAL_6_FALSIFIERS) {
      const existing = byId.get(coreFn.id);
      if (existing) {
        if (existing.triggered) coreTriggeredIds.push(coreFn.id);
      } else {
        const out = coreFn.detect(rep.features) || {};
        if (out.triggered) coreTriggeredIds.push(coreFn.id);
      }
    }

    const survivedCore6 = coreTriggeredIds.length === 0;
    const survivedFull = triggeredIds.length === 0;
    if (survivedCore6) core6Survived++;
    if (survivedFull) fullSurvived++;

    itemSummaries.push({
      id: itemId,
      label,
      source: item.source ?? null,
      license: item.license ?? null,
      core6Survived: survivedCore6,
      fullSurvived: survivedFull,
      coreTriggeredIds,
      triggeredIds,
    });
  }

  const axes = [];
  const contestedIds = [];
  for (const axis of axisMap.values()) {
    axis.falsePositiveRate = shelfSize > 0 ? round4(axis.falsePositiveCount / shelfSize) : 0;
    axis.status = axis.falsePositiveCount > 0 ? "CONTESTED" : "CLEARED";
    if (axis.status === "CONTESTED") contestedIds.push(axis.id);
    axes.push(axis);
  }

  return {
    schema: "unkawaii_shelf_audit/v0.3",
    shelfSize,
    totalFalsifiers: activeFalsifiers.length,
    shelfSurvivalRate: {
      core6: shelfSize > 0 ? round4(core6Survived / shelfSize) : 1,
      full: shelfSize > 0 ? round4(fullSurvived / shelfSize) : 1,
      core6Survived,
      fullSurvived,
    },
    contestedCount: contestedIds.length,
    clearedCount: axes.length - contestedIds.length,
    contestedIds,
    axes,
    items: itemSummaries,
  };
}

/**
 * Compact, token-efficient Markdown/text summary of a protected shelf audit for LLMs.
 *
 * @param {object} audit
 * @returns {string}
 */
export function formatShelfAuditForLLM(audit) {
  const shelfSize = audit?.shelfSize ?? 0;
  const total = audit?.totalFalsifiers ?? 0;
  const sr = audit?.shelfSurvivalRate ?? { core6: 1, full: 1, core6Survived: 0, fullSurvived: 0 };
  const pct = (v) => `${Math.round((Number.isFinite(v) ? v : 0) * 1000) / 10}%`;

  const lines = [
    `[PROTECTED SHELF AUDIT] items=${shelfSize} | falsifiers=${total}`,
    `SURVIVAL: core6=${pct(sr.core6)} (${sr.core6Survived}/${shelfSize}) | full=${pct(sr.full)} (${sr.fullSurvived}/${shelfSize})`,
  ];

  const axes = Array.isArray(audit?.axes) ? audit.axes : [];
  const contested = axes
    .filter((a) => a.status === "CONTESTED")
    .sort((a, b) => b.falsePositiveCount - a.falsePositiveCount || a.id.localeCompare(b.id));

  if (contested.length === 0) {
    lines.push(`CONTESTED: none (all ${axes.length} axes CLEARED on protected shelf)`);
  } else {
    lines.push(`CONTESTED (${contested.length}/${axes.length}):`);
    for (const a of contested) {
      const tag = a.isCore ? "core" : a.isOrthogonal ? "orthogonal" : "toolbox";
      const rejectedList = a.rejectedItems.map((it) => it.label || it.id).join(", ");
      lines.push(
        `  - ${a.id} [${tag}|CONTESTED] fp=${a.falsePositiveCount}/${shelfSize} (${pct(a.falsePositiveRate)}) | rejected: ${rejectedList}`
      );
    }
    lines.push(`CLEARED: ${audit.clearedCount}/${axes.length} axes (0 false positives on shelf)`);
  }

  return lines.join("\n");
}
