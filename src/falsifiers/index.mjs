/**
 * src/falsifiers/index.mjs — 64-Axis "Unkawaii" Falsifier Registry
 *
 * Exports:
 *   - ORIGINAL_6_FALSIFIERS: F1–F6 (v0.1 backward-compatible core)
 *   - DEFAULT_FALSIFIERS:    F1–F64 in exact numerical order
 *   - ORTHOGONAL_AXES:       Axes confirmed neither kawaii nor unkawaii (freedom-of-expression map)
 *   - TOOLBOX_FALSIFIERS:    F7–F64 excluding ORTHOGONAL_AXES (diagnostic/toolbox axes)
 *   - createFalsifiers(thresholdOverrides = {}, baseFalsifiers = DEFAULT_FALSIFIERS)
 *
 * Zero external dependencies. Pure ES Module.
 */

import { ORIGINAL_6_FALSIFIERS } from "./core.mjs";
import { WAVEFORM_FALSIFIERS } from "./waveform.mjs";
import { SPECTRAL_CORE_FALSIFIERS, SPECTRAL_EXTRA_FALSIFIERS } from "./spectral.mjs";
import { PROSODY_FALSIFIERS } from "./prosody.mjs";
import { SPATIAL_FALSIFIERS } from "./spatial.mjs";
import { DYNAMICS_FALSIFIERS } from "./dynamics.mjs";
import { ACOUSTICS_FALSIFIERS } from "./acoustics.mjs";
import { FATIGUE_FALSIFIERS } from "./fatigue.mjs";

export { ORIGINAL_6_FALSIFIERS };

export const DEFAULT_FALSIFIERS = Object.freeze([
  ...ORIGINAL_6_FALSIFIERS,       // F1–F6
  ...WAVEFORM_FALSIFIERS,         // F7–F11
  ...SPECTRAL_CORE_FALSIFIERS,    // F12–F20
  ...PROSODY_FALSIFIERS,          // F21–F27
  ...SPATIAL_FALSIFIERS,          // F28–F30
  ...SPECTRAL_EXTRA_FALSIFIERS,   // F31–F40
  ...DYNAMICS_FALSIFIERS,         // F41–F48
  ...ACOUSTICS_FALSIFIERS,        // F49–F56
  ...FATIGUE_FALSIFIERS,          // F57–F64
]);

/**
 * Orthogonal axes confirmed neither kawaii nor unkawaii (freedom-of-expression map).
 * These remain in DEFAULT_FALSIFIERS for backward compatibility, while being formally
 * separated from TOOLBOX_FALSIFIERS so they are not treated as unkawaii vetoes.
 */
export const ORTHOGONAL_AXES = Object.freeze([
  Object.freeze({
    id: "F30_STEREO_PHASE_DISCOMFORT",
    domain: "environment_digital_spatial",
    name: "Stereo Phase Inversion / Severe L-R Imbalance",
    status: "orthogonal",
    reason: "Owner ear-judge 2026-11-24: confirmed neither kawaii nor unkawaii (orthogonal spatial axis).",
    decidedAt: "2026-11-24",
  }),
]);

const CORE_FALSIFIER_ID_SET = new Set(ORIGINAL_6_FALSIFIERS.map((f) => f.id));
const ORTHOGONAL_AXIS_ID_SET = new Set(ORTHOGONAL_AXES.map((a) => a.id));

/**
 * Diagnostic / toolbox falsifiers: F7–F32 excluding confirmed ORTHOGONAL_AXES.
 */
export const TOOLBOX_FALSIFIERS = Object.freeze(
  DEFAULT_FALSIFIERS.filter((f) => !CORE_FALSIFIER_ID_SET.has(f.id) && !ORTHOGONAL_AXIS_ID_SET.has(f.id))
);

/**
 * Create a fresh falsifier array with per-ID threshold overrides without mutating DEFAULT_FALSIFIERS.
 *
 * @param {Record<string, number | Record<string, number>>} [thresholdOverrides={}]
 * @param {readonly Array<object>} [baseFalsifiers=DEFAULT_FALSIFIERS]
 * @returns {Array<object>}
 */
export function createFalsifiers(thresholdOverrides = {}, baseFalsifiers = DEFAULT_FALSIFIERS) {
  const overrides = thresholdOverrides && typeof thresholdOverrides === "object" ? thresholdOverrides : {};
  return baseFalsifiers.map((fn) => {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, fn.id);
    if (!hasOverride) {
      return {
        id: fn.id,
        domain: fn.domain,
        name: fn.name,
        detect: (features, runtimeOverride) => fn.detect(features, runtimeOverride),
      };
    }
    const baked = overrides[fn.id];
    return {
      id: fn.id,
      domain: fn.domain,
      name: fn.name,
      detect: (features, runtimeOverride) => {
        if (runtimeOverride === undefined) {
          return fn.detect(features, baked);
        }
        if (
          baked &&
          typeof baked === "object" &&
          runtimeOverride &&
          typeof runtimeOverride === "object"
        ) {
          return fn.detect(features, { ...baked, ...runtimeOverride });
        }
        return fn.detect(features, runtimeOverride);
      },
    };
  });
}
