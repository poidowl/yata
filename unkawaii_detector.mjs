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
import { extractFeatures, extractAudioProfile } from "./src/features.mjs";
import {
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
  ORTHOGONAL_AXES,
  TOOLBOX_FALSIFIERS,
  createFalsifiers,
} from "./src/falsifiers/index.mjs";
import { analyzeSamples, compareReports, formatForLLM, formatCompareForLLM } from "./src/report.mjs";
import { auditFalsifiersAgainstShelf, formatShelfAuditForLLM } from "./src/shelf.mjs";
import {
  renderTextVision,
  renderTextDiff,
  renderSvgVision,
  renderSvgDiff,
  renderPngVision,
  renderPngDiff,
} from "./src/visualize/index.mjs";
import { buildCorpus } from "./src/synth.mjs";
import { runDiscoveryLoop, formatDiscoveryForLLM } from "./src/discovery.mjs";

// ============================================================================
// Public Programmatic API (v0.1 backward-compatible + v0.2/v0.3 extensions)
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
};

// ============================================================================
// CLI Argument Parser & Runner
// ============================================================================
const USAGE = `Usage:
  node unkawaii_detector.mjs <file.wav> [--format llm|json] [--verbose] [--falsifiers all|core]
                                        [--policy core_veto|veto_all|shelf_veto] [--contested <ID1,ID2,...>]
                                        [--view [micro|compact|full]] [--zoom [auto|<t0>..<t1>]]
                                        [--charset ascii|unicode] [--width <N>]
                                        [--svg <out.svg>] [--png <out.png>]
  node unkawaii_detector.mjs --compare <a.wav> <b.wav> [--format llm|json] [--verbose] [--falsifiers all|core]
                                                       [--policy core_veto|veto_all|shelf_veto] [--contested <ID1,ID2,...>]
                                                       [--view [micro|compact|full]] [--svg <out.svg>] [--png <out.png>]
  node unkawaii_detector.mjs --diff <a.wav> <b.wav> [--falsifiers all|core] [--policy core_veto|veto_all|shelf_veto]
                                                    [--contested <ID1,ID2,...>]
                                                    [--charset ascii|unicode] [--width <N>]
                                                    [--svg <out.svg>] [--png <out.png>]
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
    mode: "single", // single | compare | diff | discover | list
    files: [],
    format: "llm",
    verbose: false,
    falsifiersSet: "all",
    policy: "core_veto",
    contestedIds: [],
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
      ...chA,
    });
    const repB = analyzeSamples(wavB.samples, wavB.sampleRate, {
      label: path.basename(fileB),
      falsifiers,
      policy: opts.policy,
      ...contestedOpt,
      ...chB,
    });

    const needProfiles = opts.mode === "diff" || Boolean(opts.view) || Boolean(opts.svgOut) || Boolean(opts.pngOut);
    const profA = needProfiles ? extractAudioProfile(wavA.samples, wavA.sampleRate, chA) : null;
    const profB = needProfiles ? extractAudioProfile(wavB.samples, wavB.sampleRate, chB) : null;

    if (opts.svgOut) {
      fs.writeFileSync(opts.svgOut, renderSvgDiff(profA, profB, repA, repB), "utf8");
    }
    if (opts.pngOut) {
      fs.writeFileSync(opts.pngOut, renderPngDiff(profA, profB, repA, repB));
    }

    if (opts.mode === "diff") {
      console.log(
        renderTextDiff(profA, profB, repA, repB, {
          width: opts.width,
          charset: opts.charset,
        })
      );
      return;
    }

    const cmp = compareReports(repA, repB);
    if (opts.format === "json") {
      console.log(JSON.stringify(cmp, null, 2));
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
    ...chOpt,
  });

  const needProfile = Boolean(opts.view) || Boolean(opts.zoom) || Boolean(opts.svgOut) || Boolean(opts.pngOut);
  const profile = needProfile ? extractAudioProfile(wav.samples, wav.sampleRate, chOpt) : null;

  if (opts.svgOut) {
    fs.writeFileSync(opts.svgOut, renderSvgVision(profile, rep), "utf8");
  }
  if (opts.pngOut) {
    fs.writeFileSync(opts.pngOut, renderPngVision(profile, rep));
  }

  if (opts.format === "json") {
    console.log(JSON.stringify(rep, null, 2));
  } else if (opts.view || opts.zoom) {
    console.log(
      renderTextVision(profile, rep, {
        mode: opts.view || "compact",
        width: opts.width,
        charset: opts.charset,
        zoom: opts.zoom,
      })
    );
  } else {
    console.log(formatForLLM(rep, { verbose: opts.verbose }));
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