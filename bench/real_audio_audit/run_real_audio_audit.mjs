#!/usr/bin/env node
/**
 * bench/real_audio_audit/run_real_audio_audit.mjs — Reproducible Real-Audio & Protected Shelf Audit (v0.4)
 *
 * Loads cached 24kHz mono WAVs listed in `manifest.json` (from `--cache-dir` or relative `.cache_wav`,
 * or fetches via `curl` + `ffmpeg` when `--fetch` is passed), optionally synthesizes the 9 `tokiko-axis`
 * Japanese speech clips via `--tokiko-dir` / `TOKIKO_PATH` / `../tokiko-axis/kuda.mjs`, and audits every
 * falsifier using `auditFalsifiersAgainstShelf` (`core_veto` vs `shelf_veto` vs `veto_all`).
 *
 * Outputs:
 *   - bench/real_audio_audit/results.json
 *   - bench/real_audio_audit/RESULTS.md
 *
 * Usage:
 *   node bench/real_audio_audit/run_real_audio_audit.mjs
 *   node bench/real_audio_audit/run_real_audio_audit.mjs --cache-dir /path/to/wavs
 *   node bench/real_audio_audit/run_real_audio_audit.mjs --tokiko-dir ../tokiko-axis
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
const REPO_ROOT = path.resolve(__dirname, "../..");
const MANIFEST_PATH = path.join(__dirname, "manifest.json");
const RESULTS_JSON_PATH = path.join(__dirname, "results.json");
const RESULTS_MD_PATH = path.join(__dirname, "RESULTS.md");

const TOKIKO_TEXTS = [
  { key: "naru", text: "なる" },
  { key: "watashi", text: "わたし、にほんご、ちょっとしゃべれます" },
  { key: "ohayo", text: "おはよう、きょうは、いいてんきだね" },
];
const TOKIKO_PRESETS = ["kawaii", "amae", "genki"];

function parseArgs(argv) {
  const opts = { cacheDirs: [], fetch: false, tokikoDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cache-dir" && argv[i + 1]) {
      opts.cacheDirs.push(path.resolve(argv[++i]));
    } else if (argv[i].startsWith("--cache-dir=")) {
      opts.cacheDirs.push(path.resolve(argv[i].slice("--cache-dir=".length)));
    } else if (argv[i] === "--tokiko-dir" && argv[i + 1]) {
      opts.tokikoDir = argv[++i];
    } else if (argv[i].startsWith("--tokiko-dir=")) {
      opts.tokikoDir = argv[i].slice("--tokiko-dir=".length);
    } else if (argv[i] === "--fetch") {
      opts.fetch = true;
    }
  }
  if (process.env.YATA_AUDIT_CACHE_DIR) {
    for (const part of process.env.YATA_AUDIT_CACHE_DIR.split(path.delimiter)) {
      if (part.trim()) opts.cacheDirs.push(path.resolve(part.trim()));
    }
  }
  return opts;
}

function resolveKudaPath(tokikoDir) {
  const base = tokikoDir || process.env.TOKIKO_PATH || path.resolve(REPO_ROOT, "../tokiko-axis");
  const resolved = path.resolve(base);
  return resolved.endsWith(".mjs") ? resolved : path.join(resolved, "kuda.mjs");
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function pct(num, den) {
  if (!den) return "0.0%";
  return `${((num / den) * 100).toFixed(1)}%`;
}

function resolveClipWavPath(clip, manifest, cacheDirs) {
  const candidates = [];
  for (const dir of cacheDirs) {
    candidates.push(path.join(dir, clip.wavFilename));
    candidates.push(path.join(dir, clip.suite, clip.wavFilename));
  }
  const suiteDefaultDir = manifest.defaultCacheDirs?.[clip.suite];
  if (suiteDefaultDir) {
    const resolvedDefault = path.isAbsolute(suiteDefaultDir)
      ? suiteDefaultDir
      : path.resolve(__dirname, suiteDefaultDir);
    candidates.push(path.join(resolvedDefault, clip.wavFilename));
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

async function synthesizeTokikoClips(kudaPath) {
  if (!fs.existsSync(kudaPath)) {
    console.log(`[run_real_audio_audit] Optional tokiko-axis not found at ${kudaPath}; skipping tokiko shelf.`);
    return [];
  }
  const kuda = await import(pathToFileURL(kudaPath).href);
  if (typeof kuda.synthKuda !== "function") {
    console.log(`[run_real_audio_audit] synthKuda not found in ${kudaPath}; skipping.`);
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

function analyzePolicies(samples, sampleRate, label, contestedIds = []) {
  const contestedSet = contestedIds instanceof Set ? contestedIds : new Set(contestedIds);
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
  const repShelf = analyzeSamples(samples, sampleRate, {
    label,
    falsifiers: DEFAULT_FALSIFIERS,
    policy: "shelf_veto",
    contestedIds: contestedSet,
  });

  if (repShelf.policy !== "shelf_veto") {
    throw new Error(`Expected policy="shelf_veto" for ${label}, got "${repShelf.policy}"`);
  }

  const coreTriggered = repCore.falsifiers
    .filter((f) => f.triggered && ORIGINAL_6_FALSIFIERS.some((c) => c.id === f.id))
    .map((f) => f.id);
  const allTriggered = repAll.falsifiers.filter((f) => f.triggered).map((f) => f.id);
  const shelfTriggered = repShelf.falsifiers
    .filter((f) => f.triggered && !f.diagnostic)
    .map((f) => f.id);
  const verdictShelfVeto = repShelf.verdict;

  // Runtime invariant: summary verdict and per-item shelfTriggered can NEVER diverge
  const expectedSurvived = shelfTriggered.length === 0;
  const actualSurvived = verdictShelfVeto === "SURVIVED_KAWAII_CANDIDATE";
  if (expectedSurvived !== actualSurvived) {
    throw new Error(
      `shelf_veto invariant violated on ${label}: verdict=${verdictShelfVeto} but shelfTriggered=[${shelfTriggered.join(", ")}]`
    );
  }

  const respScore = repAll.features?.respiratoryScore ?? 0;
  const dirScore = repAll.features?.directnessScore ?? 0;
  const compassLabel =
    respScore >= 0.5 && dirScore >= 0.5
      ? "addressed_breath"
      : respScore >= 0.5
        ? "distant_or_private_breath"
        : dirScore >= 0.5
          ? "non_breath_signal"
          : "ambient_or_hollow";

  return {
    verdictCoreVeto: repCore.verdict,
    verdictShelfVeto,
    verdictVetoAll: repAll.verdict,
    coreTriggered,
    shelfTriggered,
    allTriggered,
    f0MedianHz: repAll.features?.medianF0 ?? 0,
    hnrDb: repAll.features?.meanVoicedHnrDb ?? 0,
    jitter: repAll.features?.jitter ?? 0,
    mpsSpeech4_16: repAll.features?.mpsSpeech4_16 ?? 0,
    mpsRoughness30_150: repAll.features?.mpsRoughness30_150 ?? 0,
    mpsRoughToSpeechRatio: repAll.features?.mpsRoughToSpeechRatio ?? 0,
    subharmonicRatio: repAll.features?.subharmonicRatio ?? 0,
    respiratoryScore: respScore,
    directnessScore: dirScore,
    voiceCompassLabel: compassLabel,
  };
}

function shortAxisId(id) {
  return String(id).split("_")[0];
}

function countShelfVetoSurvival(items, contestedSet) {
  let survived = 0;
  for (const it of items) {
    const vetoed = (it.triggeredIds || []).some((id) => !contestedSet.has(id));
    if (!vetoed) survived++;
  }
  return survived;
}

function evaluateAgainstContested(items, contestedSet) {
  let survived = 0;
  const failures = [];
  for (const it of items) {
    const caughtBy = (it.triggeredIds || []).filter((id) => !contestedSet.has(id));
    if (caughtBy.length === 0) {
      survived++;
    } else {
      failures.push({ id: it.id, label: it.label || it.id, caughtBy });
    }
  }
  const total = items.length;
  return {
    survived,
    total,
    survivalRate: total ? Number((survived / total).toFixed(4)) : 1,
    fpr: total ? Number(((total - survived) / total).toFixed(4)) : 0,
    failures,
  };
}

function computeGeneralization(tokikoAudit, benignRealAudit, combinedShelfAudit, expectedUnkawaiiEntries) {
  const combinedItems = combinedShelfAudit.items || [];
  let looSurvived = 0;
  const looFailures = [];
  const looRecallCounts = [];

  for (let i = 0; i < combinedItems.length; i++) {
    const otherContested = new Set();
    for (let j = 0; j < combinedItems.length; j++) {
      if (j === i) continue;
      for (const axId of combinedItems[j].triggeredIds || []) {
        otherContested.add(axId);
      }
    }
    const item = combinedItems[i];
    const caughtBy = (item.triggeredIds || []).filter((id) => !otherContested.has(id));
    if (caughtBy.length === 0) {
      looSurvived++;
    } else {
      looFailures.push({ id: item.id, label: item.label || item.id, caughtBy });
    }

    const foldCaught = expectedUnkawaiiEntries.filter((c) =>
      (c.allTriggered || []).some((id) => !otherContested.has(id))
    ).length;
    looRecallCounts.push(foldCaught);
  }

  const realContestedSet = new Set(benignRealAudit.contestedIds || []);
  const tokikoContestedSet = new Set(tokikoAudit.contestedIds || []);

  const realToTokiko = {
    trainDomain: "benign_real_audio",
    testDomain: "tokiko_axis",
    trainSize: benignRealAudit.shelfSize,
    trainContestedCount: realContestedSet.size,
    ...evaluateAgainstContested(tokikoAudit.items || [], realContestedSet),
  };

  const tokikoToReal = {
    trainDomain: "tokiko_axis",
    testDomain: "benign_real_audio",
    trainSize: tokikoAudit.shelfSize,
    trainContestedCount: tokikoContestedSet.size,
    ...evaluateAgainstContested(benignRealAudit.items || [], tokikoContestedSet),
  };

  const looTotal = combinedItems.length;
  const meanLooRecall =
    looRecallCounts.length > 0
      ? Number((looRecallCounts.reduce((a, b) => a + b, 0) / looRecallCounts.length).toFixed(2))
      : 0;

  return {
    leaveOneOut: {
      survived: looSurvived,
      total: looTotal,
      survivalRate: looTotal ? Number((looSurvived / looTotal).toFixed(4)) : 1,
      fpr: looTotal ? Number(((looTotal - looSurvived) / looTotal).toFixed(4)) : 0,
      failures: looFailures,
      expectedUnkawaiiRecall: {
        total: expectedUnkawaiiEntries.length,
        minCaught: looRecallCounts.length ? Math.min(...looRecallCounts) : 0,
        maxCaught: looRecallCounts.length ? Math.max(...looRecallCounts) : 0,
        meanCaught: meanLooRecall,
      },
    },
    crossDomain: {
      realToTokiko,
      tokikoToReal,
    },
  };
}

function summarizeMetric(items, key) {
  const vals = items.map((it) => Number(it?.[key] ?? 0)).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return { count: 0, mean: 0, min: 0, max: 0 };
  const sum = vals.reduce((a, b) => a + b, 0);
  return {
    count: vals.length,
    mean: Number((sum / vals.length).toFixed(4)),
    min: Number(Math.min(...vals).toFixed(4)),
    max: Number(Math.max(...vals).toFixed(4)),
  };
}

function computeNeuroscienceLensSummary(perClipTokiko, benignRealEntries, expectedUnkawaiiEntries) {
  const combinedShelf = [...perClipTokiko, ...benignRealEntries];
  const groups = {
    tokikoShelf: {
      count: perClipTokiko.length,
      mpsRoughness30_150: summarizeMetric(perClipTokiko, "mpsRoughness30_150"),
      mpsRoughToSpeechRatio: summarizeMetric(perClipTokiko, "mpsRoughToSpeechRatio"),
      subharmonicRatio: summarizeMetric(perClipTokiko, "subharmonicRatio"),
    },
    benignRealShelf: {
      count: benignRealEntries.length,
      mpsRoughness30_150: summarizeMetric(benignRealEntries, "mpsRoughness30_150"),
      mpsRoughToSpeechRatio: summarizeMetric(benignRealEntries, "mpsRoughToSpeechRatio"),
      subharmonicRatio: summarizeMetric(benignRealEntries, "subharmonicRatio"),
    },
    combinedShelf: {
      count: combinedShelf.length,
      mpsRoughness30_150: summarizeMetric(combinedShelf, "mpsRoughness30_150"),
      mpsRoughToSpeechRatio: summarizeMetric(combinedShelf, "mpsRoughToSpeechRatio"),
      subharmonicRatio: summarizeMetric(combinedShelf, "subharmonicRatio"),
    },
    expectedUnkawaii: {
      count: expectedUnkawaiiEntries.length,
      mpsRoughness30_150: summarizeMetric(expectedUnkawaiiEntries, "mpsRoughness30_150"),
      mpsRoughToSpeechRatio: summarizeMetric(expectedUnkawaiiEntries, "mpsRoughToSpeechRatio"),
      subharmonicRatio: summarizeMetric(expectedUnkawaiiEntries, "subharmonicRatio"),
    },
  };

  const shelfMaxMps = groups.combinedShelf.mpsRoughness30_150.max;
  const tokikoMaxMps = groups.tokikoShelf.mpsRoughness30_150.max;
  const unkawaiiAboveShelfMaxMps = expectedUnkawaiiEntries.filter(
    (c) => c.mpsRoughness30_150 > shelfMaxMps
  );
  const unkawaiiAboveTokikoMaxMps = expectedUnkawaiiEntries.filter(
    (c) => c.mpsRoughness30_150 > tokikoMaxMps
  );

  const shelfMaxSubh = groups.combinedShelf.subharmonicRatio.max;
  const unkawaiiAboveShelfMaxSubh = expectedUnkawaiiEntries.filter(
    (c) => c.subharmonicRatio > shelfMaxSubh
  );

  return {
    groups,
    separation: {
      mpsRoughness30_150: {
        shelfMax: shelfMaxMps,
        tokikoMax: tokikoMaxMps,
        unkawaiiAboveCombinedShelfMax: unkawaiiAboveShelfMaxMps.map((c) => c.id),
        unkawaiiAboveTokikoMax: unkawaiiAboveTokikoMaxMps.map((c) => c.id),
        cleanZeroFpSeparation: unkawaiiAboveShelfMaxMps.length === expectedUnkawaiiEntries.length,
      },
      subharmonicRatio: {
        shelfMax: shelfMaxSubh,
        unkawaiiAboveCombinedShelfMax: unkawaiiAboveShelfMaxSubh.map((c) => c.id),
      },
    },
    perClipExpectedUnkawaii: expectedUnkawaiiEntries.map((c) => ({
      id: c.id,
      title: c.title,
      mpsSpeech4_16: c.mpsSpeech4_16,
      mpsRoughness30_150: c.mpsRoughness30_150,
      mpsRoughToSpeechRatio: c.mpsRoughToSpeechRatio,
      subharmonicRatio: c.subharmonicRatio,
    })),
    perClipShelfTopMps: [...combinedShelf]
      .sort((a, b) => b.mpsRoughness30_150 - a.mpsRoughness30_150)
      .slice(0, 6)
      .map((c) => ({
        id: c.id,
        label: c.title || `${c.preset}:${c.utterance}`,
        mpsRoughness30_150: c.mpsRoughness30_150,
        mpsRoughToSpeechRatio: c.mpsRoughToSpeechRatio,
        subharmonicRatio: c.subharmonicRatio,
      })),
  };
}

function buildMarkdownReport(summary) {
  const {
    generatedAt,
    realClipCount,
    expectedUnkawaiiCount,
    tokikoCount,
    tokikoAudit,
    benignRealAudit,
    combinedShelfAudit,
    shelfVetoSummary,
    generalization,
    expectedUnkawaiiSummary,
    neuroscienceLenses,
    perClipReal,
    perClipTokiko,
  } = summary;

  const lines = [];
  lines.push("# yata v0.8 — Reproducible Real-Audio & Protected Shelf Audit (`RESULTS.md`)");
  lines.push("");
  lines.push(`Generated: \`${generatedAt}\` by \`node bench/real_audio_audit/run_real_audio_audit.mjs\``);
  lines.push(`Manifest: [\`manifest.json\`](./manifest.json) (${realClipCount} trimmed 24kHz mono clips from 16 Wikimedia Commons sources with verified licenses + ${tokikoCount} \`tokiko-axis\` clips).`);
  lines.push("");
  lines.push("> **Brutal Honesty First**: On synthetic unit tests, all 32 falsifiers pass 100%. On **real human/animal recordings and `tokiko-axis` Japanese speech**, running all 32 axes with unilateral veto power (`--policy veto_all`) causes a high false-positive rate. This report quantifies that exact gap across **`core_veto`** (default), **`shelf_veto`** (suspends veto on shelf-contested axes), and **`veto_all`**, breaks out **Public Domain / CC0-only** real clips separately from CC BY/BY-SA clips, reports **out-of-sample Leave-One-Out (LOO) & cross-domain generalization**, lists every `CONTESTED` axis, separates **LLM visual readability** from **detector precision/recall**, and evaluates the **v0.5 neuroscience DSP lenses** and **v0.6 Voice Compass** honestly on real audio.");
  lines.push("");

  // Compute Public Domain / CC0-only benign real subset (deduped by SHA-256)
  const pdCc0Seen = new Set();
  const pdCc0Benign = [];
  for (const c of perClipReal) {
    if (c.auditGroup !== "benign_real_audio") continue;
    if (!/(public domain|cc0)/i.test(String(c.license || ""))) continue;
    const key = c.sha256 || c.id;
    if (pdCc0Seen.has(key)) continue;
    pdCc0Seen.add(key);
    pdCc0Benign.push(c);
  }
  const pdCc0CoreSurvived = pdCc0Benign.filter((c) => c.coreTriggered.length === 0).length;
  const pdCc0ShelfSurvived = pdCc0Benign.filter((c) => c.shelfTriggered.length === 0).length;
  const pdCc0AllSurvived = pdCc0Benign.filter((c) => c.allTriggered.length === 0).length;

  // Section A
  lines.push("## A. False-Positive Rate (FPR): `core_veto` vs `shelf_veto` vs `veto_all`");
  lines.push("");
  lines.push("A **False Positive** here means a clip on the Protected Shelf (loved `tokiko` speech or benign real Wikimedia Commons audio) is rejected (`REJECTED_UNKAWAII`). Lower FPR / higher Survival Rate is better on the Protected Shelf; higher True-Positive Rate (TPR) is better on expected-unkawaii real audio.");
  lines.push("");
  lines.push("| Evaluation Group | Clips | `core_veto` (F1–F6) Survival (FPR) | `shelf_veto` (In-Sample) Survival (FPR) | `veto_all` (F1–F32) Survival (FPR) |");
  lines.push("| :--- | ---: | ---: | ---: | ---: |");
  lines.push(
    `| **\`tokiko-axis\` Japanese Speech** (\`kawaii\`/\`amae\`/\`genki\` × 3) | ${tokikoAudit.shelfSize} | **${pct(tokikoAudit.shelfSurvivalRate.core6Survived, tokikoAudit.shelfSize)}** (${tokikoAudit.shelfSurvivalRate.core6Survived}/${tokikoAudit.shelfSize}; FPR ${pct(tokikoAudit.shelfSize - tokikoAudit.shelfSurvivalRate.core6Survived, tokikoAudit.shelfSize)}) | **${pct(shelfVetoSummary.tokikoSurvived, tokikoAudit.shelfSize)}** (${shelfVetoSummary.tokikoSurvived}/${tokikoAudit.shelfSize}; FPR ${pct(tokikoAudit.shelfSize - shelfVetoSummary.tokikoSurvived, tokikoAudit.shelfSize)}) | **${pct(tokikoAudit.shelfSurvivalRate.fullSurvived, tokikoAudit.shelfSize)}** (${tokikoAudit.shelfSurvivalRate.fullSurvived}/${tokikoAudit.shelfSize}; FPR ${pct(tokikoAudit.shelfSize - tokikoAudit.shelfSurvivalRate.fullSurvived, tokikoAudit.shelfSize)}) |`
  );
  lines.push(
    `| **Benign Real Audio (PD / CC0 only)** (deduped) | ${pdCc0Benign.length} | **${pct(pdCc0CoreSurvived, pdCc0Benign.length)}** (${pdCc0CoreSurvived}/${pdCc0Benign.length}; FPR ${pct(pdCc0Benign.length - pdCc0CoreSurvived, pdCc0Benign.length)}) | **${pct(pdCc0ShelfSurvived, pdCc0Benign.length)}** (${pdCc0ShelfSurvived}/${pdCc0Benign.length}; FPR ${pct(pdCc0Benign.length - pdCc0ShelfSurvived, pdCc0Benign.length)}) | **${pct(pdCc0AllSurvived, pdCc0Benign.length)}** (${pdCc0AllSurvived}/${pdCc0Benign.length}; FPR ${pct(pdCc0Benign.length - pdCc0AllSurvived, pdCc0Benign.length)}) |`
  );
  lines.push(
    `| **Benign Real Wikimedia Audio (All)** (deduped by SHA-256) | ${benignRealAudit.shelfSize} | **${pct(benignRealAudit.shelfSurvivalRate.core6Survived, benignRealAudit.shelfSize)}** (${benignRealAudit.shelfSurvivalRate.core6Survived}/${benignRealAudit.shelfSize}; FPR ${pct(benignRealAudit.shelfSize - benignRealAudit.shelfSurvivalRate.core6Survived, benignRealAudit.shelfSize)}) | **${pct(shelfVetoSummary.benignRealSurvived, benignRealAudit.shelfSize)}** (${shelfVetoSummary.benignRealSurvived}/${benignRealAudit.shelfSize}; FPR ${pct(benignRealAudit.shelfSize - shelfVetoSummary.benignRealSurvived, benignRealAudit.shelfSize)}) | **${pct(benignRealAudit.shelfSurvivalRate.fullSurvived, benignRealAudit.shelfSize)}** (${benignRealAudit.shelfSurvivalRate.fullSurvived}/${benignRealAudit.shelfSize}; FPR ${pct(benignRealAudit.shelfSize - benignRealAudit.shelfSurvivalRate.fullSurvived, benignRealAudit.shelfSize)}) |`
  );
  lines.push(
    `| **Combined Protected Shelf** (\`tokiko\` + Benign Real) | ${combinedShelfAudit.shelfSize} | **${pct(combinedShelfAudit.shelfSurvivalRate.core6Survived, combinedShelfAudit.shelfSize)}** (${combinedShelfAudit.shelfSurvivalRate.core6Survived}/${combinedShelfAudit.shelfSize}; FPR ${pct(combinedShelfAudit.shelfSize - combinedShelfAudit.shelfSurvivalRate.core6Survived, combinedShelfAudit.shelfSize)}) | **${pct(shelfVetoSummary.combinedSurvived, combinedShelfAudit.shelfSize)}** (${shelfVetoSummary.combinedSurvived}/${combinedShelfAudit.shelfSize}; FPR ${pct(combinedShelfAudit.shelfSize - shelfVetoSummary.combinedSurvived, combinedShelfAudit.shelfSize)}) | **${pct(combinedShelfAudit.shelfSurvivalRate.fullSurvived, combinedShelfAudit.shelfSize)}** (${combinedShelfAudit.shelfSurvivalRate.fullSurvived}/${combinedShelfAudit.shelfSize}; FPR ${pct(combinedShelfAudit.shelfSize - combinedShelfAudit.shelfSurvivalRate.fullSurvived, combinedShelfAudit.shelfSize)}) |`
  );
  lines.push("");

  // Out-of-sample generalization subsection
  const { leaveOneOut: loo, crossDomain } = generalization;
  const r2t = crossDomain.realToTokiko;
  const t2r = crossDomain.tokikoToReal;
  lines.push("### Out-of-Sample Generalization (`shelf_veto`: Leave-One-Out & Cross-Domain)");
  lines.push("");
  lines.push("In-sample `shelf_veto` survival (`19/19 = 100.0%`) is true by definition when `contestedIds` are chosen on the same 19 clips. To measure honest out-of-sample generalization, we hold out clips before computing `contestedIds`:");
  lines.push("");
  lines.push("| Generalization Protocol | Train Shelf -> Test Set | Out-of-Sample Survival (FPR) | Held-Out Failures (Clip -> Catching Axis) |");
  lines.push("| :--- | :--- | ---: | :--- |");
  const formatFailures = (fails) =>
    fails.length === 0
      ? "none"
      : fails.map((f) => `\`${f.id}\` (${f.caughtBy.map(shortAxisId).join(", ")})`).join("; ");
  lines.push(
    `| **Leave-One-Out (LOO)** | Other ${loo.total - 1} shelf clips -> held-out clip (×${loo.total}) | **${pct(loo.survived, loo.total)}** (${loo.survived}/${loo.total}; FPR ${pct(loo.total - loo.survived, loo.total)}) | ${formatFailures(loo.failures)} |`
  );
  lines.push(
    `| **Cross-Domain: Real -> \`tokiko\`** | ${r2t.trainSize} Benign Real (${r2t.trainContestedCount} contested) -> ${r2t.total} \`tokiko\` | **${pct(r2t.survived, r2t.total)}** (${r2t.survived}/${r2t.total}; FPR ${pct(r2t.total - r2t.survived, r2t.total)}) | ${formatFailures(r2t.failures)} |`
  );
  lines.push(
    `| **Cross-Domain: \`tokiko\` -> Real** | ${t2r.trainSize} \`tokiko\` (${t2r.trainContestedCount} contested) -> ${t2r.total} Benign Real | **${pct(t2r.survived, t2r.total)}** (${t2r.survived}/${t2r.total}; FPR ${pct(t2r.total - t2r.survived, t2r.total)}) | ${formatFailures(t2r.failures)} |`
  );
  lines.push("");

  lines.push("### Expected-Unkawaii Real Audio Detection (True-Positive Recall & Exact Reasons)");
  lines.push("");
  lines.push(`On the **${expectedUnkawaiiCount}** unique expected-unkawaii real clips (cat hiss, alarm siren, 60Hz hum+click injection, wild boar growl, giant canine growl):`);
  lines.push(`- \`core_veto\` (F1–F6) caught **${expectedUnkawaiiSummary.coreCaught}/${expectedUnkawaiiCount}** (${pct(expectedUnkawaiiSummary.coreCaught, expectedUnkawaiiCount)})`);
  lines.push(`- \`shelf_veto\` (${combinedShelfAudit.clearedCount} shelf-cleared axes) caught **${expectedUnkawaiiSummary.shelfCaught}/${expectedUnkawaiiCount}** (${pct(expectedUnkawaiiSummary.shelfCaught, expectedUnkawaiiCount)}) — LOO across ${loo.total} folds: **${loo.expectedUnkawaiiRecall.minCaught}–${loo.expectedUnkawaiiRecall.maxCaught}/${expectedUnkawaiiCount}** (mean ${loo.expectedUnkawaiiRecall.meanCaught}/${expectedUnkawaiiCount})`);
  lines.push(`- \`veto_all\` (F1–F32) caught **${expectedUnkawaiiSummary.allCaught}/${expectedUnkawaiiCount}** (${pct(expectedUnkawaiiSummary.allCaught, expectedUnkawaiiCount)})`);
  lines.push("");
  lines.push("| Clip ID | Title | `core_veto` Triggered | `shelf_veto` Triggered (Cleared Axes) | `veto_all` Triggered |");
  lines.push("| :--- | :--- | :--- | :--- | :--- |");
  for (const c of expectedUnkawaiiSummary.clips) {
    const coreTxt = c.coreTriggered.length ? c.coreTriggered.map((id) => `\`${id}\``).join(", ") : "MISS";
    const shelfTxt = c.shelfTriggered.length ? c.shelfTriggered.map((id) => `\`${id}\``).join(", ") : "MISS";
    const allTxt = c.allTriggered.length ? c.allTriggered.map((id) => `\`${id}\``).join(", ") : "MISS";
    lines.push(`| \`${c.id}\` | ${c.title} | ${coreTxt} | ${shelfTxt} | ${allTxt} |`);
  }
  lines.push("");
  lines.push("This confirms why **`--policy core_veto`** is the default (Core-6 hard veto + `TOOLBOX_FALSIFIERS` F7–F32 as non-vetoing diagnostics, `F30` in `ORTHOGONAL_AXES`), and why **`--policy shelf_veto --contested ...`** plus persistent ear-precedent memory ([`ear_precedents.json`](./ear_precedents.json)) are provided.");
  lines.push("");

  // Section B
  lines.push("## B. Axes Marked `CONTESTED` by the Protected Shelf");
  lines.push("");
  lines.push("Any falsifier that rejects ≥ 1 clip on the Combined Protected Shelf is formally marked **`CONTESTED`** by `auditFalsifiersAgainstShelf` (`src/shelf.mjs`). Under `--policy shelf_veto`, its veto power is suspended until calibrated or reclassified.");
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
  lines.push("| Clip ID | Utterance | Preset | `core_veto` | `shelf_veto` | `veto_all` Triggered Axes | F0 med | Jitter | MPS 30–150 | Subh |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: |");
  for (const c of perClipTokiko) {
    const coreTxt = c.coreTriggered.length ? c.coreTriggered.map(shortAxisId).join(", ") : "PASS";
    const shelfTxt = c.shelfTriggered.length ? c.shelfTriggered.map(shortAxisId).join(", ") : "PASS";
    const allTxt = c.allTriggered.length ? c.allTriggered.map(shortAxisId).join(", ") : "CLEAN";
    lines.push(`| \`${c.id}\` | ${c.utterance} | \`${c.preset}\` | ${coreTxt} | ${shelfTxt} | ${allTxt} | ${c.f0MedianHz} Hz | ${c.jitter} | ${c.mpsRoughness30_150} | ${c.subharmonicRatio} |`);
  }
  lines.push("");

  lines.push("### Per-Clip Breakdown: Real Wikimedia Commons Audio (20 clips)");
  lines.push("");
  lines.push("| Clip ID | Suite | Group | Title | License | SHA-256 | `core_veto` | `shelf_veto` | `veto_all` Triggered Axes | MPS 30–150 | Subh |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | :---: | :--- | :--- | :--- | ---: | ---: |");
  for (const c of perClipReal) {
    const coreTxt = c.coreTriggered.length ? c.coreTriggered.map(shortAxisId).join(", ") : "PASS";
    const shelfTxt = c.shelfTriggered.length ? c.shelfTriggered.map(shortAxisId).join(", ") : "PASS";
    const allTxt = c.allTriggered.length ? c.allTriggered.map(shortAxisId).join(", ") : "CLEAN";
    lines.push(`| \`${c.id}\` | ${c.suite} | \`${c.auditGroup}\` | ${c.title} | ${c.license} | ${c.sha256Match ? "✅" : "⚠️"} | ${coreTxt} | ${shelfTxt} | ${allTxt} | ${c.mpsRoughness30_150} | ${c.subharmonicRatio} |`);
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

  // Section D: v0.5 Neuroscience Lenses
  if (neuroscienceLenses) {
    const g = neuroscienceLenses.groups;
    const sep = neuroscienceLenses.separation;
    const fmtStats = (s) => `mean **${s.mean}** (min ${s.min}, max ${s.max})`;
    lines.push("## D. Neuroscience DSP Lenses (v0.5): Arnal MPS 30–150 Hz Roughness & Nonlinear Subharmonics");
    lines.push("");
    lines.push("Honest real-audio evaluation of `mpsRoughness30_150` & `mpsRoughToSpeechRatio` (Arnal et al. 2015/2025) and `subharmonicRatio` (Wilden et al. 1998 / Fitch et al. 2002 / Anikin 2020) across the 19 Protected Shelf clips vs 5 Expected-Unkawaii clips:");
    lines.push("");
    lines.push("| Group | Clips | `mpsRoughness30_150` | `mpsRoughToSpeechRatio` | `subharmonicRatio` |");
    lines.push("| :--- | ---: | :--- | :--- | :--- |");
    lines.push(`| **\`tokiko-axis\` Speech Shelf** | ${g.tokikoShelf.count} | ${fmtStats(g.tokikoShelf.mpsRoughness30_150)} | ${fmtStats(g.tokikoShelf.mpsRoughToSpeechRatio)} | ${fmtStats(g.tokikoShelf.subharmonicRatio)} |`);
    lines.push(`| **Benign Real Wikimedia Shelf** | ${g.benignRealShelf.count} | ${fmtStats(g.benignRealShelf.mpsRoughness30_150)} | ${fmtStats(g.benignRealShelf.mpsRoughToSpeechRatio)} | ${fmtStats(g.benignRealShelf.subharmonicRatio)} |`);
    lines.push(`| **Combined Protected Shelf** | ${g.combinedShelf.count} | ${fmtStats(g.combinedShelf.mpsRoughness30_150)} | ${fmtStats(g.combinedShelf.mpsRoughToSpeechRatio)} | ${fmtStats(g.combinedShelf.subharmonicRatio)} |`);
    lines.push(`| **Expected-Unkawaii Real Audio** | ${g.expectedUnkawaii.count} | ${fmtStats(g.expectedUnkawaii.mpsRoughness30_150)} | ${fmtStats(g.expectedUnkawaii.mpsRoughToSpeechRatio)} | ${fmtStats(g.expectedUnkawaii.subharmonicRatio)} |`);
    lines.push("");
    lines.push(`- **Zero-FP Separation Check (\`mpsRoughness30_150\`)**: Combined Protected Shelf max = \`${sep.mpsRoughness30_150.shelfMax}\` (\`tokiko\` max = \`${sep.mpsRoughness30_150.tokikoMax}\`). Expected-Unkawaii clips strictly above combined shelf max: **${sep.mpsRoughness30_150.unkawaiiAboveCombinedShelfMax.length}/${expectedUnkawaiiCount}** (${sep.mpsRoughness30_150.unkawaiiAboveCombinedShelfMax.length ? sep.mpsRoughness30_150.unkawaiiAboveCombinedShelfMax.map((id) => `\`${id}\``).join(", ") : "none"}); strictly above \`tokiko\` max: **${sep.mpsRoughness30_150.unkawaiiAboveTokikoMax.length}/${expectedUnkawaiiCount}** (${sep.mpsRoughness30_150.unkawaiiAboveTokikoMax.length ? sep.mpsRoughness30_150.unkawaiiAboveTokikoMax.map((id) => `\`${id}\``).join(", ") : "none"}).`);
    lines.push(`- **Zero-FP Separation Check (\`subharmonicRatio\`)**: Combined Protected Shelf max = \`${sep.subharmonicRatio.shelfMax}\`. Expected-Unkawaii clips strictly above combined shelf max: **${sep.subharmonicRatio.unkawaiiAboveCombinedShelfMax.length}/${expectedUnkawaiiCount}** (${sep.subharmonicRatio.unkawaiiAboveCombinedShelfMax.length ? sep.subharmonicRatio.unkawaiiAboveCombinedShelfMax.map((id) => `\`${id}\``).join(", ") : "none"}).`);
    lines.push("");
    lines.push("| Expected-Unkawaii Clip | Title | `mpsSpeech4_16` | `mpsRoughness30_150` | `mpsRoughToSpeechRatio` | `subharmonicRatio` |");
    lines.push("| :--- | :--- | ---: | ---: | ---: | ---: |");
    for (const c of neuroscienceLenses.perClipExpectedUnkawaii) {
      lines.push(`| \`${c.id}\` | ${c.title} | ${c.mpsSpeech4_16} | ${c.mpsRoughness30_150} | ${c.mpsRoughToSpeechRatio} | ${c.subharmonicRatio} |`);
    }
    lines.push("");
  }

  // Section E: v0.6 Voice Compass
  if (summary.voiceCompass) {
    const vc = summary.voiceCompass;
    const fmtStats = (s) => `mean **${s.mean}** (min ${s.min}, max ${s.max})`;
    lines.push("## E. Voice Compass (`respiratoryScore` × `directnessScore`, v0.6)");
    lines.push("");
    lines.push("> *「声って、誰かに聞かせるために出した音で、呼吸器を使ったもの かな」* — Diagnostic 2D lens (never a hard veto) decomposing **finite-lung respiratory signature (`RESP`)** × **listener-addressed communicative directness (`DIR`)** across all 20 Wikimedia Commons clips + 9 `tokiko-axis` clips.");
    lines.push("");
    lines.push("| Group | Clips | `respiratoryScore` | `directnessScore` | Quadrant Counts |");
    lines.push("| :--- | ---: | :--- | :--- | :--- |");
    const fmtQuads = (q) =>
      Object.entries(q)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `\`${k}\`: ${n}`)
        .join(", ");
    for (const [name, g] of [
      ["`tokiko-axis` Speech", vc.groups.tokiko],
      ["Benign Real Wikimedia", vc.groups.benignReal],
      ["Historical Recordings", vc.groups.historical],
      ["Expected-Unkawaii Real", vc.groups.expectedUnkawaii],
    ]) {
      lines.push(`| **${name}** | ${g.count} | ${fmtStats(g.respiratoryScore)} | ${fmtStats(g.directnessScore)} | ${fmtQuads(g.quadrants)} |`);
    }
    lines.push("");
    lines.push("| Clip ID | Group | Title / Utterance | `RESP` | `DIR` | Quadrant (`voiceCompassLabel`) |");
    lines.push("| :--- | :--- | :--- | ---: | ---: | :--- |");
    for (const c of vc.perClip) {
      lines.push(`| \`${c.id}\` | \`${c.group}\` | ${c.title} | ${c.respiratoryScore.toFixed(2)} | ${c.directnessScore.toFixed(2)} | \`${c.voiceCompassLabel}\` |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const kudaPath = resolveKudaPath(opts.tokikoDir);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  const resolvedWavsById = new Map();
  const realLoaded = [];
  const missing = [];

  for (const clip of manifest.clips) {
    let wavPath = resolveClipWavPath(clip, manifest, opts.cacheDirs);
    if (!wavPath && opts.fetch) {
      const targetDir = opts.cacheDirs[0] || path.join(__dirname, ".cache_wav");
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

  const tokikoItems = await synthesizeTokikoClips(kudaPath);

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

  // Run Protected Shelf Audits via src/shelf.mjs FIRST so shelf_veto uses combinedShelfAudit.contestedIds
  const tokikoAudit = auditFalsifiersAgainstShelf(tokikoItems, DEFAULT_FALSIFIERS);
  const benignRealAudit = auditFalsifiersAgainstShelf(benignShelfItems, DEFAULT_FALSIFIERS);
  const combinedShelfAudit = auditFalsifiersAgainstShelf([...tokikoItems, ...benignShelfItems], DEFAULT_FALSIFIERS);
  const contestedIds = combinedShelfAudit.contestedIds || [];
  const contestedSet = new Set(contestedIds);

  const shelfVetoSummary = {
    contestedCount: contestedIds.length,
    clearedCount: combinedShelfAudit.clearedCount,
    tokikoSurvived: countShelfVetoSurvival(tokikoAudit.items, contestedSet),
    benignRealSurvived: countShelfVetoSurvival(benignRealAudit.items, contestedSet),
    combinedSurvived: countShelfVetoSurvival(combinedShelfAudit.items, contestedSet),
  };

  // Analyze all real clips across core_veto, shelf_veto, veto_all
  const perClipReal = realLoaded.map(({ clip, actualSha, sha256Match, samples, sampleRate }) => {
    const analysis = analyzePolicies(samples, sampleRate, clip.id, contestedSet);
    return {
      id: clip.id,
      suite: clip.suite,
      title: clip.title,
      category: clip.category,
      auditGroup: clip.auditGroup,
      sourceUrl: clip.sourceUrl,
      license: clip.license,
      licenseUrl: clip.licenseUrl ?? null,
      artist: clip.artist ?? null,
      sha256: actualSha,
      sha256Match,
      ...analysis,
    };
  });

  // Analyze all tokiko clips across core_veto, shelf_veto, veto_all
  const perClipTokiko = tokikoItems.map((item) => {
    const analysis = analyzePolicies(item.samples, item.sampleRate, item.id, contestedSet);
    return {
      id: item.id,
      utterance: item.utterance,
      preset: item.preset,
      source: item.source,
      ...analysis,
    };
  });

  // Strict runtime invariant: per-item shelf_veto verdicts MUST match shelfTriggered.length === 0 AND summary counts
  for (const rec of [...perClipReal, ...perClipTokiko]) {
    const survived = rec.verdictShelfVeto === "SURVIVED_KAWAII_CANDIDATE";
    if (survived !== (rec.shelfTriggered.length === 0)) {
      throw new Error(
        `Per-clip shelf_veto mismatch on ${rec.id}: verdictShelfVeto=${rec.verdictShelfVeto}, shelfTriggered=[${rec.shelfTriggered.join(", ")}]`
      );
    }
  }
  const perClipTokikoShelfSurvived = perClipTokiko.filter(
    (c) => c.verdictShelfVeto === "SURVIVED_KAWAII_CANDIDATE"
  ).length;
  if (perClipTokikoShelfSurvived !== shelfVetoSummary.tokikoSurvived) {
    throw new Error(
      `Summary vs per-clip mismatch on tokiko shelf_veto: summary=${shelfVetoSummary.tokikoSurvived}, perClip=${perClipTokikoShelfSurvived}`
    );
  }
  const benignShelfIds = new Set(benignShelfItems.map((b) => b.id));
  const perClipBenignShelfSurvived = perClipReal.filter(
    (c) => benignShelfIds.has(c.id) && c.verdictShelfVeto === "SURVIVED_KAWAII_CANDIDATE"
  ).length;
  if (perClipBenignShelfSurvived !== shelfVetoSummary.benignRealSurvived) {
    throw new Error(
      `Summary vs per-clip mismatch on benign real shelf_veto: summary=${shelfVetoSummary.benignRealSurvived}, perClip=${perClipBenignShelfSurvived}`
    );
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
    shelfCaught: expectedUnkawaiiEntries.filter((c) => c.shelfTriggered.length > 0).length,
    allCaught: expectedUnkawaiiEntries.filter((c) => c.allTriggered.length > 0).length,
    clips: expectedUnkawaiiEntries.map((c) => ({
      id: c.id,
      title: c.title,
      coreTriggered: c.coreTriggered,
      shelfTriggered: c.shelfTriggered,
      allTriggered: c.allTriggered,
    })),
  };

  // Out-of-sample generalization: Leave-One-Out (LOO) & Cross-Domain
  const generalization = computeGeneralization(
    tokikoAudit,
    benignRealAudit,
    combinedShelfAudit,
    expectedUnkawaiiEntries
  );

  // Deduplicated benign real entries for v0.5 neuroscience lens evaluation
  const benignRealEntries = perClipReal.filter((c) => benignShelfIds.has(c.id));
  const neuroscienceLenses = computeNeuroscienceLensSummary(
    perClipTokiko,
    benignRealEntries,
    expectedUnkawaiiEntries
  );

  const countQuads = (items) => {
    const q = {
      addressed_breath: 0,
      distant_or_private_breath: 0,
      non_breath_signal: 0,
      ambient_or_hollow: 0,
    };
    for (const it of items) {
      if (it.voiceCompassLabel in q) q[it.voiceCompassLabel]++;
    }
    return q;
  };
  const summarizeCompassGroup = (items) => ({
    count: items.length,
    respiratoryScore: summarizeMetric(items, "respiratoryScore"),
    directnessScore: summarizeMetric(items, "directnessScore"),
    quadrants: countQuads(items),
  });
  const historicalRealEntries = perClipReal.filter((c) => c.auditGroup === "historical_recording");
  const voiceCompass = {
    groups: {
      tokiko: summarizeCompassGroup(perClipTokiko),
      benignReal: summarizeCompassGroup(benignRealEntries),
      historical: summarizeCompassGroup(historicalRealEntries),
      expectedUnkawaii: summarizeCompassGroup(expectedUnkawaiiEntries),
    },
    perClip: [
      ...perClipTokiko.map((c) => ({
        id: c.id,
        group: "tokiko",
        title: `${c.preset}:${c.utterance}`,
        respiratoryScore: c.respiratoryScore,
        directnessScore: c.directnessScore,
        voiceCompassLabel: c.voiceCompassLabel,
      })),
      ...perClipReal.map((c) => ({
        id: c.id,
        group: c.auditGroup,
        title: c.title,
        respiratoryScore: c.respiratoryScore,
        directnessScore: c.directnessScore,
        voiceCompassLabel: c.voiceCompassLabel,
      })),
    ],
  };

  const generatedAt = new Date().toISOString();
  const resultsObj = {
    schema: "yata_real_audio_audit/v0.6",
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
    shelfVetoSummary,
    generalization,
    expectedUnkawaiiSummary,
    neuroscienceLenses,
    voiceCompass,
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
