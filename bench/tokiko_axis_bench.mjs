#!/usr/bin/env node
/**
 * bench/tokiko_axis_bench.mjs — Optional Read-Only `tokiko-axis` Real-Speech Benchmark
 *
 * Gracefully skips with exit 0 if `/home/antigravity/poidowl/tokiko-axis/kuda.mjs`
 * is not present on this machine. Never imported by yata's core library.
 *
 * Zero external dependencies. Pure ES Module.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { analyzeSamples, DEFAULT_FALSIFIERS } from "../unkawaii_detector.mjs";

const KUDA_PATH = "/home/antigravity/poidowl/tokiko-axis/kuda.mjs";

if (!fs.existsSync(KUDA_PATH)) {
  console.log(`[tokiko_axis_bench] Optional reference not found at ${KUDA_PATH}; skipping gracefully.`);
  process.exit(0);
}

try {
  const kuda = await import(pathToFileURL(KUDA_PATH).href);
  const synthFn = kuda.synthesize || kuda.synthUtterance || kuda.renderUtterance || kuda.default;
  if (typeof synthFn !== "function") {
    console.log(`[tokiko_axis_bench] Loaded ${KUDA_PATH}, but no known synthesis entrypoint found; skipping.`);
    process.exit(0);
  }

  const presets = ["kawaii", "amae", "genki", "sasayaki", "kawaii_ts_j"];
  console.log(`[tokiko_axis_bench] Running read-only check on ${KUDA_PATH}`);
  for (const preset of presets) {
    try {
      const out = await synthFn({ preset, text: "なる" });
      const samples = out?.samples || out;
      const sr = out?.sampleRate || 24000;
      if (!samples || !samples.length) continue;
      const rep = analyzeSamples(samples, sr, { label: `kuda_${preset}`, falsifiers: DEFAULT_FALSIFIERS });
      const trig = rep.falsifiers.filter((f) => f.triggered).map((f) => f.id).join(", ");
      console.log(`  - ${preset.padEnd(14)}: ${rep.verdict} (${rep.triggeredCount}/32) ${trig}`);
    } catch (err) {
      console.log(`  - ${preset.padEnd(14)}: skipped (${err.message})`);
    }
  }
} catch (err) {
  console.log(`[tokiko_axis_bench] Optional reference unavailable (${err.message}); skipping gracefully.`);
  process.exit(0);
}
