#!/usr/bin/env node
/**
 * bench/build_mirror_audit_demo.mjs — Blind Mirror Audit HTML Demo Builder (v0.4)
 *
 * Implements Observer #1's proposal & v0.4 3-choice upgrade:
 *   "First listen blind to 'naru' original vs a version altered just to clear F24.
 *    Next, place a 3rd take that keeps the Japanese accent hill while damping only
 *    the periodic oscillation F24 caught — that's where we discover what part of the
 *    phrasing the ear actually loves."
 *
 * Generates `bench/mirror_audit_demo.html`:
 *   - 100% self-contained single-file HTML (zero external URLs, embedded PCM16 WAV base64)
 *   - 3 blind 3-choice "なる" tests (Original vs Accent-Kept/Vibrato-Damped vs Fully Flat)
 *     plus 3 blind 2-choice tests for longer utterances, with randomized Take X / Y / Z order
 *   - Labels and yata verdicts are strictly hidden until the user votes
 *   - Post-vote reveal shows exact core_veto, veto_all, and F24 score/depth/range for each take
 *
 * Usage:
 *   node bench/build_mirror_audit_demo.mjs [--tokiko-dir <path>]
 *
 * Zero external dependencies. Pure ES Module.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  encodeWavBuffer,
  analyzeSamples,
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
} from "../unkawaii_detector.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_HTML = path.join(__dirname, "mirror_audit_demo.html");
const SR = 24000;

function resolveKudaPath(argv) {
  let dirOrFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tokiko-dir" && argv[i + 1]) {
      dirOrFile = argv[++i];
    } else if (argv[i].startsWith("--tokiko-dir=")) {
      dirOrFile = argv[i].slice("--tokiko-dir=".length);
    }
  }
  const base = dirOrFile || process.env.TOKIKO_PATH || path.resolve(REPO_ROOT, "../tokiko-axis");
  const resolved = path.resolve(base);
  return resolved.endsWith(".mjs") ? resolved : path.join(resolved, "kuda.mjs");
}

function lowpass1Pole(samples, sr, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sr;
  const a = dt / (rc + dt);
  const out = new Float32Array(samples.length);
  let y = 0;
  for (let i = 0; i < samples.length; i++) {
    y += a * (samples[i] - y);
    out[i] = y;
  }
  return out;
}

function toWavDataUri(samples, sampleRate = SR) {
  const buf = encodeWavBuffer(samples, sampleRate, { bitsPerSample: 16 });
  return `data:audio/wav;base64,${buf.toString("base64")}`;
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function summarizeReport(samples, label) {
  const repAll = analyzeSamples(samples, SR, {
    label,
    falsifiers: DEFAULT_FALSIFIERS,
    policy: "veto_all",
  });
  const repCore = analyzeSamples(samples, SR, {
    label,
    falsifiers: DEFAULT_FALSIFIERS,
    policy: "core_veto",
  });
  const triggeredAll = repAll.falsifiers
    .filter((f) => f.triggered)
    .map((f) => ({
      id: f.id,
      shortId: f.id.split("_")[0],
      score: f.score,
      evidence: f.evidence || "",
    }));
  const triggeredCore = repCore.falsifiers
    .filter((f) => f.triggered && ORIGINAL_6_FALSIFIERS.some((c) => c.id === f.id))
    .map((f) => f.id.split("_")[0]);
  const f24 = repAll.falsifiers.find((f) => f.id === "F24_CALCULATED_PITCH_LFO");

  return {
    verdictAll: repAll.verdict,
    verdictCore: repCore.verdict,
    triggeredAll,
    triggeredCore,
    f24Triggered: Boolean(f24?.triggered),
    f24Score: f24 ? f24.score : 0,
    f24Evidence: f24 ? f24.evidence : "",
    f0MedianHz: repAll.features?.medianF0 ?? 0,
    f0RangeSemitones: repAll.features?.f0RangeSemitones ?? 0,
    durationSec: Number((samples.length / SR).toFixed(3)),
  };
}

async function main() {
  const kudaPath = resolveKudaPath(process.argv.slice(2));
  if (!fs.existsSync(kudaPath)) {
    throw new Error(`tokiko-axis/kuda.mjs not found at ${kudaPath}; pass --tokiko-dir <path> or set TOKIKO_PATH.`);
  }

  const kuda = await import(pathToFileURL(kudaPath).href);
  if (typeof kuda.synthKuda !== "function") {
    throw new Error(`synthKuda export not found in ${kudaPath}`);
  }
  const presets = kuda.KUDA_PRESETS || {};

  const testSpecs = [
    {
      id: "test_01_naru_kawaii",
      number: 1,
      utterance: "「なる」",
      preset: "kawaii",
      targetAxes: ["F24"],
      modificationDesc:
        "3択・同速比較（3テイクとも rate=1.00・同尺 1.085s）: (1) 原音（アクセント山＋F24発火）、(2) 抑揚保持・揺れ弱め版（話速完全一致のまま uta_hz=[1.00,1.02]×302Hz / scoop=1.4 / hopf=0 で周期揺れのみ低減 → F24未発火・0/32）、(3) 302Hz 完全フラット固定版",
      order: ["original", "flat", "damped"],
      takes: {
        original: {
          role: "original",
          roleLabel: "原音（Original / アクセント山あり＋揺れあり）",
          build: () => kuda.synthKuda("なる", { preset: "kawaii", srOut: SR }).samples,
        },
        damped: {
          role: "damped",
          roleLabel: "抑揚あり・揺れ弱め（Accent-Kept / Vibrato-Damped・同速）",
          build: () => {
            const hz = presets.kawaii?.hz ?? 302.0;
            return kuda.synthKuda("なる", {
              preset: "kawaii",
              srOut: SR,
              uta_hz: [hz * 1.0, hz * 1.02],
              scoop: 1.4,
              hopf: 0,
            }).samples;
          },
        },
        flat: {
          role: "flat",
          roleLabel: "完全フラット（Fully Flat / 302Hz固定）",
          build: () => kuda.synthKuda("なる", { preset: "kawaii", srOut: SR, flatHz: 302, hopf: 0 }).samples,
        },
      },
    },
    {
      id: "test_02_naru_amae",
      number: 2,
      utterance: "「なる」",
      preset: "amae",
      targetAxes: ["F24"],
      modificationDesc:
        "3択・同速比較（3テイクとも rate=1.09・同尺 1.115s）: (1) 原音（アクセント山＋F24発火）、(2) 抑揚保持・揺れ弱め版（話速完全一致のまま uta_hz=[1.00,1.04]×290Hz / scoop=1.4 / hopf=0 で周期揺れのみ低減 → F24未発火・0/32）、(3) 290Hz 完全フラット固定版",
      order: ["damped", "original", "flat"],
      takes: {
        original: {
          role: "original",
          roleLabel: "原音（Original / アクセント山あり＋揺れあり）",
          build: () => kuda.synthKuda("なる", { preset: "amae", srOut: SR }).samples,
        },
        damped: {
          role: "damped",
          roleLabel: "抑揚あり・揺れ弱め（Accent-Kept / Vibrato-Damped・同速）",
          build: () => {
            const hz = presets.amae?.hz ?? 290.0;
            return kuda.synthKuda("なる", {
              preset: "amae",
              srOut: SR,
              uta_hz: [hz * 1.0, hz * 1.04],
              scoop: 1.4,
              hopf: 0,
            }).samples;
          },
        },
        flat: {
          role: "flat",
          roleLabel: "完全フラット（Fully Flat / 290Hz固定）",
          build: () => kuda.synthKuda("なる", { preset: "amae", srOut: SR, flatHz: 290, hopf: 0 }).samples,
        },
      },
    },
    {
      id: "test_03_naru_genki",
      number: 3,
      utterance: "「なる」",
      preset: "genki",
      targetAxes: ["F24"],
      modificationDesc:
        "3択・同速比較（3テイクとも rate=0.93・同尺 1.065s）: (1) 原音（アクセント山＋F24発火）、(2) 抑揚保持・揺れ弱め版（話速完全一致のまま uta_hz=[0.98,1.03]×320Hz / scoop=1.5 / hopf=0 で周期揺れのみ低減 → F24未発火・0/32）、(3) 320Hz 完全フラット固定版",
      order: ["flat", "damped", "original"],
      takes: {
        original: {
          role: "original",
          roleLabel: "原音（Original / アクセント山あり＋揺れあり）",
          build: () => kuda.synthKuda("なる", { preset: "genki", srOut: SR }).samples,
        },
        damped: {
          role: "damped",
          roleLabel: "抑揚あり・揺れ弱め（Accent-Kept / Vibrato-Damped・同速）",
          build: () => {
            const hz = presets.genki?.hz ?? 320.0;
            return kuda.synthKuda("なる", {
              preset: "genki",
              srOut: SR,
              uta_hz: [hz * 0.98, hz * 1.03],
              scoop: 1.5,
              hopf: 0,
            }).samples;
          },
        },
        flat: {
          role: "flat",
          roleLabel: "完全フラット（Fully Flat / 320Hz固定）",
          build: () => kuda.synthKuda("なる", { preset: "genki", srOut: SR, flatHz: 320, hopf: 0 }).samples,
        },
      },
    },
    {
      id: "test_04_watashi_amae",
      number: 4,
      utterance: "「わたし、にほんご、ちょっとしゃべれます」",
      preset: "amae",
      targetAxes: ["F14", "F23"],
      modificationDesc: "F14（粗さ）・F23（音程揺れ）を抑えるため、2.2kHz 1次ローパスで高域エッジを丸めた版",
      order: ["original", "flat"],
      takes: {
        original: {
          role: "original",
          roleLabel: "原音（Original / 加工なし）",
          build: () => kuda.synthKuda("わたし、にほんご、ちょっとしゃべれます", { preset: "amae", srOut: SR }).samples,
        },
        flat: {
          role: "flat",
          roleLabel: "鏡に合わせた版（2.2kHz ローパス丸め）",
          build: () => {
            const raw = kuda.synthKuda("わたし、にほんご、ちょっとしゃべれます", { preset: "amae", srOut: SR }).samples;
            return lowpass1Pole(raw, SR, 2200);
          },
        },
      },
    },
    {
      id: "test_05_ohayo_kawaii",
      number: 5,
      utterance: "「おはよう、きょうは、いいてんきだね」",
      preset: "kawaii",
      targetAxes: ["F24"],
      modificationDesc: "F24 を外すため、ピッチ曲線を 302Hz 固定・hopf=0 に平坦化（全軸クリア版）",
      order: ["flat", "original"],
      takes: {
        original: {
          role: "original",
          roleLabel: "原音（Original / 加工なし）",
          build: () => kuda.synthKuda("おはよう、きょうは、いいてんきだね", { preset: "kawaii", srOut: SR }).samples,
        },
        flat: {
          role: "flat",
          roleLabel: "完全フラット（302Hz 固定・hopf=0）",
          build: () =>
            kuda.synthKuda("おはよう、きょうは、いいてんきだね", {
              preset: "kawaii",
              srOut: SR,
              flatHz: 302,
              hopf: 0,
            }).samples,
        },
      },
    },
    {
      id: "test_06_ohayo_genki",
      number: 6,
      utterance: "「おはよう、きょうは、いいてんきだね」",
      preset: "genki",
      targetAxes: ["F23", "F24"],
      modificationDesc: "F23・F24 を外すため、ピッチ曲線を 320Hz 固定・hopf=0.15 に平坦化（全軸クリア版）",
      order: ["original", "flat"],
      takes: {
        original: {
          role: "original",
          roleLabel: "原音（Original / 加工なし）",
          build: () => kuda.synthKuda("おはよう、きょうは、いいてんきだね", { preset: "genki", srOut: SR }).samples,
        },
        flat: {
          role: "flat",
          roleLabel: "完全フラット（320Hz 固定・hopf=0.15）",
          build: () =>
            kuda.synthKuda("おはよう、きょうは、いいてんきだね", {
              preset: "genki",
              srOut: SR,
              flatHz: 320,
              hopf: 0.15,
            }).samples,
        },
      },
    },
  ];

  const LABELS = ["X", "Y", "Z"];
  const builtTests = [];
  console.log("[build_mirror_audit_demo] Synthesizing & verifying 6 blind mirror audit tests (3x 3-choice + 3x 2-choice)...");

  for (const spec of testSpecs) {
    const builtByKey = {};
    for (const [key, def] of Object.entries(spec.takes)) {
      const samples = def.build();
      const report = summarizeReport(samples, `${spec.id}_${key}`);
      builtByKey[key] = {
        role: def.role,
        roleLabel: def.roleLabel,
        audioUri: toWavDataUri(samples, SR),
        report,
      };
    }

    const origAxes = new Set(builtByKey.original.report.triggeredAll.map((t) => t.shortId));
    const compareTarget = builtByKey.damped || builtByKey.flat;
    const compareAxes = new Set(compareTarget.report.triggeredAll.map((t) => t.shortId));
    const eliminatedTargets = spec.targetAxes.filter((ax) => origAxes.has(ax) && !compareAxes.has(ax));

    const summaryParts = Object.entries(builtByKey).map(([k, v]) => {
      const trig = v.report.triggeredAll.map((t) => t.shortId).join(",") || "CLEAN";
      return `${k}=[${trig} dur=${v.report.durationSec.toFixed(3)}s F24=${v.report.f24Score} range=${v.report.f0RangeSemitones}st]`;
    });
    console.log(`  #${spec.number} ${spec.utterance} (${spec.preset}): ${summaryParts.join(" | ")}`);

    if (builtByKey.damped && builtByKey.damped.report.durationSec !== builtByKey.original.report.durationSec) {
      throw new Error(
        `Test ${spec.id} speed-match violated: damped dur=${builtByKey.damped.report.durationSec}s vs original dur=${builtByKey.original.report.durationSec}s`
      );
    }

    if (eliminatedTargets.length === 0) {
      throw new Error(
        `Test ${spec.id} failed verification: target axes [${spec.targetAxes.join(",")}] were not cleared.`
      );
    }

    const takes = spec.order.map((key, idx) => ({
      slot: LABELS[idx],
      ...builtByKey[key],
    }));

    builtTests.push({
      id: spec.id,
      number: spec.number,
      utterance: spec.utterance,
      preset: spec.preset,
      choiceCount: takes.length,
      targetAxes: spec.targetAxes,
      eliminatedTargets,
      modificationDesc: spec.modificationDesc,
      takes,
    });
  }

  const html = renderHtml(builtTests);
  fs.writeFileSync(OUT_HTML, html, "utf8");
  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`[build_mirror_audit_demo] Wrote ${OUT_HTML} (${kb} KB, ${builtTests.length} blind tests, 0 external URLs).`);
}

function renderHtml(tests) {
  const payload = safeJsonForScript({
    version: "v0.4",
    generatedAt: new Date().toISOString().slice(0, 10),
    tests,
  });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yata v0.4 — 鏡のブラインド耳審査（3択・Mirror Audit）</title>
<style>
  :root {
    --bg: #121110;
    --panel: #1b1917;
    --panel-2: #24211e;
    --border: #332e29;
    --text: #f3ede6;
    --muted: #a69c92;
    --accent: #e89b5a;
    --accent-soft: rgba(232, 155, 90, 0.16);
    --orig: #f06d7a;
    --orig-soft: rgba(240, 109, 122, 0.16);
    --damped: #64c496;
    --damped-soft: rgba(100, 196, 150, 0.16);
    --flat: #7aa7e8;
    --flat-soft: rgba(122, 167, 232, 0.16);
    --tie: #9da8b8;
    --tie-soft: rgba(157, 168, 184, 0.16);
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0 0 92px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", sans-serif;
    line-height: 1.6;
  }
  .wrap {
    max-width: 880px;
    margin: 0 auto;
    padding: 28px 18px 24px;
  }
  header {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 22px 24px;
    margin-bottom: 20px;
  }
  .kicker {
    font-size: 12px;
    letter-spacing: 0.08em;
    color: var(--accent);
    font-weight: 700;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 22px;
    font-weight: 700;
  }
  .quote {
    margin: 12px 0 0;
    padding: 12px 14px;
    border-left: 3px solid var(--accent);
    background: var(--panel-2);
    border-radius: 0 10px 10px 0;
    color: #e4dad0;
    font-size: 14px;
  }
  .summary-bar {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
    margin-bottom: 20px;
  }
  @media (max-width: 760px) {
    .summary-bar { grid-template-columns: repeat(2, 1fr); }
  }
  .stat {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 10px;
    text-align: center;
  }
  .stat-val {
    font-size: 22px;
    font-weight: 800;
    font-family: var(--mono);
  }
  .stat-lbl {
    font-size: 11.5px;
    color: var(--muted);
    line-height: 1.35;
    margin-top: 2px;
  }
  .c-orig { color: var(--orig); }
  .c-damped { color: var(--damped); }
  .c-flat { color: var(--flat); }
  .c-tie { color: var(--tie); }
  .c-accent { color: var(--accent); }

  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    margin-bottom: 16px;
    transition: border-color 0.15s ease;
  }
  .card.voted-original { border-color: rgba(240, 109, 122, 0.55); }
  .card.voted-damped { border-color: rgba(100, 196, 150, 0.55); }
  .card.voted-flat { border-color: rgba(122, 167, 232, 0.55); }
  .card.voted-tie { border-color: rgba(157, 168, 184, 0.5); }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }
  .pair-title {
    font-size: 16px;
    font-weight: 700;
  }
  .pair-sub {
    font-size: 12px;
    color: var(--muted);
    font-family: var(--mono);
  }
  .blind-badge {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
    white-space: nowrap;
  }
  .blind-badge.revealed {
    background: var(--panel-2);
    color: var(--muted);
  }

  .play-row {
    display: grid;
    gap: 12px;
    margin-bottom: 14px;
  }
  .play-row.cols-2 { grid-template-columns: repeat(2, 1fr); }
  .play-row.cols-3 { grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 600px) {
    .play-row.cols-2, .play-row.cols-3 { grid-template-columns: 1fr; }
  }
  .play-btn {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--text);
    border-radius: 12px;
    padding: 14px 16px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: all 0.14s ease;
  }
  .play-btn:hover {
    border-color: var(--accent);
    background: #2c2722;
  }
  .play-btn.playing {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: #fff;
  }
  .dur {
    font-size: 12px;
    font-weight: 500;
    color: var(--muted);
    font-family: var(--mono);
  }

  .vote-prompt {
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .vote-row {
    display: grid;
    gap: 10px;
  }
  .vote-row.cols-2 { grid-template-columns: 1fr 1fr auto; }
  .vote-row.cols-3 { grid-template-columns: 1fr 1fr 1fr auto; }
  @media (max-width: 640px) {
    .vote-row.cols-2, .vote-row.cols-3 { grid-template-columns: 1fr; }
  }
  .vote-btn {
    appearance: none;
    border: 1px solid var(--border);
    background: #171513;
    color: var(--text);
    border-radius: 10px;
    padding: 11px 12px;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.14s ease;
  }
  .vote-btn:hover {
    border-color: var(--accent);
    background: #26221e;
  }
  .vote-btn.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: #fff;
  }

  .reveal {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px dashed var(--border);
    display: none;
  }
  .reveal.show { display: block; }
  .outcome-banner {
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 12px;
  }
  .outcome-original {
    background: var(--orig-soft);
    color: var(--orig);
    border: 1px solid rgba(240, 109, 122, 0.35);
  }
  .outcome-damped {
    background: var(--damped-soft);
    color: var(--damped);
    border: 1px solid rgba(100, 196, 150, 0.35);
  }
  .outcome-flat {
    background: var(--flat-soft);
    color: var(--flat);
    border: 1px solid rgba(122, 167, 232, 0.35);
  }
  .outcome-tie {
    background: var(--tie-soft);
    color: var(--tie);
    border: 1px solid rgba(157, 168, 184, 0.35);
  }
  .reveal-grid {
    display: grid;
    gap: 10px;
    margin-bottom: 10px;
  }
  .reveal-grid.cols-2 { grid-template-columns: repeat(2, 1fr); }
  .reveal-grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 720px) {
    .reveal-grid.cols-2, .reveal-grid.cols-3 { grid-template-columns: 1fr; }
  }
  .reveal-box {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    font-size: 12.5px;
  }
  .reveal-box.picked {
    border-color: var(--accent);
  }
  .reveal-box-title {
    font-weight: 700;
    margin-bottom: 6px;
    font-size: 13px;
  }
  .metric-line {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
    margin-top: 4px;
  }
  .pill {
    display: inline-block;
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 6px;
    margin: 2px 4px 2px 0;
    background: #332a24;
    color: #f3c49d;
  }
  .pill.clean {
    background: rgba(100, 196, 150, 0.18);
    color: var(--damped);
  }
  .mod-note {
    font-size: 12px;
    color: var(--muted);
  }

  .sticky-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(18, 17, 16, 0.94);
    backdrop-filter: blur(8px);
    border-top: 1px solid var(--border);
    padding: 12px 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    z-index: 50;
  }
  .bar-btn {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--text);
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }
  .bar-btn.primary {
    background: var(--accent);
    color: #191512;
    border-color: var(--accent);
  }
  .bar-btn:hover { opacity: 0.92; }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 16px;
    z-index: 100;
  }
  .modal-backdrop.show { display: flex; }
  .modal {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    max-width: 640px;
    width: 100%;
    padding: 18px;
  }
  .modal h3 { margin: 0 0 10px; font-size: 16px; }
  .modal textarea {
    width: 100%;
    height: 240px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    font-family: var(--mono);
    font-size: 12px;
  }
  .modal-actions {
    margin-top: 10px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="kicker">yata v0.4 · 3-Choice Blind Mirror Audit</div>
    <h1>🪞 鏡も耳の審査を受ける — 3択ブラインド試聴（「なる」抑揚 vs 揺れ）</h1>
    <div style="font-size:14px;color:var(--muted);">
      #1〜#3 の「なる」は<strong>3択ブラインド（Take X / Y / Z）</strong>です。原音・抑揚を残して揺れだけ弱めた版・完全フラット版がランダム順に並んでいます。<br>
      どれが何かも、鏡（yata）の判定も、<strong>投票するまで完全に伏せてあります</strong>。耳だけで「一番残したい」ものを選んでください。
    </div>
    <div class="quote">
      「僕なら次は、<strong>アクセントの山を残して、F24が拾った周期揺れだけ弱めた『なる』</strong>を三つ目に置く。そこで初めて『この節回しの、どこが好きやったんやろ』に手が届く。」
    </div>
  </header>

  <section class="summary-bar">
    <div class="stat">
      <div class="stat-val c-orig" id="stat-original">0</div>
      <div class="stat-lbl">🪞 原音派（F24発火でも残したい）</div>
    </div>
    <div class="stat">
      <div class="stat-val c-damped" id="stat-damped">0</div>
      <div class="stat-lbl">🎯 抑揚あり・揺れ弱め派（アクセントが魅力）</div>
    </div>
    <div class="stat">
      <div class="stat-val c-flat" id="stat-flat">0</div>
      <div class="stat-lbl">📏 フラット／丸め派</div>
    </div>
    <div class="stat">
      <div class="stat-val c-tie" id="stat-tie">0</div>
      <div class="stat-lbl">🤷 どれも同じ</div>
    </div>
    <div class="stat">
      <div class="stat-val c-accent" id="stat-progress">0 / 6</div>
      <div class="stat-lbl">審査の進捗</div>
    </div>
  </section>

  <main id="tests-root"></main>
</div>

<div class="sticky-bar">
  <button class="bar-btn primary" id="btn-copy">📋 鏡の審査結果をコピー</button>
  <button class="bar-btn" id="btn-reset">🔄 やり直す</button>
</div>

<div class="modal-backdrop" id="copy-modal">
  <div class="modal">
    <h3>📋 鏡の審査結果（Markdown）</h3>
    <textarea id="copy-textarea" readonly></textarea>
    <div class="modal-actions">
      <button class="bar-btn" id="btn-select-all">全選択</button>
      <button class="bar-btn primary" id="btn-close-modal">閉じる</button>
    </div>
  </div>
</div>

<audio id="shared-player"></audio>

<script id="audit-data" type="application/json">${payload}</script>
<script>
(function () {
  const DATA = JSON.parse(document.getElementById("audit-data").textContent);
  const root = document.getElementById("tests-root");
  const player = document.getElementById("shared-player");
  const votes = Object.create(null); // testId -> "X" | "Y" | "Z" | "tie"
  let activePlayBtn = null;

  function stopAudio() {
    player.pause();
    player.currentTime = 0;
    if (activePlayBtn) {
      activePlayBtn.classList.remove("playing");
      activePlayBtn = null;
    }
  }

  player.addEventListener("ended", stopAudio);

  function playTake(uri, btn) {
    if (activePlayBtn === btn && !player.paused) {
      stopAudio();
      return;
    }
    stopAudio();
    activePlayBtn = btn;
    btn.classList.add("playing");
    player.src = uri;
    player.play().catch(() => stopAudio());
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function renderPills(triggeredAll) {
    if (!triggeredAll || triggeredAll.length === 0) {
      return '<span class="pill clean">CLEAN (0/32)</span>';
    }
    return triggeredAll
      .map((t) => '<span class="pill" title="' + escapeAttr(t.evidence) + '">' + escapeHtml(t.shortId) + "</span>")
      .join("");
  }

  function classifyVote(test, choice) {
    if (choice === "tie") return "tie";
    const found = test.takes.find((t) => t.slot === choice);
    return found ? found.role : "tie";
  }

  function updateSummary() {
    let orig = 0, damped = 0, flat = 0, tie = 0, done = 0;
    for (const test of DATA.tests) {
      const v = votes[test.id];
      if (!v) continue;
      done++;
      const c = classifyVote(test, v);
      if (c === "original") orig++;
      else if (c === "damped") damped++;
      else if (c === "flat") flat++;
      else tie++;
    }
    document.getElementById("stat-original").textContent = String(orig);
    document.getElementById("stat-damped").textContent = String(damped);
    document.getElementById("stat-flat").textContent = String(flat);
    document.getElementById("stat-tie").textContent = String(tie);
    document.getElementById("stat-progress").textContent = done + " / " + DATA.tests.length;
  }

  function renderCards() {
    root.innerHTML = "";
    for (const test of DATA.tests) {
      const colsClass = test.choiceCount === 3 ? "cols-3" : "cols-2";
      const card = document.createElement("article");
      card.className = "card";
      card.id = "card-" + test.id;

      const playButtonsHtml = test.takes
        .map(
          (t) =>
            '<button class="play-btn" data-play="' + t.slot + '">▶ Take ' + t.slot +
            ' <span class="dur">' + t.report.durationSec + "s</span></button>"
        )
        .join("");

      const voteButtonsHtml =
        test.takes
          .map(
            (t) =>
              '<button class="vote-btn" data-vote="' + t.slot + '">Take ' + t.slot + " が好き</button>"
          )
          .join("") +
        '<button class="vote-btn" data-vote="tie">🤷 ' + (test.choiceCount === 3 ? "どれも同じ" : "どっちも同じ") + "</button>";

      const revealBoxesHtml = test.takes
        .map(
          (t) =>
            '<div class="reveal-box" data-reveal-slot="' + t.slot + '">' +
              '<div class="reveal-box-title">Take ' + t.slot + ": " + escapeHtml(t.roleLabel) + "</div>" +
              "<div>core_veto: " +
                (t.report.triggeredCore.length
                  ? '<span class="pill">' + escapeHtml(t.report.triggeredCore.join(", ")) + "</span>"
                  : '<span class="pill clean">PASS</span>') +
              "</div>" +
              '<div style="margin-top:4px;">veto_all: ' + renderPills(t.report.triggeredAll) + "</div>" +
              '<div class="metric-line">dur=' + t.report.durationSec.toFixed(3) +
                "s | F24: score=" + t.report.f24Score +
                (t.report.f24Triggered ? " (TRIG)" : " (pass)") +
                " | F0 range=" + t.report.f0RangeSemitones + "st</div>" +
            "</div>"
        )
        .join("");

      card.innerHTML =
        '<div class="card-head">' +
          "<div>" +
            '<div class="pair-title">Test #' + test.number + " — " + escapeHtml(test.utterance) +
              (test.choiceCount === 3 ? "（3択）" : "（2択）") + "</div>" +
            '<div class="pair-sub">preset: ' + escapeHtml(test.preset) + "</div>" +
          "</div>" +
          '<span class="blind-badge" id="badge-' + test.id + '">🙈 ブラインド中</span>' +
        "</div>" +
        '<div class="play-row ' + colsClass + '">' + playButtonsHtml + "</div>" +
        '<div class="vote-prompt">どれが好き？（残したい）</div>' +
        '<div class="vote-row ' + colsClass + '">' + voteButtonsHtml + "</div>" +
        '<div class="reveal" id="reveal-' + test.id + '">' +
          '<div class="outcome-banner" id="outcome-' + test.id + '"></div>' +
          '<div class="reveal-grid ' + colsClass + '">' + revealBoxesHtml + "</div>" +
          '<div class="mod-note">🔧 比較設計: ' + escapeHtml(test.modificationDesc) + "</div>" +
        "</div>";

      for (const take of test.takes) {
        const btn = card.querySelector('[data-play="' + take.slot + '"]');
        btn.addEventListener("click", (e) => playTake(take.audioUri, e.currentTarget));
      }

      for (const btn of card.querySelectorAll("[data-vote]")) {
        btn.addEventListener("click", () => {
          const choice = btn.getAttribute("data-vote");
          votes[test.id] = choice;

          for (const b of card.querySelectorAll("[data-vote]")) {
            b.classList.toggle("selected", b === btn);
          }
          for (const box of card.querySelectorAll("[data-reveal-slot]")) {
            box.classList.toggle("picked", box.getAttribute("data-reveal-slot") === choice);
          }

          const cls = classifyVote(test, choice);
          card.classList.remove("voted-original", "voted-damped", "voted-flat", "voted-tie");
          card.classList.add("voted-" + cls);

          const badge = document.getElementById("badge-" + test.id);
          badge.textContent = "🔓 種明かし済み";
          badge.classList.add("revealed");

          const outcomeEl = document.getElementById("outcome-" + test.id);
          outcomeEl.className = "outcome-banner outcome-" + cls;
          if (cls === "original") {
            outcomeEl.textContent =
              "🪞 原音派（F24発火でも残したい）— " + test.eliminatedTargets.join("/") + " が拾った揺れごと原音の魅力だった！";
          } else if (cls === "damped") {
            outcomeEl.textContent =
              "🎯 抑揚あり・揺れ弱め派 — 日本語アクセントの山が魅力で、F24 が指摘した周期揺れを弱める判断は妥当かも！";
          } else if (cls === "flat") {
            outcomeEl.textContent =
              "📏 フラット／丸め派 — " + test.eliminatedTargets.join("/") + " を外した静かな版のほうが耳に心地よい";
          } else {
            outcomeEl.textContent = "🤷 どれも同じ（引き分け）— 少なくとも強い拒否権の根拠にはならない";
          }

          document.getElementById("reveal-" + test.id).classList.add("show");
          updateSummary();
        });
      }

      root.appendChild(card);
    }
  }

  function buildMarkdownSummary() {
    let orig = 0, damped = 0, flat = 0, tie = 0;
    const lines = [
      "# yata v0.4 — 鏡のブラインド耳審査（3択・Mirror Audit）結果",
      "",
    ];
    for (const test of DATA.tests) {
      const v = votes[test.id];
      if (!v) {
        lines.push("- Test #" + test.number + " " + test.utterance + " (" + test.preset + "): 未投票");
        continue;
      }
      const c = classifyVote(test, v);
      if (c === "original") orig++;
      else if (c === "damped") damped++;
      else if (c === "flat") flat++;
      else tie++;

      const label =
        c === "original"
          ? "🪞 原音派（F24発火でも残したい）"
          : c === "damped"
          ? "🎯 抑揚あり・揺れ弱め派（アクセントが魅力、F24は妥当かも）"
          : c === "flat"
          ? "📏 フラット／丸め派"
          : "🤷 どれも同じ";
      lines.push(
        "- Test #" + test.number + " " + test.utterance + " (" + test.preset + ", " + test.choiceCount +
        "択, 対象軸: " + test.eliminatedTargets.join("/") + "): " + label + " [vote=Take " + v + "]"
      );
    }
    lines.splice(
      2,
      0,
      "**集計**: 🪞 原音派=" + orig + " / 🎯 抑揚あり・揺れ弱め派=" + damped + " / 📏 フラット派=" + flat + " / 🤷 どれも同じ=" + tie,
      ""
    );
    return lines.join("\\n");
  }

  const modal = document.getElementById("copy-modal");
  const textarea = document.getElementById("copy-textarea");

  document.getElementById("btn-copy").addEventListener("click", async () => {
    const md = buildMarkdownSummary();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
        const btn = document.getElementById("btn-copy");
        const prev = btn.textContent;
        btn.textContent = "✅ コピーしました！";
        setTimeout(() => { btn.textContent = prev; }, 1600);
        return;
      }
    } catch (_) {}
    textarea.value = md;
    modal.classList.add("show");
  });

  document.getElementById("btn-select-all").addEventListener("click", () => {
    textarea.focus();
    textarea.select();
  });
  document.getElementById("btn-close-modal").addEventListener("click", () => {
    modal.classList.remove("show");
  });
  document.getElementById("btn-reset").addEventListener("click", () => {
    stopAudio();
    for (const k of Object.keys(votes)) delete votes[k];
    renderCards();
    updateSummary();
  });

  renderCards();
  updateSummary();
})();
</script>
</body>
</html>
`;
}

main().catch((err) => {
  console.error("[build_mirror_audit_demo] ERROR:", err);
  process.exit(1);
});
