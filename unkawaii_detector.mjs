#!/usr/bin/env node
/**
 * unkawaii_detector.mjs — LLM-Friendly Multidimensional "Unkawaii" Falsifier & Audio Vision (v0.2)
 *
 * 0th Axiom:
 *   "Discover 'unkawaii' across multiple dimensions. If all falsifiers fail, it survives as 'kawaii'."
 *
 * Zero dependencies. Pure JavaScript (ES Module + Node.js CLI).
 * 100% backward-compatible with v0.1 programmatic exports and CLI usage.
 *
 * Usage:
 *   node unkawaii_detector.mjs <file.wav> [--format llm|json] [--verbose] [--falsifiers all|core]
 *                                         [--view [micro|compact|full]] [--zoom [auto|<t0>..<t1>]]
 *                                         [--charset ascii|unicode] [--width <N>]
 *                                         [--svg <out.svg>] [--png <out.png>]
 *   node unkawaii_detector.mjs --compare <a.wav> <b.wav> [--format llm|json] [--verbose] [--view [micro|compact|full]] [--svg <out.svg>] [--png <out.png>]
 *   node unkawaii_detector.mjs --diff <a.wav> <b.wav> [--charset ascii|unicode] [--width <N>] [--svg <out.svg>] [--png <out.png>]
 *   node unkawaii_detector.mjs --discover [--format llm|json] [--view]
 *   node unkawaii_detector.mjs --list-falsifiers [--format llm|json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeWavBuffer, encodeWavBuffer } from "./src/wav.mjs";
import {
  extractFeatures,
  extractAudioProfile,
  extractSegmentTimeline,
  computeBreathPauseProfile,
  computeVoiceCompass,
  computeSanitizationIndex,
} from "./src/features.mjs";
import {
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
  ORTHOGONAL_AXES,
  TOOLBOX_FALSIFIERS,
  createFalsifiers,
} from "./src/falsifiers/index.mjs";
import { analyzeSamples, compareReports, formatForLLM, formatCompareForLLM } from "./src/report.mjs";
import {
  auditFalsifiersAgainstShelf,
  formatShelfAuditForLLM,
  loadEarPrecedents,
  applyEarPrecedents,
} from "./src/shelf.mjs";
import {
  renderTextVision,
  renderTextDiff,
  renderSegmentTimeline,
  renderTimelineDiff,
  renderSvgVision,
  renderSvgDiff,
  renderPngVision,
  renderPngDiff,
} from "./src/visualize/index.mjs";
import { findTimelineHotspot, generateCounterfactualSlice } from "./src/counterfactual.mjs";
import { analyzeDialogue, renderDialogueMap } from "./src/dialogue.mjs";
import { buildCorpus } from "./src/synth.mjs";
import { runDiscoveryLoop, formatDiscoveryForLLM } from "./src/discovery.mjs";

// ============================================================================
// Public Programmatic API (v0.1 backward-compatible + v0.2–v0.7 extensions)
// ============================================================================
export {
  // v0.1 core exports
  decodeWavBuffer,
  extractFeatures,
  DEFAULT_FALSIFIERS,
  analyzeSamples,
  compareReports,
  formatForLLM,
  formatCompareForLLM,
  // v0.2 extensions
  encodeWavBuffer,
  extractAudioProfile,
  ORIGINAL_6_FALSIFIERS,
  createFalsifiers,
  renderTextVision,
  renderTextDiff,
  renderSvgVision,
  renderSvgDiff,
  renderPngVision,
  renderPngDiff,
  buildCorpus,
  runDiscoveryLoop,
  formatDiscoveryForLLM,
  // v0.3 extensions
  ORTHOGONAL_AXES,
  TOOLBOX_FALSIFIERS,
  auditFalsifiersAgainstShelf,
  formatShelfAuditForLLM,
  // v0.5 extensions
  extractSegmentTimeline,
  renderSegmentTimeline,
  loadEarPrecedents,
  applyEarPrecedents,
  // v0.6 extensions
  computeBreathPauseProfile,
  computeVoiceCompass,
  renderTimelineDiff,
  findTimelineHotspot,
  generateCounterfactualSlice,
  // v0.7 extensions
  computeSanitizationIndex,
  analyzeDialogue,
  renderDialogueMap,
};

// ============================================================================
// CLI Argument Parser & Runner
// ============================================================================
const USAGE = `Usage:
  node unkawaii_detector.mjs <file.wav> [--format llm|json] [--verbose] [--falsifiers all|core]
                                        [--policy core_veto|veto_all|shelf_veto] [--contested <ID1,ID2,...>]
                                        [--precedents <path.json> | --shelf <path.json>] [--scope <scope>]
                                        [--view [micro|compact|full]] [--zoom [auto|<t0>..<t1>]] [--timeline]
                                        [--counterfactual <out.wav> [--cf-window <t0>..<t1>] [--cf-mode soften_mps|breath_tail]]
                                        [--charset ascii|unicode] [--width <N>]
                                        [--svg <out.svg>] [--png <out.png>]
  node unkawaii_detector.mjs --compare <a.wav> <b.wav> [--format llm|json] [--verbose] [--falsifiers all|core]
                                                       [--policy core_veto|veto_all|shelf_veto] [--contested <ID1,ID2,...>]
                                                       [--precedents <path.json> | --shelf <path.json>] [--scope <scope>]
                                                       [--view [micro|compact|full]] [--timeline] [--svg <out.svg>] [--png <out.png>]
  node unkawaii_detector.mjs --diff <a.wav> <b.wav> [--falsifiers all|core] [--policy core_veto|veto_all|shelf_veto]
                                                    [--contested <ID1,ID2,...>] [--timeline]
                                                    [--charset ascii|unicode] [--width <N>]
                                                    [--svg <out.svg>] [--png <out.png>]
  node unkawaii_detector.mjs --timeline-diff <a.wav> <b.wav> [--format llm|json] [--charset ascii|unicode] [--width <N>]
  node unkawaii_detector.mjs --dialogue <a.wav> <b.wav> [--format llm|json] [--charset ascii|unicode] [--width <N>]
  node unkawaii_detector.mjs --discover [--format llm|json] [--view] [--charset ascii|unicode]
  node unkawaii_detector.mjs --list-falsifiers [--format llm|json] [--falsifiers all|core]`;

const VIEW_MODES = new Set(["micro", "compact", "full"]);

function parseZoomArg(raw) {
  if (!raw || raw === "auto") return "auto";
  const m = /^(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) {
    throw new Error(`Invalid --zoom value "${raw}": expected "auto" or "<t0>..<t1>" (e.g. 0.1..0.4)`);
  }
  const startSec = Number.parseFloat(m[1]);
  const endSec = Number.parseFloat(m[2]);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw new Error(`Invalid --zoom range "${raw}": endSec must be greater than startSec`);
  }
  return { startSec, endSec };
}

function parseCliArgs(argv) {
  const opts = {
    help: false,
    mode: "single", // single | compare | diff | timeline_diff | dialogue | discover | list
    files: [],
    format: "llm",
    verbose: false,
    falsifiersSet: "all",
    policy: "core_veto",
    contestedIds: [],
    precedentsPath: null,
    scope: null,
    timeline: false,
    counterfactualOut: null,
    cfWindow: null, // null | { startSec, endSec }
    cfMode: "soften_mps", // soften_mps | breath_tail
    view: null, // null | "micro" | "compact" | "full"
    zoom: null, // null | "auto" | { startSec, endSec }
    charset: "ascii",
    width: 48,
    svgOut: null,
    pngOut: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }

    if (arg === "--compare") {
      opts.mode = "compare";
      const a = argv[++i];
      const b = argv[++i];
      if (!a || !b || a.startsWith("-") || b.startsWith("-")) {
        throw new Error("--compare requires two WAV file paths: --compare <a.wav> <b.wav>");
      }
      opts.files.push(a, b);
      continue;
    }

    if (arg === "--diff") {
      opts.mode = "diff";
      const a = argv[++i];
      const b = argv[++i];
      if (!a || !b || a.startsWith("-") || b.startsWith("-")) {
        throw new Error("--diff requires two WAV file paths: --diff <a.wav> <b.wav>");
      }
      opts.files.push(a, b);
      continue;
    }

    if (arg === "--timeline-diff") {
      opts.mode = "timeline_diff";
      const a = argv[++i];
      const b = argv[++i];
      if (!a || !b || a.startsWith("-") || b.startsWith("-")) {
        throw new Error("--timeline-diff requires two WAV file paths: --timeline-diff <a.wav> <b.wav>");
      }
      opts.files.push(a, b);
      continue;
    }

    if (arg === "--dialogue") {
      opts.mode = "dialogue";
      const a = argv[++i];
      const b = argv[++i];
      if (!a || !b || a.startsWith("-") || b.startsWith("-")) {
        throw new Error("--dialogue requires two WAV file paths: --dialogue <a.wav> <b.wav>");
      }
      opts.files.push(a, b);
      continue;
    }

    if (arg === "--discover") {
      opts.mode = "discover";
      continue;
    }

    if (arg === "--list-falsifiers") {
      opts.mode = "list";
      continue;
    }

    if (arg === "--format") {
      const val = argv[++i];
      if (val !== "llm" && val !== "json") {
        throw new Error(`Invalid --format "${val ?? ""}": expected "llm" or "json"`);
      }
      opts.format = val;
      continue;
    }

    if (arg === "--verbose") {
      opts.verbose = true;
      continue;
    }

    if (arg === "--falsifiers") {
      const val = argv[++i];
      if (val !== "all" && val !== "core") {
        throw new Error(`Invalid --falsifiers "${val ?? ""}": expected "all" or "core"`);
      }
      opts.falsifiersSet = val;
      continue;
    }

    if (arg === "--policy") {
      const val = argv[++i];
      if (val !== "core_veto" && val !== "veto_all" && val !== "shelf_veto") {
        throw new Error(
          `Invalid --policy "${val ?? ""}": expected "core_veto", "veto_all", or "shelf_veto"`
        );
      }
      opts.policy = val;
      continue;
    }

    if (arg === "--contested") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error("--contested requires a comma-separated list of falsifier IDs");
      }
      const parsedIds = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      opts.contestedIds.push(...parsedIds);
      continue;
    }

    if (arg === "--precedents" || arg === "--shelf") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error(`${arg} requires a JSON file path`);
      }
      opts.precedentsPath = val;
      continue;
    }

    if (arg === "--scope") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error("--scope requires a non-empty scope name (e.g. tokiko_japanese_speech)");
      }
      opts.scope = val.trim();
      continue;
    }

    if (arg === "--timeline") {
      opts.timeline = true;
      continue;
    }

    if (arg === "--counterfactual") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error("--counterfactual requires an output WAV file path");
      }
      opts.counterfactualOut = val;
      continue;
    }

    if (arg === "--cf-window") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error('--cf-window requires a time range "<t0>..<t1>" (e.g. 0.5..1.0)');
      }
      const parsed = parseZoomArg(val);
      if (parsed === "auto") {
        throw new Error('--cf-window requires an explicit range "<t0>..<t1>"');
      }
      opts.cfWindow = parsed;
      continue;
    }

    if (arg === "--cf-mode") {
      const val = argv[++i];
      if (val !== "soften_mps" && val !== "breath_tail") {
        throw new Error(`Invalid --cf-mode "${val ?? ""}": expected "soften_mps" or "breath_tail"`);
      }
      opts.cfMode = val;
      continue;
    }

    if (arg === "--view") {
      const next = argv[i + 1];
      if (next && VIEW_MODES.has(next)) {
        opts.view = next;
        i++;
      } else if (next && !next.startsWith("-") && opts.mode === "single" && opts.files.length > 0) {
        throw new Error(`Invalid --view mode "${next}": expected micro, compact, or full`);
      } else {
        opts.view = "compact";
      }
      continue;
    }

    if (arg === "--zoom") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        opts.zoom = parseZoomArg(next);
        i++;
      } else {
        opts.zoom = "auto";
      }
      continue;
    }

    if (arg === "--charset") {
      const val = argv[++i];
      if (val !== "ascii" && val !== "unicode") {
        throw new Error(`Invalid --charset "${val ?? ""}": expected "ascii" or "unicode"`);
      }
      opts.charset = val;
      continue;
    }

    if (arg === "--width") {
      const val = argv[++i];
      const parsed = Number.parseInt(val, 10);
      if (!Number.isFinite(parsed) || parsed < 16 || parsed > 240) {
        throw new Error(`Invalid --width "${val ?? ""}": expected integer between 16 and 240`);
      }
      opts.width = parsed;
      continue;
    }

    if (arg === "--svg") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error("--svg requires an output file path");
      }
      opts.svgOut = val;
      continue;
    }

    if (arg === "--png") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error("--png requires an output file path");
      }
      opts.pngOut = val;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown CLI flag: ${arg}`);
    }

    opts.files.push(arg);
  }

  return opts;
}

function loadWavFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`WAV file not found: ${filePath}`);
  }
  const buf = fs.readFileSync(filePath);
  return decodeWavBuffer(buf);
}

function runCli(argv) {
  const opts = parseCliArgs(argv);

  if (opts.help || argv.length === 0) {
    console.log(USAGE);
    return;
  }

  const falsifiers = opts.falsifiersSet === "core" ? ORIGINAL_6_FALSIFIERS : DEFAULT_FALSIFIERS;
  const precedentsOpt = opts.precedentsPath
    ? { precedents: loadEarPrecedents(opts.precedentsPath), scope: opts.scope }
    : {};

  if (opts.mode === "list") {
    const list = falsifiers.map((f) => ({ id: f.id, domain: f.domain, name: f.name }));
    if (opts.format === "json") {
      console.log(JSON.stringify(list, null, 2));
    } else {
      const lines = [`[UNKAWAII FALSIFIERS] (${list.length} active)`];
      for (const f of list) {
        lines.push(`  - ${f.id} [${f.domain}] ${f.name}`);
      }
      console.log(lines.join("\n"));
    }
    return;
  }

  if (opts.mode === "discover") {
    const res = runDiscoveryLoop({
      includeDossiers: Boolean(opts.view) || opts.format === "json",
      viewMode: opts.view || "micro",
      charset: opts.charset,
    });
    if (opts.format === "json") {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(formatDiscoveryForLLM(res, { view: Boolean(opts.view) }));
    }
    return;
  }

  if (opts.mode === "timeline_diff") {
    const [fileA, fileB] = opts.files;
    if (!fileA || !fileB) {
      throw new Error("--timeline-diff requires two WAV paths");
    }
    const wavA = loadWavFile(fileA);
    const wavB = loadWavFile(fileB);
    const tlA = extractSegmentTimeline(null, wavA.samples, wavA.sampleRate);
    const tlB = extractSegmentTimeline(null, wavB.samples, wavB.sampleRate);
    if (opts.format === "json") {
      console.log(JSON.stringify({ timelineA: tlA, timelineB: tlB }, null, 2));
    } else {
      console.log(renderTimelineDiff(tlA, tlB, { charset: opts.charset, width: opts.width }));
    }
    return;
  }

  if (opts.mode === "dialogue") {
    const [fileA, fileB] = opts.files;
    if (!fileA || !fileB) {
      throw new Error("--dialogue requires two WAV paths");
    }
    const wavA = loadWavFile(fileA);
    const wavB = loadWavFile(fileB);
    const dialogue = analyzeDialogue(wavA.samples, wavA.sampleRate, wavB.samples, wavB.sampleRate, {
      labelA: path.basename(fileA),
      labelB: path.basename(fileB),
    });
    if (opts.format === "json") {
      console.log(JSON.stringify(dialogue, null, 2));
    } else {
      console.log(renderDialogueMap(dialogue, { width: opts.width, charset: opts.charset }));
    }
    return;
  }

  if (opts.mode === "compare" || opts.mode === "diff") {
    const [fileA, fileB] = opts.files;
    if (!fileA || !fileB) {
      throw new Error(`--${opts.mode} requires two WAV paths`);
    }
    const wavA = loadWavFile(fileA);
    const wavB = loadWavFile(fileB);
    const chA = wavA.channels ? { channels: wavA.channels } : {};
    const chB = wavB.channels ? { channels: wavB.channels } : {};
    const contestedOpt = opts.contestedIds.length ? { contestedIds: opts.contestedIds } : {};
    const repA = analyzeSamples(wavA.samples, wavA.sampleRate, {
      label: path.basename(fileA),
      falsifiers,
      policy: opts.policy,
      ...contestedOpt,
      ...precedentsOpt,
      ...chA,
    });
    const repB = analyzeSamples(wavB.samples, wavB.sampleRate, {
      label: path.basename(fileB),
      falsifiers,
      policy: opts.policy,
      ...contestedOpt,
      ...precedentsOpt,
      ...chB,
    });

    const needProfiles =
      opts.mode === "diff" ||
      Boolean(opts.view) ||
      Boolean(opts.timeline) ||
      Boolean(opts.svgOut) ||
      Boolean(opts.pngOut);
    const profA = needProfiles ? extractAudioProfile(wavA.samples, wavA.sampleRate, chA) : null;
    const profB = needProfiles ? extractAudioProfile(wavB.samples, wavB.sampleRate, chB) : null;
    const tlA = opts.timeline ? extractSegmentTimeline(profA, wavA.samples, wavA.sampleRate) : null;
    const tlB = opts.timeline ? extractSegmentTimeline(profB, wavB.samples, wavB.sampleRate) : null;

    if (opts.svgOut) {
      fs.writeFileSync(opts.svgOut, renderSvgDiff(profA, profB, repA, repB), "utf8");
    }
    if (opts.pngOut) {
      fs.writeFileSync(opts.pngOut, renderPngDiff(profA, profB, repA, repB));
    }

    if (opts.mode === "diff") {
      const out = [
        renderTextDiff(profA, profB, repA, repB, {
          width: opts.width,
          charset: opts.charset,
        }),
      ];
      if (tlA && tlB) {
        out.push("", renderTimelineDiff(tlA, tlB, { charset: opts.charset, width: opts.width }));
      }
      console.log(out.join("\n"));
      return;
    }

    const cmp = compareReports(repA, repB);
    if (opts.format === "json") {
      const outObj = tlA && tlB ? { ...cmp, timelineA: tlA, timelineB: tlB } : cmp;
      console.log(JSON.stringify(outObj, null, 2));
    } else {
      const out = [formatCompareForLLM(cmp, { verbose: opts.verbose })];
      if (opts.view) {
        out.push(
          "",
          renderTextDiff(profA, profB, repA, repB, {
            width: opts.width,
            charset: opts.charset,
          })
        );
      }
      if (tlA && tlB) {
        out.push("", renderTimelineDiff(tlA, tlB, { charset: opts.charset, width: opts.width }));
      }
      console.log(out.join("\n"));
    }
    return;
  }

  // Single-file analysis
  const file = opts.files[0];
  if (!file) {
    throw new Error("Missing WAV file path");
  }
  const wav = loadWavFile(file);
  const chOpt = wav.channels ? { channels: wav.channels } : {};
  const contestedOpt = opts.contestedIds.length ? { contestedIds: opts.contestedIds } : {};
  const rep = analyzeSamples(wav.samples, wav.sampleRate, {
    label: path.basename(file),
    falsifiers,
    policy: opts.policy,
    ...contestedOpt,
    ...precedentsOpt,
    ...chOpt,
  });

  const needProfile =
    Boolean(opts.view) ||
    Boolean(opts.zoom) ||
    Boolean(opts.timeline) ||
    Boolean(opts.svgOut) ||
    Boolean(opts.pngOut);
  const profile = needProfile ? extractAudioProfile(wav.samples, wav.sampleRate, chOpt) : null;
  const timeline = opts.timeline ? extractSegmentTimeline(profile, wav.samples, wav.sampleRate) : null;

  let cfResult = null;
  if (opts.counterfactualOut) {
    cfResult = generateCounterfactualSlice(wav.samples, wav.sampleRate, {
      ...(opts.cfWindow || {}),
      mode: opts.cfMode,
      charset: opts.charset,
    });
    fs.writeFileSync(opts.counterfactualOut, encodeWavBuffer(cfResult.samples, cfResult.sampleRate));
  }

  if (opts.svgOut) {
    fs.writeFileSync(opts.svgOut, renderSvgVision(profile, rep), "utf8");
  }
  if (opts.pngOut) {
    fs.writeFileSync(opts.pngOut, renderPngVision(profile, rep));
  }

  if (opts.format === "json") {
    const outObj = { ...rep };
    if (timeline) outObj.timeline = timeline;
    if (cfResult) {
      outObj.counterfactual = {
        outputPath: opts.counterfactualOut,
        window: cfResult.window,
        mode: cfResult.mode,
        beforeTimeline: cfResult.beforeTimeline,
        afterTimeline: cfResult.afterTimeline,
      };
    }
    console.log(JSON.stringify(outObj, null, 2));
  } else if (opts.view || opts.zoom) {
    const parts = [
      renderTextVision(profile, rep, {
        mode: opts.view || "compact",
        width: opts.width,
        charset: opts.charset,
        zoom: opts.zoom,
      }),
    ];
    if (timeline) {
      parts.push("", renderSegmentTimeline(timeline, { charset: opts.charset }));
    }
    if (cfResult) {
      parts.push(
        "",
        `[YATA COUNTERFACTUAL] wrote ${opts.counterfactualOut} | window=${cfResult.window.startSec.toFixed(2)}..${cfResult.window.endSec.toFixed(2)}s mode=${cfResult.mode}`,
        cfResult.timelineDiff
      );
    }
    console.log(parts.join("\n"));
  } else {
    const parts = [formatForLLM(rep, { verbose: opts.verbose })];
    if (timeline) {
      parts.push("", renderSegmentTimeline(timeline, { charset: opts.charset }));
    }
    if (cfResult) {
      parts.push(
        "",
        `[YATA COUNTERFACTUAL] wrote ${opts.counterfactualOut} | window=${cfResult.window.startSec.toFixed(2)}..${cfResult.window.endSec.toFixed(2)}s mode=${cfResult.mode}`,
        cfResult.timelineDiff
      );
    }
    console.log(parts.join("\n"));
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const selfReal = fs.realpathSync(fileURLToPath(import.meta.url));
    const entryReal = fs.realpathSync(process.argv[1]);
    return selfReal === entryReal;
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  try {
    runCli(process.argv.slice(2));
  } catch (err) {
    console.error(`[yata] Error: ${err?.message || String(err)}`);
    process.exit(1);
  }
}