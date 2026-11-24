#!/usr/bin/env node
/**
 * bench/real_audio_audit/run_real_audio_audit.mjs — Reproducible Real-Audio & Protected Shelf Audit (v0.3)
 *
 * Loads cached 24kHz mono WAVs listed in `manifest.json` (from `--cache-dir` or default scratch cache,
 * or fetches via `curl` + `ffmpeg` when `--fetch` is passed), optionally synthesizes the 9 `tokiko-axis`
 * Japanese speech clips via `/home/antigravity/poidowl/tokiko-axis/kuda.mjs`, and audits every falsifier
 * using `auditFalsifiersAgainstShelf` (`core_veto` vs `veto_all`).
 *
 * Outputs:
 *   - bench/real_audio_audit/results.json
 *   - bench/real_audio_audit/RESULTS.md
 *
 * Usage:
 *   node bench/real_audio_audit/run_real_audio_audit.mjs
 *   node bench/real_audio_audit/run_real_audio_audit.mjs --cache-dir /path/to/wavs
 *   node bench/real_audio_audit/run_real_audio_audit.mjs --fetch --cache-dir /tmp/yata_real_wavs
 *
 * Zero external npm dependencies. Pure ES Module.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeWavBuffer,
  encodeWavBuffer,
  analyzeSamples,
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
  TOOLBOX_FALSIFIERS,
  ORTHOGONAL_AXES,
  auditFalsifiersAgainstShelf,
  formatShelfAuditForLLM,
} from "../../unkawaii_detector.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MANIFEST_PATH = path.join(__dirname, "manifest.json");
const RESULTS_JSON_PATH = path.join(__dirname, "results.json");
const RESULTS_MD_PATH = path.join(__dirname, "RESULTS.md");
const KUDA_PATH = "/home/antigravity/poidowl/tokiko-axis/kuda.mjs";

const TOKIKO_TEXTS = [
  { key: "naru", text: "なる" },
  { key: "watashi", text: "わたし、にほんご、ちょっとしゃべれます" },
  { key: "ohayo", text: "おはよう、きょうは、いいてんきだね" },
];
const TOKIKO_PRESETS = ["kawaii", "amae", "genki"];

function parseArgs(argv) {
  const opts = { cacheDir: null, fetch: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cache-dir" && argv[i + 1]) {
      opts.cacheDir = path.resolve(argv[++i]);
    } else if (argv[i] === "--fetch") {
      opts.fetch = true;
    }
  }
  return opts;
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function pct(num, den) {
  if (!den) return "0.0%";
  return `${((num / den) * 100).toFixed(1)}%`;
}

function resolveClipWavPath(clip, manifest, cacheDir) {
  const candidates = [];
  if (cacheDir) {
    candidates.push(path.join(cacheDir, clip.wavFilename));
    candidates.push(path.join(cacheDir, clip.suite, clip.wavFilename));
  }
  const suiteDefaultDir = manifest.defaultCacheDirs?.[clip.suite];
  if (suiteDefaultDir) {
    candidates.push(path.join(suiteDefaultDir, clip.wavFilename));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function fetchClipToWav(clip, outWavPath, resolvedWavsById) {
  fs.mkdirSync(path.dirname(outWavPath), { recursive: true });

  if (clip.sourceUrl === "derived://clip_05") {
    const baseWav = resolvedWavsById.get("clip_05");
    if (!baseWav || !fs.existsSync(baseWav)) {
      throw new Error("Cannot derive clip_10: clip_05.wav not available");
    }
    const decoded = decodeWavBuffer(fs.readFileSync(baseWav));
    const sr = decoded.sampleRate;
    const out = new Float32Array(decoded.samples.length);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      out[i] = 0.85 * decoded.samples[i] + 0.08 * Math.sin(2 * Math.PI * 60 * t) + 0.03 * Math.sin(2 * Math.PI * 120 * t);
    }
    const clickIdx = Math.round(1.2 * sr);
    if (clickIdx + 1 < out.length) {
      out[clickIdx] = 0.92;
      out[clickIdx + 1] = -0.88;
    }
    fs.writeFileSync(outWavPath, encodeWavBuffer(out, sr, { bitsPerSample: 16 }));
    return outWavPath;
  }

  const rawPath = `${outWavPath}.raw`;
  execFileSync("curl", ["-fsSL", "-A", "yata-real-audio-audit/0.3", "-o", rawPath, clip.sourceUrl], {
    stdio: "pipe",
  });
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(clip.trimStartSec),
      "-t",
      String(clip.trimDurationSec),
      "-i",
      rawPath,
      "-ac",
      "1",
      "-ar",
      "24000",
      "-c:a",
      "pcm_s16le",
      outWavPath,
    ],
    { stdio: "pipe" }
  );
  fs.rmSync(rawPath, { force: true });
  return outWavPath;
}

async function synthesizeTokikoClips() {
  if (!fs.existsSync(KUDA_PATH)) {
    console.log(`[run_real_audio_audit] Optional tokiko-axis not found at ${KUDA_PATH}; skipping tokiko shelf.`);
    return [];
  }
  const kuda = await import(pathToFileURL(KUDA_PATH).href);
  if (typeof kuda.synthKuda !== "function") {
    console.log(`[run_real_audio_audit] synthKuda not found in ${KUDA_PATH}; skipping.`);
    return [];
  }

  const items = [];
  for (const { key, text } of TOKIKO_TEXTS) {
    for (const preset of TOKIKO_PRESETS) {
      const out = kuda.synthKuda(text, { preset, srOut: 24000 });
      const samples = out.samples || out;
      items.push({
        id: `tokiko_${key}_${preset}`,
        label: `tokiko:${preset}:${text}`,
        utterance: text,
        preset,
        samples,
        sampleRate: 24000,
        source: "poidowl/tokiko-axis/kuda.mjs",
        license: "Project-local reference synthesizer",
        auditGroup: "tokiko_protected_shelf",
      });
    }
  }
  return items;
}

function analyzeBothPolicies(samples, sampleRate, label) {
  const repCore = analyzeSamples(samples, sampleRate, {
    label,
    falsifiers: DEFAULT_FALSIFIERS,
    policy: "core_veto",
  });
  const repAll = analyzeSamples(samples, sampleRate, {
    label,
    falsifiers: DEFAULT_FALSIFIERS,
    policy: "veto_all",
  });

  const coreTriggered = repCore.falsifiers
    .filter((f) => f.triggered && ORIGINAL_6_FALSIFIERS.some((c) => c.id === f.id))
    .map((f) => f.id);
  const allTriggered = repAll.falsifiers.filter((f) => f.triggered).map((f) => f.id);

  return {
    verdictCoreVeto: repCore.verdict,
    verdictVetoAll: repAll.verdict,
    coreTriggered,
    allTriggered,
    f0MedianHz: repAll.features?.f0MedianHz ?? 0,
    hnrDb: repAll.features?.hnrDb ?? 0,
    jitter: repAll.features?.jitter ?? 0,
  };
}

function shortAxisId(id) {
  return String(id).split("_")[0];
}

function buildMarkdownReport(summary) {
  const {
    generatedAt,
    realClipCount,
    uniqueBenignCount,
    expectedUnkawaiiCount,
    tokikoCount,
    tokikoAudit,
    benignRealAudit,
    combinedShelfAudit,
    expectedUnkawaiiSummary,
    perClipReal,
    perClipTokiko,
  } = summary;

  const lines = [];
  lines.push("# yata v0.3 — Reproducible Real-Audio & Protected Shelf Audit (`RESULTS.md`)");
  lines.push("");
  lines.push(`Generated: \`${generatedAt}\` by \`node bench/real_audio_audit/run_real_audio_audit.mjs\``);
  lines.push(`Manifest: [\`manifest.json\`](./manifest.json) (${realClipCount} trimmed 24kHz mono clips from 16 Wikimedia Commons sources + ${tokikoCount} \`tokiko-axis\` clips).`);
  lines.push("");
  lines.push("> **Brutal Honesty First**: On synthetic unit tests, all 32 falsifiers pass 100%. On **real human/animal recordings and `tokiko-axis` Japanese speech**, running all 32 axes with unilateral veto power (`--policy veto_all`) causes a high false-positive rate. This report quantifies that exact gap, lists every `CONTESTED` axis, and separates **LLM visual readability** from **detector precision/recall**.");
  lines.push("");

  // Section A
  lines.push("## A. False-Positive Rate (FPR): `core_veto` (F1–F6) vs `veto_all` (F1–F32)");
  lines.push("");
  lines.push("A **False Positive** here means a clip on the Protected Shelf (loved `tokiko` speech or benign real PD/CC0 audio) is rejected (`REJECTED_UNKAWAII`). Lower FPR / higher Survival Rate is better on the Protected Shelf; higher True-Positive Rate (TPR) is better on expected-unkawaii real audio.");
  lines.push("");
  lines.push("| Evaluation Group | Clips | `core_veto` (F1–F6) Survival | `core_veto` FPR | `veto_all` (F1–F32) Survival | `veto_all` FPR |");
  lines.push("| :--- | ---: | ---: | ---: | ---: | ---: |");
  lines.push(
    `| **\`tokiko-axis\` Japanese Speech** (\`kawaii\`/\`amae\`/\`genki\` × 3) | ${tokikoAudit.shelfSize} | **${pct(tokikoAudit.shelfSurvivalRate.core6Survived, tokikoAudit.shelfSize)}** (${tokikoAudit.shelfSurvivalRate.core6Survived}/${tokikoAudit.shelfSize}) | ${pct(tokikoAudit.shelfSize - tokikoAudit.shelfSurvivalRate.core6Survived, tokikoAudit.shelfSize)} | **${pct(tokikoAudit.shelfSurvivalRate.fullSurvived, tokikoAudit.shelfSize)}** (${tokikoAudit.shelfSurvivalRate.fullSurvived}/${tokikoAudit.shelfSize}) | ${pct(tokikoAudit.shelfSize - tokikoAudit.shelfSurvivalRate.fullSurvived, tokikoAudit.shelfSize)} |`
  );
  lines.push(
    `| **Benign Real PD/CC0 Audio** (deduped by SHA-256) | ${benignRealAudit.shelfSize} | **${pct(benignRealAudit.shelfSurvivalRate.core6Survived, benignRealAudit.shelfSize)}** (${benignRealAudit.shelfSurvivalRate.core6Survived}/${benignRealAudit.shelfSize}) | ${pct(benignRealAudit.shelfSize - benignRealAudit.shelfSurvivalRate.core6Survived, benignRealAudit.shelfSize)} | **${pct(benignRealAudit.shelfSurvivalRate.fullSurvived, benignRealAudit.shelfSize)}** (${benignRealAudit.shelfSurvivalRate.fullSurvived}/${benignRealAudit.shelfSize}) | ${pct(benignRealAudit.shelfSize - benignRealAudit.shelfSurvivalRate.fullSurvived, benignRealAudit.shelfSize)} |`
  );
  lines.push(
    `| **Combined Protected Shelf** (\`tokiko\` + Benign Real) | ${combinedShelfAudit.shelfSize} | **${pct(combinedShelfAudit.shelfSurvivalRate.core6Survived, combinedShelfAudit.shelfSize)}** (${combinedShelfAudit.shelfSurvivalRate.core6Survived}/${combinedShelfAudit.shelfSize}) | ${pct(combinedShelfAudit.shelfSize - combinedShelfAudit.shelfSurvivalRate.core6Survived, combinedShelfAudit.shelfSize)} | **${pct(combinedShelfAudit.shelfSurvivalRate.fullSurvived, combinedShelfAudit.shelfSize)}** (${combinedShelfAudit.shelfSurvivalRate.fullSurvived}/${combinedShelfAudit.shelfSize}) | ${pct(combinedShelfAudit.shelfSize - combinedShelfAudit.shelfSurvivalRate.fullSurvived, combinedShelfAudit.shelfSize)} |`
  );
  lines.push("");

  lines.push("### Expected-Unkawaii Real Audio Detection (True-Positive Recall)");
  lines.push("");
  lines.push(`On the **${expectedUnkawaiiCount}** unique expected-unkawaii real clips (cat hiss, alarm siren, 60Hz hum+click injection, wild boar growl, giant canine growl):`);
  lines.push(`- \`core_veto\` (F1–F6) caught **${expectedUnkawaiiSummary.coreCaught}/${expectedUnkawaiiCount}** (${pct(expectedUnkawaiiSummary.coreCaught, expectedUnkawaiiCount)})`);
  lines.push(`- \`veto_all\` (F1–F32) caught **${expectedUnkawaiiSummary.allCaught}/${expectedUnkawaiiCount}** (${pct(expectedUnkawaiiSummary.allCaught, expectedUnkawaiiCount)})`);
  lines.push("");
  lines.push("This confirms why v0.3 introduces **`--policy core_veto`** (defaulting to Core-6 for hard veto while surfacing `TOOLBOX_FALSIFIERS` F7–F32 as non-vetoing diagnostics, and separating `F30` into `ORTHOGONAL_AXES`).");
  lines.push("");

  // Section B
  lines.push("## B. Axes Marked `CONTESTED` by the Protected Shelf");
  lines.push("");
  lines.push("Any falsifier that rejects ≥ 1 clip on the Combined Protected Shelf is formally marked **`CONTESTED`** by `auditFalsifiersAgainstShelf` (`src/shelf.mjs`). Its veto power is suspended until calibrated or reclassified.");
  lines.push("");
  lines.push("```text");
  lines.push(formatShelfAuditForLLM(combinedShelfAudit));
  lines.push("```");
  lines.push("");

  const contestedAxes = combinedShelfAudit.axes
    .filter((a) => a.status === "CONTESTED")
    .sort((a, b) => b.falsePositiveCount - a.falsePositiveCount || a.id.localeCompare(b.id));

  if (contestedAxes.length > 0) {
    lines.push("| Axis | Role | Status | Shelf FP Count | Shelf FPR | Rejected Protected Clips |");
    lines.push("| :--- | :--- | :--- | ---: | ---: | :--- |");
    for (const ax of contestedAxes) {
      const role = ax.isCore ? "core" : ax.isOrthogonal ? "orthogonal" : "toolbox";
      const itemsStr = ax.rejectedItems.map((it) => `\`${it.id}\``).join(", ");
      lines.push(`| \`${ax.id}\` | ${role} | **CONTESTED** | ${ax.falsePositiveCount}/${combinedShelfAudit.shelfSize} | ${pct(ax.falsePositiveCount, combinedShelfAudit.shelfSize)} | ${itemsStr} |`);
    }
    lines.push("");
  }

  // Per-clip breakdown tables
  lines.push("### Per-Clip Breakdown: `tokiko-axis` Speech (9 clips)");
  lines.push("");
  lines.push("| Clip ID | Utterance | Preset | `core_veto` | `veto_all` Triggered Axes | F0 med | Jitter |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | ---: | ---: |");
  for (const c of perClipTokiko) {
    const coreTxt = c.coreTriggered.length ? c.coreTriggered.map(shortAxisId).join(", ") : "PASS";
    const allTxt = c.allTriggered.length ? c.allTriggered.map(shortAxisId).join(", ") : "CLEAN";
    lines.push(`| \`${c.id}\` | ${c.utterance} | \`${c.preset}\` | ${coreTxt} | ${allTxt} | ${c.f0MedianHz} Hz | ${c.jitter} |`);
  }
  lines.push("");

  lines.push("### Per-Clip Breakdown: Real Wikimedia Commons PD/CC0 Audio (20 clips)");
  lines.push("");
  lines.push("| Clip ID | Suite | Group | Title | SHA-256 Match | `core_veto` | `veto_all` Triggered Axes |");
  lines.push("| :--- | :--- | :--- | :--- | :---: | :--- | :--- |");
  for (const c of perClipReal) {
    const coreTxt = c.coreTriggered.length ? c.coreTriggered.map(shortAxisId).join(", ") : "PASS";
    const allTxt = c.allTriggered.length ? c.allTriggered.map(shortAxisId).join(", ") : "CLEAN";
    lines.push(`| \`${c.id}\` | ${c.suite} | \`${c.auditGroup}\` | ${c.title} | ${c.sha256Match ? "✅" : "⚠️"} | ${coreTxt} | ${allTxt} |`);
  }
  lines.push("");

  // Section C
  lines.push("## C. Important Distinction: LLM Visual Readability vs Detector Precision/Recall");
  lines.push("");
  lines.push("In v0.2, we ran two **blind LLM eye exams** (all filenames, labels, and ground truth hidden from the evaluator LLM):");
  lines.push("1. **General Real-Audio Eye Exam** (`clip_01`–`clip_10`): LLM identification score rose from **25/100** (v0.1: 16 scalar numbers only) to **80/100** (v0.2: compact text audio vision, ≤32 lines/clip).");
  lines.push("2. **Baby/Small vs Adult/Large Animal Exam** (`pair_1`–`pair_5`): Blind pair discrimination rose from **3/5** (v0.1 scalars) to **4/5** (v0.2 compact text audio vision).");
  lines.push("");
  lines.push("**What those numbers DO and DO NOT prove:**");
  lines.push("- **DO prove**: `yata`'s token-efficient audio vision (`renderTextVision`) dramatically improves an LLM's ability to *read* pitch contours, spectral tilt, rhythmic cadence, and localized faults from real audio.");
  lines.push("- **DO NOT prove**: High detector precision/recall or low false-positive rate for the 32 falsifier thresholds (`F1`–`F32`). As Section A & B above show honestly, `veto_all` has a high FPR on real benign audio and `tokiko` speech, which is why **visual readability** and **falsifier veto accuracy** must always be reported separately.");
  lines.push("");
  lines.push("### Exact Blind Eye-Exam Rubric & Prompts");
  lines.push("");
  lines.push("- **General Real-Audio Exam (`clip_01`–`clip_10`)**:");
  lines.push("  - *Prompt*: Given ONLY anonymized `clip_01..clip_10` packets (Condition A: v0.1 16 scalar features; Condition B: v0.2 `renderTextVision(..., { mode: 'compact' })`), identify the likely sound source category, acoustic texture, and any localized faults (e.g., exact timestamp of click or hum frequency) without seeing filenames or ground truth.");
  lines.push("  - *Rubric*: 10 points per clip (100 total) — 5 pts for broad acoustic class (speech/singing/instrument/animal/alarm/bird), 5 pts for specific physical cue (polyphony, historical bandlimit, aggressive hiss, periodic siren, localized click @ 1.20s + 60Hz hum).");
  lines.push("- **Baby/Small vs Adult/Large Animal Exam (`pair_1`–`pair_5`)**:");
  lines.push("  - *Prompt*: `For each pair (Pair_1..Pair_5), decide whether A or B is the BABY/SMALL/FRIENDLY voice and which is the ADULT/LARGE/MENACING voice.` (A/B order randomized per pair; filenames stripped).");
  lines.push("  - *Rubric*: 1 point per pair (5 total), binary accuracy against ground truth.");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  const resolvedWavsById = new Map();
  const realLoaded = [];
  const missing = [];

  for (const clip of manifest.clips) {
    let wavPath = resolveClipWavPath(clip, manifest, opts.cacheDir);
    if (!wavPath && opts.fetch) {
      const targetDir = opts.cacheDir || path.join(__dirname, ".cache_wav");
      const outPath = path.join(targetDir, clip.wavFilename);
      console.log(`[run_real_audio_audit] Fetching ${clip.id} -> ${outPath}`);
      wavPath = fetchClipToWav(clip, outPath, resolvedWavsById);
    }
    if (!wavPath) {
      missing.push(clip.id);
      continue;
    }
    resolvedWavsById.set(clip.id, wavPath);
    const buf = fs.readFileSync(wavPath);
    const actualSha = sha256Buffer(buf);
    const decoded = decodeWavBuffer(buf);
    realLoaded.push({
      clip,
      wavPath,
      actualSha,
      sha256Match: actualSha === clip.sha256,
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
    });
  }

  if (missing.length > 0) {
    console.warn(`[run_real_audio_audit] Warning: ${missing.length} clips missing (${missing.join(", ")}). Pass --fetch or --cache-dir to load them.`);
  }

  const tokikoItems = await synthesizeTokikoClips();

  // Analyze all real clips
  const perClipReal = realLoaded.map(({ clip, actualSha, sha256Match, samples, sampleRate }) => {
    const analysis = analyzeBothPolicies(samples, sampleRate, clip.id);
    return {
      id: clip.id,
      suite: clip.suite,
      title: clip.title,
      category: clip.category,
      auditGroup: clip.auditGroup,
      sourceUrl: clip.sourceUrl,
      license: clip.license,
      sha256: actualSha,
      sha256Match,
      ...analysis,
    };
  });

  // Analyze all tokiko clips
  const perClipTokiko = tokikoItems.map((item) => {
    const analysis = analyzeBothPolicies(item.samples, item.sampleRate, item.id);
    return {
      id: item.id,
      utterance: item.utterance,
      preset: item.preset,
      source: item.source,
      ...analysis,
    };
  });

  // Deduplicate benign real audio by SHA-256 so shared clips (Baby_Laugh, Chakrulo) aren't double-counted
  const seenBenignSha = new Set();
  const benignShelfItems = [];
  for (const entry of realLoaded) {
    if (entry.clip.auditGroup !== "benign_real_audio") continue;
    if (seenBenignSha.has(entry.actualSha)) continue;
    seenBenignSha.add(entry.actualSha);
    benignShelfItems.push({
      id: entry.clip.id,
      label: `${entry.clip.id} (${entry.clip.category})`,
      samples: entry.samples,
      sampleRate: entry.sampleRate,
      source: entry.clip.sourceUrl,
      license: entry.clip.license,
    });
  }

  // Deduplicate expected_unkawaii real audio by SHA-256
  const seenUnkawaiiSha = new Set();
  const expectedUnkawaiiEntries = [];
  for (let i = 0; i < realLoaded.length; i++) {
    const entry = realLoaded[i];
    if (entry.clip.auditGroup !== "expected_unkawaii") continue;
    if (seenUnkawaiiSha.has(entry.actualSha)) continue;
    seenUnkawaiiSha.add(entry.actualSha);
    expectedUnkawaiiEntries.push(perClipReal[i]);
  }
  const expectedUnkawaiiSummary = {
    count: expectedUnkawaiiEntries.length,
    coreCaught: expectedUnkawaiiEntries.filter((c) => c.coreTriggered.length > 0).length,
    allCaught: expectedUnkawaiiEntries.filter((c) => c.allTriggered.length > 0).length,
    clips: expectedUnkawaiiEntries.map((c) => ({
      id: c.id,
      title: c.title,
      coreTriggered: c.coreTriggered,
      allTriggered: c.allTriggered,
    })),
  };

  // Run Protected Shelf Audits via src/shelf.mjs
  const tokikoAudit = auditFalsifiersAgainstShelf(tokikoItems, DEFAULT_FALSIFIERS);
  const benignRealAudit = auditFalsifiersAgainstShelf(benignShelfItems, DEFAULT_FALSIFIERS);
  const combinedShelfAudit = auditFalsifiersAgainstShelf([...tokikoItems, ...benignShelfItems], DEFAULT_FALSIFIERS);

  const generatedAt = new Date().toISOString();
  const resultsObj = {
    schema: "yata_real_audio_audit/v0.3",
    generatedAt,
    axisCounts: {
      core: ORIGINAL_6_FALSIFIERS.length,
      toolbox: TOOLBOX_FALSIFIERS.length,
      orthogonal: ORTHOGONAL_AXES.length,
      defaultTotal: DEFAULT_FALSIFIERS.length,
    },
    realClipCount: perClipReal.length,
    uniqueBenignCount: benignShelfItems.length,
    expectedUnkawaiiCount: expectedUnkawaiiEntries.length,
    tokikoCount: perClipTokiko.length,
    tokikoAudit,
    benignRealAudit,
    combinedShelfAudit,
    expectedUnkawaiiSummary,
    perClipTokiko,
    perClipReal,
  };

  fs.writeFileSync(RESULTS_JSON_PATH, JSON.stringify(resultsObj, null, 2) + "\n", "utf8");
  const md = buildMarkdownReport(resultsObj);
  fs.writeFileSync(RESULTS_MD_PATH, md, "utf8");

  console.log(`[run_real_audio_audit] Wrote ${RESULTS_JSON_PATH}`);
  console.log(`[run_real_audio_audit] Wrote ${RESULTS_MD_PATH}`);
  console.log("");
  console.log(formatShelfAuditForLLM(combinedShelfAudit));
}

main().catch((err) => {
  console.error("[run_real_audio_audit] ERROR:", err);
  process.exit(1);
});
