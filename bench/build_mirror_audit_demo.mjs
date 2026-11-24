#!/usr/bin/env node
/**
 * bench/build_mirror_audit_demo.mjs — Blind Mirror Audit HTML Demo Builder (v0.3)
 *
 * Implements Observer #1's proposal:
 *   "First listen blind to 'naru' original vs a version altered just to clear F24.
 *    If the original is preferred, that single vote challenges F24's veto power.
 *    If sound is judged by the mirror, the mirror must also be judged by the ear."
 *
 * Generates `/home/antigravity/poidowl/yata/bench/mirror_audit_demo.html`:
 *   - 100% self-contained single-file HTML (zero external URLs, embedded PCM16 WAV base64)
 *   - 6 blind A/B pairs (Original vs Mirror-Compliant / Flattened) with randomized Take X / Take Y
 *   - Labels and yata verdicts are strictly hidden until the user votes
 *   - Post-vote reveal shows exact triggered axes (truthfully from analyzeSamples) and tallies
 *     whether the ear overrules the mirror's veto.
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
const OUT_HTML = path.join(__dirname, "mirror_audit_demo.html");
const KUDA_PATH = "/home/antigravity/poidowl/tokiko-axis/kuda.mjs";
const SR = 24000;

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
  const repAll = analyzeSamples(samples, SR, { label, falsifiers: DEFAULT_FALSIFIERS });
  const repCore = analyzeSamples(samples, SR, { label, falsifiers: ORIGINAL_6_FALSIFIERS });
  const triggeredAll = repAll.falsifiers
    .filter((f) => f.triggered)
    .map((f) => ({
      id: f.id,
      shortId: f.id.split("_")[0],
      evidence: f.evidence || "",
    }));
  const triggeredCore = repCore.falsifiers
    .filter((f) => f.triggered)
    .map((f) => f.id.split("_")[0]);

  return {
    verdictAll: repAll.verdict,
    verdictCore: repCore.verdict,
    triggeredAll,
    triggeredCore,
    durationSec: Number((samples.length / SR).toFixed(2)),
  };
}

async function main() {
  if (!fs.existsSync(KUDA_PATH)) {
    throw new Error(`tokiko-axis/kuda.mjs not found at ${KUDA_PATH}; cannot synthesize mirror audit pairs.`);
  }

  const kuda = await import(pathToFileURL(KUDA_PATH).href);
  if (typeof kuda.synthKuda !== "function") {
    throw new Error(`synthKuda export not found in ${KUDA_PATH}`);
  }

  const pairSpecs = [
    {
      id: "pair_01_naru_kawaii",
      number: 1,
      utterance: "「なる」",
      preset: "kawaii",
      targetAxes: ["F24"],
      modificationDesc: "F24（機械ビブラート誤爆）を外すため、ピッチ曲線を 302Hz 固定・hopf=0 に平坦化",
      originalIsX: true,
      buildOriginal: () => kuda.synthKuda("なる", { preset: "kawaii", srOut: SR }).samples,
      buildMirror: () => kuda.synthKuda("なる", { preset: "kawaii", srOut: SR, flatHz: 302, hopf: 0 }).samples,
    },
    {
      id: "pair_02_naru_amae",
      number: 2,
      utterance: "「なる」",
      preset: "amae",
      targetAxes: ["F24"],
      modificationDesc: "F24（機械ビブラート誤爆）を外すため、ピッチ曲線を 290Hz 固定・hopf=0 に平坦化",
      originalIsX: false,
      buildOriginal: () => kuda.synthKuda("なる", { preset: "amae", srOut: SR }).samples,
      buildMirror: () => kuda.synthKuda("なる", { preset: "amae", srOut: SR, flatHz: 290, hopf: 0 }).samples,
    },
    {
      id: "pair_03_naru_genki",
      number: 3,
      utterance: "「なる」",
      preset: "genki",
      targetAxes: ["F24"],
      modificationDesc: "F24 を外すため、ピッチ曲線を 320Hz 固定・hopf=0 に平坦化（全軸クリア版）",
      originalIsX: false,
      buildOriginal: () => kuda.synthKuda("なる", { preset: "genki", srOut: SR }).samples,
      buildMirror: () => kuda.synthKuda("なる", { preset: "genki", srOut: SR, flatHz: 320, hopf: 0 }).samples,
    },
    {
      id: "pair_04_watashi_amae",
      number: 4,
      utterance: "「わたし、にほんご、ちょっとしゃべれます」",
      preset: "amae",
      targetAxes: ["F14", "F23"],
      modificationDesc: "F14（粗さ）・F23（音程揺れ）を抑えるため、2.2kHz 1次ローパスで高域エッジを丸めた版",
      originalIsX: true,
      buildOriginal: () => kuda.synthKuda("わたし、にほんご、ちょっとしゃべれます", { preset: "amae", srOut: SR }).samples,
      buildMirror: () => {
        const raw = kuda.synthKuda("わたし、にほんご、ちょっとしゃべれます", { preset: "amae", srOut: SR }).samples;
        return lowpass1Pole(raw, SR, 2200);
      },
    },
    {
      id: "pair_05_ohayo_kawaii",
      number: 5,
      utterance: "「おはよう、きょうは、いいてんきだね」",
      preset: "kawaii",
      targetAxes: ["F24"],
      modificationDesc: "F24 を外すため、ピッチ曲線を 302Hz 固定・hopf=0 に平坦化（全軸クリア版）",
      originalIsX: false,
      buildOriginal: () => kuda.synthKuda("おはよう、きょうは、いいてんきだね", { preset: "kawaii", srOut: SR }).samples,
      buildMirror: () => kuda.synthKuda("おはよう、きょうは、いいてんきだね", { preset: "kawaii", srOut: SR, flatHz: 302, hopf: 0 }).samples,
    },
    {
      id: "pair_06_ohayo_genki",
      number: 6,
      utterance: "「おはよう、きょうは、いいてんきだね」",
      preset: "genki",
      targetAxes: ["F23", "F24"],
      modificationDesc: "F23・F24 を外すため、ピッチ曲線を 320Hz 固定・hopf=0.15 に平坦化（全軸クリア版）",
      originalIsX: true,
      buildOriginal: () => kuda.synthKuda("おはよう、きょうは、いいてんきだね", { preset: "genki", srOut: SR }).samples,
      buildMirror: () => kuda.synthKuda("おはよう、きょうは、いいてんきだね", { preset: "genki", srOut: SR, flatHz: 320, hopf: 0.15 }).samples,
    },
  ];

  const builtPairs = [];
  console.log("[build_mirror_audit_demo] Synthesizing & verifying 6 blind A/B pairs...");

  for (const spec of pairSpecs) {
    const origSamples = spec.buildOriginal();
    const mirrorSamples = spec.buildMirror();

    const origReport = summarizeReport(origSamples, `${spec.id}_orig`);
    const mirrorReport = summarizeReport(mirrorSamples, `${spec.id}_mirror`);

    const origAxes = new Set(origReport.triggeredAll.map((t) => t.shortId));
    const mirrorAxes = new Set(mirrorReport.triggeredAll.map((t) => t.shortId));
    const eliminatedTargets = spec.targetAxes.filter((ax) => origAxes.has(ax) && !mirrorAxes.has(ax));

    console.log(
      `  #${spec.number} ${spec.utterance} (${spec.preset}): ` +
      `orig=[${[...origAxes].join(",") || "CLEAN"}] -> mirror=[${[...mirrorAxes].join(",") || "CLEAN"}] ` +
      `(cleared: ${eliminatedTargets.join(",") || "none"})`
    );

    if (eliminatedTargets.length === 0) {
      throw new Error(
        `Pair ${spec.id} failed verification: target axes [${spec.targetAxes.join(",")}] were not cleared ` +
        `(orig=[${[...origAxes].join(",")}], mirror=[${[...mirrorAxes].join(",")}])`
      );
    }

    const origObj = {
      role: "original",
      roleLabel: "原音（Original / 加工なし）",
      audioUri: toWavDataUri(origSamples, SR),
      report: origReport,
    };
    const mirrorObj = {
      role: "mirror",
      roleLabel: "鏡に合わせた版（Mirror-Compliant / 平坦・丸め）",
      audioUri: toWavDataUri(mirrorSamples, SR),
      report: mirrorReport,
    };

    builtPairs.push({
      id: spec.id,
      number: spec.number,
      utterance: spec.utterance,
      preset: spec.preset,
      targetAxes: spec.targetAxes,
      eliminatedTargets,
      modificationDesc: spec.modificationDesc,
      takeX: spec.originalIsX ? origObj : mirrorObj,
      takeY: spec.originalIsX ? mirrorObj : origObj,
    });
  }

  const html = renderHtml(builtPairs);
  fs.writeFileSync(OUT_HTML, html, "utf8");
  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`[build_mirror_audit_demo] Wrote ${OUT_HTML} (${kb} KB, ${builtPairs.length} blind pairs, 0 external URLs).`);
}

function renderHtml(pairs) {
  const payload = safeJsonForScript({
    version: "v0.3",
    generatedAt: new Date().toISOString().slice(0, 10),
    pairs,
  });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yata v0.3 — 鏡のブラインド耳審査（Mirror Audit）</title>
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
    --overrule: #f06d7a;
    --overrule-soft: rgba(240, 109, 122, 0.16);
    --mirror-win: #64c496;
    --mirror-win-soft: rgba(100, 196, 150, 0.16);
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
    max-width: 820px;
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
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 20px;
  }
  @media (max-width: 640px) {
    .summary-bar { grid-template-columns: repeat(2, 1fr); }
  }
  .stat {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
    text-align: center;
  }
  .stat-val {
    font-size: 22px;
    font-weight: 800;
    font-family: var(--mono);
  }
  .stat-lbl {
    font-size: 12px;
    color: var(--muted);
  }
  .c-overrule { color: var(--overrule); }
  .c-mirror { color: var(--mirror-win); }
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
  .card.voted-overrule { border-color: rgba(240, 109, 122, 0.55); }
  .card.voted-mirror { border-color: rgba(100, 196, 150, 0.55); }
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
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 14px;
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

  .vote-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 10px;
  }
  @media (max-width: 600px) {
    .vote-row { grid-template-columns: 1fr; }
  }
  .vote-btn {
    appearance: none;
    border: 1px solid var(--border);
    background: #171513;
    color: var(--text);
    border-radius: 10px;
    padding: 11px 14px;
    font-size: 14px;
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
  .outcome-overrule {
    background: var(--overrule-soft);
    color: var(--overrule);
    border: 1px solid rgba(240, 109, 122, 0.35);
  }
  .outcome-mirror {
    background: var(--mirror-win-soft);
    color: var(--mirror-win);
    border: 1px solid rgba(100, 196, 150, 0.35);
  }
  .outcome-tie {
    background: var(--tie-soft);
    color: var(--tie);
    border: 1px solid rgba(157, 168, 184, 0.35);
  }
  .reveal-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 10px;
  }
  @media (max-width: 600px) {
    .reveal-grid { grid-template-columns: 1fr; }
  }
  .reveal-box {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    font-size: 13px;
  }
  .reveal-box-title {
    font-weight: 700;
    margin-bottom: 6px;
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
    color: var(--mirror-win);
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
    height: 220px;
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
    <div class="kicker">yata v0.3 · Blind Mirror Audit</div>
    <h1>🪞 鏡も耳の審査を受ける — ブラインド A/B 試聴</h1>
    <div style="font-size:14px;color:var(--muted);">
      各ペアの <strong>Take X</strong> と <strong>Take Y</strong> は、片方が「原音」、もう片方が「鏡（yata）の指摘を外すように加工した版」です。<br>
      どちらが原音かも、鏡が何を指摘したかも、<strong>投票するまで完全に伏せてあります</strong>。耳だけで好きなほうを選んでください。
    </div>
    <div class="quote">
      「まず『なる』原音と、F24だけ外れるように変えた版を、判定を伏せて聴き比べる。原音が好かれたら、その一票でF24の拒否権を疑えるようにする。音が鏡の審査を受けるなら、鏡も耳の審査を受けてほしい。」
    </div>
  </header>

  <section class="summary-bar">
    <div class="stat">
      <div class="stat-val c-overrule" id="stat-overrule">0</div>
      <div class="stat-lbl">🪞 鏡に異議あり（原音勝ち）</div>
    </div>
    <div class="stat">
      <div class="stat-val c-mirror" id="stat-mirror">0</div>
      <div class="stat-lbl">✅ 鏡の勝ち（修正版勝ち）</div>
    </div>
    <div class="stat">
      <div class="stat-val c-tie" id="stat-tie">0</div>
      <div class="stat-lbl">🤷 どっちも同じ</div>
    </div>
    <div class="stat">
      <div class="stat-val c-accent" id="stat-progress">0 / 6</div>
      <div class="stat-lbl">審査の進捗</div>
    </div>
  </section>

  <main id="pairs-root"></main>
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
  const root = document.getElementById("pairs-root");
  const player = document.getElementById("shared-player");
  const votes = Object.create(null); // pairId -> "X" | "Y" | "tie"
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

  function renderPills(triggeredAll) {
    if (!triggeredAll || triggeredAll.length === 0) {
      return '<span class="pill clean">CLEAN (0/32)</span>';
    }
    return triggeredAll
      .map((t) => '<span class="pill" title="' + escapeAttr(t.evidence) + '">' + escapeHtml(t.shortId) + "</span>")
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function classifyVote(pair, choice) {
    if (choice === "tie") return "tie";
    const chosen = choice === "X" ? pair.takeX : pair.takeY;
    return chosen.role === "original" ? "overrule" : "mirror";
  }

  function updateSummary() {
    let overrule = 0, mirror = 0, tie = 0, done = 0;
    for (const pair of DATA.pairs) {
      const v = votes[pair.id];
      if (!v) continue;
      done++;
      const c = classifyVote(pair, v);
      if (c === "overrule") overrule++;
      else if (c === "mirror") mirror++;
      else tie++;
    }
    document.getElementById("stat-overrule").textContent = String(overrule);
    document.getElementById("stat-mirror").textContent = String(mirror);
    document.getElementById("stat-tie").textContent = String(tie);
    document.getElementById("stat-progress").textContent = done + " / " + DATA.pairs.length;
  }

  function renderCards() {
    root.innerHTML = "";
    for (const pair of DATA.pairs) {
      const card = document.createElement("article");
      card.className = "card";
      card.id = "card-" + pair.id;

      card.innerHTML =
        '<div class="card-head">' +
          '<div>' +
            '<div class="pair-title">Pair #' + pair.number + ' — ' + escapeHtml(pair.utterance) + '</div>' +
            '<div class="pair-sub">preset: ' + escapeHtml(pair.preset) + '</div>' +
          '</div>' +
          '<span class="blind-badge" id="badge-' + pair.id + '">🙈 ブラインド中</span>' +
        '</div>' +
        '<div class="play-row">' +
          '<button class="play-btn" data-play="X">▶ Take X <span class="dur">' + pair.takeX.report.durationSec + 's</span></button>' +
          '<button class="play-btn" data-play="Y">▶ Take Y <span class="dur">' + pair.takeY.report.durationSec + 's</span></button>' +
        '</div>' +
        '<div class="vote-row">' +
          '<button class="vote-btn" data-vote="X">👈 Take X が好き（残したい）</button>' +
          '<button class="vote-btn" data-vote="Y">👉 Take Y が好き（残したい）</button>' +
          '<button class="vote-btn" data-vote="tie">🤷 どっちも同じ</button>' +
        '</div>' +
        '<div class="reveal" id="reveal-' + pair.id + '">' +
          '<div class="outcome-banner" id="outcome-' + pair.id + '"></div>' +
          '<div class="reveal-grid">' +
            '<div class="reveal-box">' +
              '<div class="reveal-box-title">Take X: ' + escapeHtml(pair.takeX.roleLabel) + '</div>' +
              '<div>Core-6: ' + (pair.takeX.report.triggeredCore.length ? escapeHtml(pair.takeX.report.triggeredCore.join(", ")) : '<span class="pill clean">PASS</span>') + '</div>' +
              '<div style="margin-top:4px;">All-32: ' + renderPills(pair.takeX.report.triggeredAll) + '</div>' +
            '</div>' +
            '<div class="reveal-box">' +
              '<div class="reveal-box-title">Take Y: ' + escapeHtml(pair.takeY.roleLabel) + '</div>' +
              '<div>Core-6: ' + (pair.takeY.report.triggeredCore.length ? escapeHtml(pair.takeY.report.triggeredCore.join(", ")) : '<span class="pill clean">PASS</span>') + '</div>' +
              '<div style="margin-top:4px;">All-32: ' + renderPills(pair.takeY.report.triggeredAll) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="mod-note">🔧 加工内容: ' + escapeHtml(pair.modificationDesc) + '（外れた対象軸: ' + escapeHtml(pair.eliminatedTargets.join(", ")) + '）</div>' +
        '</div>';

      card.querySelector('[data-play="X"]').addEventListener("click", (e) => playTake(pair.takeX.audioUri, e.currentTarget));
      card.querySelector('[data-play="Y"]').addEventListener("click", (e) => playTake(pair.takeY.audioUri, e.currentTarget));

      for (const btn of card.querySelectorAll("[data-vote]")) {
        btn.addEventListener("click", () => {
          const choice = btn.getAttribute("data-vote");
          votes[pair.id] = choice;

          for (const b of card.querySelectorAll("[data-vote]")) {
            b.classList.toggle("selected", b === btn);
          }

          const cls = classifyVote(pair, choice);
          card.classList.remove("voted-overrule", "voted-mirror", "voted-tie");
          card.classList.add("voted-" + cls);

          const badge = document.getElementById("badge-" + pair.id);
          badge.textContent = "🔓 種明かし済み";
          badge.classList.add("revealed");

          const outcomeEl = document.getElementById("outcome-" + pair.id);
          outcomeEl.className = "outcome-banner outcome-" + cls;
          if (cls === "overrule") {
            outcomeEl.textContent = "🪞 鏡の拒否権に異議あり（原音の勝ち）— " + pair.eliminatedTargets.join("/") + " を外すために音を潰すのは本末転倒！";
          } else if (cls === "mirror") {
            outcomeEl.textContent = "✅ 鏡の勝ち（修正版のほうが良い）— " + pair.eliminatedTargets.join("/") + " の指摘は耳にも合っていた";
          } else {
            outcomeEl.textContent = "🤷 どっちも同じ（引き分け）— 少なくとも強い拒否権の根拠にはならない";
          }

          document.getElementById("reveal-" + pair.id).classList.add("show");
          updateSummary();
        });
      }

      root.appendChild(card);
    }
  }

  function buildMarkdownSummary() {
    let overrule = 0, mirror = 0, tie = 0;
    const lines = [
      "# yata v0.3 — 鏡のブラインド耳審査（Mirror Audit）結果",
      "",
    ];
    for (const pair of DATA.pairs) {
      const v = votes[pair.id];
      if (!v) {
        lines.push("- Pair #" + pair.number + " " + pair.utterance + " (" + pair.preset + "): 未投票");
        continue;
      }
      const c = classifyVote(pair, v);
      if (c === "overrule") overrule++;
      else if (c === "mirror") mirror++;
      else tie++;
      const label = c === "overrule" ? "🪞 原音の勝ち（鏡に異議あり）" : c === "mirror" ? "✅ 修正版の勝ち（鏡の勝ち）" : "🤷 どっちも同じ";
      lines.push(
        "- Pair #" + pair.number + " " + pair.utterance + " (" + pair.preset + ", 対象軸: " +
        pair.eliminatedTargets.join("/") + "): " + label + " [vote=" + v + "]"
      );
    }
    lines.splice(2, 0, "**集計**: 🪞 鏡に異議あり（原音勝ち）=" + overrule + " / ✅ 鏡の勝ち（修正版勝ち）=" + mirror + " / 🤷 どっちも同じ=" + tie, "");
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
