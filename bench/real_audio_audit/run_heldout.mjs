#!/usr/bin/env node
/**
 * run_heldout.mjs — reproducible held-out PD/CC0 run (default policy core_veto, no tuning).
 *   node bench/real_audio_audit/run_heldout.mjs --fetch --cache-dir /tmp/yata_heldout [--json]
 * Reads ONLY heldout_pd_cc0_manifest.json. If a result here makes you change a threshold or guard,
 * move that clip to tuning_pd_cc0_manifest.json first (it is burned).
 */
import { analyzeSamples } from "../../unkawaii_detector.mjs";
import { readManifest, loadClips, argDirs } from "./clipset.mjs";

const argv = process.argv.slice(2);
const m = readManifest("heldout_pd_cc0_manifest.json");
const rows = loadClips(m.clips, { dirs: argDirs(argv), fetch: argv.includes("--fetch") }).map(({ clip, samples, sampleRate, shaOk }) => {
  const r = analyzeSamples(samples, sampleRate, { label: clip.id });
  const veto = r.falsifiers.filter((f) => f.triggered && !f.diagnostic).map((f) => f.id.split("_")[0]);
  return { id: clip.id, group: clip.group, shaOk, verdict: r.verdict, veto };
});
const ok = (r) => (r.group === "expected_unkawaii") === (r.verdict === "REJECTED_UNKAWAII");
if (argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else {
  console.log("| id | group | sha | verdict | core veto |\n|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.id} | ${r.group} | ${r.shaOk === null ? "-" : r.shaOk ? "ok" : "MISMATCH"} | ${r.verdict} | ${r.veto.join(",") || "-"} |`);
  for (const g of [...new Set(rows.map((r) => r.group))]) {
    const gr = rows.filter((r) => r.group === g);
    console.log(`${g}: ${gr.filter(ok).length}/${gr.length} as expected`);
  }
}
