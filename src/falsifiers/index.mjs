/**
 * src/falsifiers/index.mjs — 32-Axis "Unkawaii" Falsifier Registry
 *
 * Exports:
 *   - ORIGINAL_6_FALSIFIERS: F1–F6 (v0.1 backward-compatible core)
 *   - DEFAULT_FALSIFIERS:    F1–F32 in exact numerical order
 *   - createFalsifiers(thresholdOverrides = {}, baseFalsifiers = DEFAULT_FALSIFIERS)
 *
 * Zero external dependencies. Pure ES Module.
 */

import { ORIGINAL_6_FALSIFIERS } from "./core.mjs";
import { WAVEFORM_FALSIFIERS } from "./waveform.mjs";
import { SPECTRAL_CORE_FALSIFIERS, SPECTRAL_EXTRA_FALSIFIERS } from "./spectral.mjs";
import { PROSODY_FALSIFIERS } from "./prosody.mjs";
import { SPATIAL_FALSIFIERS } from "./spatial.mjs";

export { ORIGINAL_6_FALSIFIERS };

export const DEFAULT_FALSIFIERS = Object.freeze([
  ...ORIGINAL_6_FALSIFIERS,       // F1–F6
  ...WAVEFORM_FALSIFIERS,         // F7–F11
  ...SPECTRAL_CORE_FALSIFIERS,    // F12–F20
  ...PROSODY_FALSIFIERS,          // F21–F27
  ...SPATIAL_FALSIFIERS,          // F28–F30
  ...SPECTRAL_EXTRA_FALSIFIERS,   // F31–F32
]);

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
