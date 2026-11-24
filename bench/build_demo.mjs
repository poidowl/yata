#!/usr/bin/env node
/**
 * bench/build_demo.mjs — Self-Contained Interactive A/B Audition Demo Builder
 *
 * Generates `/home/antigravity/poidowl/yata/bench/yata_audition_demo.html`:
 *   - 100% self-contained single-file HTML (zero external URLs, zero CDN, offline-ready)
 *   - All 9 positive survivors + all 32 falsifier A/B pairs (F7–F32 new + F1–F6 core)
 *   - Optional bonus section with real Japanese speech from `tokiko-axis/kuda.mjs` (skips gracefully if absent)
 *   - Compact PCM16 WAV base64 data URIs (stereo preserved for ce_F30 & pos_clean_stereo)
 *   - Embedded LLM Audio Vision (`renderTextVision` / `renderTextDiff` compact)
 *   - One-click A/B playback + human judgement tally + Markdown export (with clipboard fallback modal)
 *
 * Usage:
 *   node bench/build_demo.mjs
 *   npm run build:demo
 *
 * Zero external dependencies. Pure ES Module.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCorpus,
  encodeWavBuffer,
  analyzeSamples,
  extractAudioProfile,
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
  renderTextVision,
  renderTextDiff,
} from "../unkawaii_detector.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_HTML = path.join(__dirname, "yata_audition_demo.html");
const KUDA_PATH = "/home/antigravity/poidowl/tokiko-axis/kuda.mjs";

const SR = 24000;
const SEED = 2026;

// ============================================================================
// Japanese Metadata & A/B Pairing Maps
// ============================================================================

const POSITIVE_META = {
  pos_warm_voice: {
    jpTitle: "あたたかい声（基本対照）",
    jpDesc: "ピッチ・音量・倍音が自然に連動して息のように溶ける、やわらかい声。",
    tag: "人声・基本",
  },
  pos_sasayaki: {
    jpTitle: "ささやき・吐息（ウィスパー）",
    jpDesc: "やわらかい息の成分を含むささやき声。ノイズ系・力み系に誤爆しない対照。",
    tag: "ささやき",
  },
  pos_bird_chirp: {
    jpTitle: "小鳥のさえずり",
    jpDesc: "自然な弧を描いて上がって下がる、生き物らしいさえずり（非人声）。",
    tag: "自然音",
  },
  pos_marimba: {
    jpTitle: "木琴マリンバ",
    jpDesc: "木のあたたかい倍音がやわらかく減衰するアコースティック楽器音。",
    tag: "楽器音",
  },
  pos_celesta_chime: {
    jpTitle: "チェレスタ通知音",
    jpDesc: "丸いアタックと穏やかな倍音のにじみを持つ、やさしいUIチャイム。",
    tag: "UI効果音",
  },
  pos_lullaby: {
    jpTitle: "子守唄ハミング",
    jpDesc: "緩やかな抑揚と呼吸感で降りてくる、安心感のあるハミング。",
    tag: "メロディ",
  },
  pos_naru: {
    jpTitle: "「鳴る」（やわらかい語尾）",
    jpDesc: "ふわりと開いて息へ溶けるように消える、日本語的な余韻のある発声。",
    tag: "日本語・余韻",
  },
  pos_natta: {
    jpTitle: "「鳴った」（丸い促音と着地）",
    jpDesc: "角を立てずにクッションのように着地する、やわらかい促音フレーズ。",
    tag: "日本語・促音",
  },
  pos_clean_stereo: {
    jpTitle: "自然なステレオ定位（Stereo）",
    jpDesc: "左右が心地よく相関した自然な広がりのステレオ音（逆相テスト対照）。",
    tag: "ステレオ空間",
  },
};

const CATEGORY_LABELS = {
  waveform: "波形・ダイナミクス",
  aggression: "威圧・心理音響",
  hollowness: "空洞・こもり",
  prosody: "韻律・間・制御",
  env_spatial: "環境・デジタル・空間",
  legacy: "既存 F1–F6",
};

const AXIS_META = {
  F1_HARSH_EDGE: { shortId: "F1", jpTitle: "トゲ・鋭い立ち上がり", category: "legacy", pairId: "pos_warm_voice" },
  F2_PURE_ROBOT: { shortId: "F2", jpTitle: "完全ロボ（揺らぎゼロ）", category: "legacy", pairId: "pos_warm_voice" },
  F3_PURE_NOISE: { shortId: "F3", jpTitle: "無構造ホワイトノイズ", category: "legacy", pairId: "pos_sasayaki" },
  F4_NO_COMMON_CAUSE: { shortId: "F4", jpTitle: "継ぎ接ぎ・非連動チャンネル", category: "legacy", pairId: "pos_warm_voice" },
  F5_ABRUPT_TAIL: { shortId: "F5", jpTitle: "ぶつ切り語尾（カタカナ的）", category: "legacy", pairId: "pos_naru" },
  F6_PHYSICAL_GLITCH: { shortId: "F6", jpTitle: "フルスケール音割れ・クリップ", category: "legacy", pairId: "pos_warm_voice" },

  F7_FLAT_TOP_CLIPPING: { shortId: "F7", jpTitle: "低音量フラットトップ潰れ", category: "waveform", pairId: "pos_warm_voice" },
  F8_DC_OFFSET_BIAS: { shortId: "F8", jpTitle: "DCオフセット（波形の偏り）", category: "waveform", pairId: "pos_warm_voice" },
  F9_MICRO_CLICK_DROPOUT: { shortId: "F9", jpTitle: "プチ音クリック＆瞬間音抜け", category: "waveform", pairId: "pos_warm_voice" },
  F10_BRICKWALL_SUFFOCATION: { shortId: "F10", jpTitle: "海苔波形・息苦しい音圧圧縮", category: "waveform", pairId: "pos_lullaby" },
  F11_PUMPING_TREMOLO: { shortId: "F11", jpTitle: "機械的ポンピング・トレモロ", category: "waveform", pairId: "pos_warm_voice" },

  F12_MENACING_LOW_REGISTER: { shortId: "F12", jpTitle: "威圧的な低音ドローン", category: "aggression", pairId: "pos_warm_voice" },
  F13_SUBBASS_RUMBLE: { shortId: "F13", jpTitle: "重低音ランブル・吹かれノイズ", category: "aggression", pairId: "pos_warm_voice" },
  F14_HELMHOLTZ_ROUGHNESS: { shortId: "F14", jpTitle: "ザラつく不協和うなり（粗さ）", category: "aggression", pairId: "pos_celesta_chime" },
  F15_PIERCING_WHISTLE: { shortId: "F15", jpTitle: "耳を刺す狭帯域ピー音（ハウリング）", category: "aggression", pairId: "pos_celesta_chime" },
  F16_HARSH_SIBILANCE_FIZZ: { shortId: "F16", jpTitle: "キツい歯擦音・高域シャリつき", category: "aggression", pairId: "pos_sasayaki" },

  F17_HOLLOW_METALLIC_COMB: { shortId: "F17", jpTitle: "金属パイプ・空洞コムフィルタ", category: "hollowness", pairId: "pos_marimba" },
  F18_MUDDY_BOXINESS: { shortId: "F18", jpTitle: "ダンボール箱こもり（250–650Hz）", category: "hollowness", pairId: "pos_warm_voice" },
  F19_TELEPHONE_BANDLIMIT: { shortId: "F19", jpTitle: "電話線ナローバンド劣化", category: "hollowness", pairId: "pos_warm_voice" },
  F20_STERILE_PURE_TONE: { shortId: "F20", jpTitle: "無機質な純サイン電子ビープ", category: "hollowness", pairId: "pos_celesta_chime" },

  F21_NOISY_HNR_SWAMP: { shortId: "F21", jpTitle: "ノイズ沼に沈んだ濁り声", category: "prosody", pairId: "pos_sasayaki" },
  F22_MONOTONE_FLAT_PROSODY: { shortId: "F22", jpTitle: "棒読みフラット抑揚", category: "prosody", pairId: "pos_lullaby" },
  F23_ERRATIC_PITCH_WARBLE: { shortId: "F23", jpTitle: "制御破綻・ガタガタ音程暴れ", category: "prosody", pairId: "pos_bird_chirp" },
  F24_CALCULATED_PITCH_LFO: { shortId: "F24", jpTitle: "計算っぽい機械ビブラート（LFO）", category: "prosody", pairId: "pos_lullaby" },
  F25_AUTOTUNE_STAIRCASE: { shortId: "F25", jpTitle: "オートチューン階段状ピッチ", category: "prosody", pairId: "pos_bird_chirp" },

  F26_INTERNAL_REBOUND_SHOCK: { shortId: "F26", jpTitle: "フレーズ途中の衝撃リバウンド", category: "aggression", pairId: "pos_natta" },
  F27_METRONOMIC_CADENCE: { shortId: "F27", jpTitle: "メトロノーム等間隔ロボ発話", category: "prosody", pairId: "pos_marimba" },

  F28_MAINS_HUM_DRONE: { shortId: "F28", jpTitle: "電源ハムノイズ（60Hzブーン）", category: "env_spatial", pairId: "pos_warm_voice" },
  F29_BITCRUSH_ALIASING: { shortId: "F29", jpTitle: "ビットクラッシュ・ジャギ劣化", category: "env_spatial", pairId: "pos_warm_voice" },
  F30_STEREO_PHASE_DISCOMFORT: { shortId: "F30", jpTitle: "ステレオ逆相・定位の気持ち悪さ", category: "env_spatial", pairId: "pos_clean_stereo" },

  F31_PRESSED_STRAIN: { shortId: "F31", jpTitle: "喉の力み・押し潰した緊張声", category: "aggression", pairId: "pos_sasayaki" },
  F32_SPECTRAL_STASIS: { shortId: "F32", jpTitle: "凍りついた無変化スペクトル", category: "hollowness", pairId: "pos_naru" },
};

// ============================================================================
// Helpers
// ============================================================================

function toWavDataUri(item) {
  const src = item.channels && item.channels.length >= 2 ? item.channels : item.samples;
  const buf = encodeWavBuffer(src, item.sampleRate, { bitsPerSample: 16 });
  return `data:audio/wav;base64,${buf.toString("base64")}`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function formatWhere(where) {
  if (!where || typeof where !== "object") return "";
  const parts = [];
  if (Number.isFinite(where.startSec) && Number.isFinite(where.endSec)) {
    parts.push(`${where.startSec}..${where.endSec}s`);
  } else if (Number.isFinite(where.startSec)) {
    parts.push(`@${where.startSec}s`);
  }
  if (Number.isFinite(where.freqHz) && where.freqHz > 0) {
    parts.push(`${Math.round(where.freqHz)}Hz`);
  }
  return parts.length ? parts.join(", ") : "";
}

async function buildOptionalKudaBonus(audioClips) {
  if (!fs.existsSync(KUDA_PATH)) {
    return [];
  }
  try {
    const kuda = await import(pathToFileURL(KUDA_PATH).href);
    if (typeof kuda.synthKuda !== "function") return [];

    const specs = [
      {
        id: "kuda_kawaii",
        jpTitle: "kuda.mjs: kawaii「なる」",
        jpDesc: "tokiko-axis の kawaii プリセットで合成した日本語発声「なる」。",
        text: "なる",
        opts: { preset: "kawaii", srOut: 24000, seed: 2024 },
      },
      {
        id: "kuda_sasayaki",
        jpTitle: "kuda.mjs: sasayaki「なる」",
        jpDesc: "tokiko-axis の sasayaki プリセットで合成したささやき発声「なる」。",
        text: "なる",
        opts: { preset: "sasayaki", srOut: 24000, seed: 2024 },
      },
      {
        id: "kuda_hard_katakana_natta",
        jpTitle: "kuda.mjs: 硬いカタカナ「ナッタ」",
        jpDesc: "生っぽさ(nama)を切り、低め・息少なめで硬く出した対照サンプル「ナッタ」。",
        text: "ナッタ",
        opts: { preset: "genki", nama: false, hz: 220, asp: 0.01, hopf: 0.2, srOut: 24000, seed: 2024 },
      },
    ];

    const out = [];
    for (const sp of specs) {
      const res = kuda.synthKuda(sp.text, sp.opts);
      const samples = res?.samples;
      const sr = res?.sr || 24000;
      if (!samples || !samples.length) continue;

      const rep = analyzeSamples(samples, sr, {
        label: sp.id,
        falsifiers: DEFAULT_FALSIFIERS,
      });
      const prof = extractAudioProfile(samples, sr);
      const vision = renderTextVision(prof, rep, {
        mode: "compact",
        width: 44,
        charset: "unicode",
      });

      audioClips[sp.id] = toWavDataUri({ samples, sampleRate: sr });
      const triggered = rep.falsifiers.filter((f) => f.triggered);
      out.push({
        id: sp.id,
        jpTitle: sp.jpTitle,
        jpDesc: sp.jpDesc,
        durationSec: +(samples.length / sr).toFixed(2),
        verdict: rep.verdict,
        triggeredCount: rep.triggeredCount,
        totalFalsifiers: rep.totalFalsifiers,
        triggeredList: triggered.map((t) => ({
          id: t.id,
          shortId: AXIS_META[t.id]?.shortId || t.id,
          jpTitle: AXIS_META[t.id]?.jpTitle || t.name,
          score: t.score,
          evidence: t.evidence,
        })),
        vision,
      });
    }
    return out;
  } catch (err) {
    console.warn(`[build_demo] Optional tokiko-axis/kuda.mjs skipped (${err.message})`);
    return [];
  }
}

// ============================================================================
// Main Build Pipeline
// ============================================================================

async function main() {
  const corpus = buildCorpus({ sampleRate: SR, seed: SEED });
  const audioClips = {};

  // 1. Analyze all 9 positives
  const positiveMap = new Map();
  const positiveCards = [];
  let survivedCount = 0;

  for (const item of corpus.positives) {
    const chOpt = item.channels ? { channels: item.channels } : {};
    const rep = analyzeSamples(item.samples, item.sampleRate, {
      label: item.id,
      falsifiers: DEFAULT_FALSIFIERS,
      ...chOpt,
    });
    const prof = extractAudioProfile(item.samples, item.sampleRate, chOpt);
    const vision = renderTextVision(prof, rep, {
      mode: "compact",
      width: 44,
      charset: "unicode",
    });

    audioClips[item.id] = toWavDataUri(item);
    const meta = POSITIVE_META[item.id] || {
      jpTitle: item.id,
      jpDesc: item.description,
      tag: "サンプル",
    };

    if (rep.verdict === "SURVIVED_KAWAII_CANDIDATE") survivedCount++;

    const entry = {
      id: item.id,
      jpTitle: meta.jpTitle,
      jpDesc: meta.jpDesc,
      tag: meta.tag,
      isStereo: Boolean(item.channels && item.channels.length >= 2),
      durationSec: +(item.samples.length / item.sampleRate).toFixed(2),
      verdict: rep.verdict,
      triggeredCount: rep.triggeredCount,
      totalFalsifiers: rep.totalFalsifiers,
      vision,
      rep,
      prof,
    };
    positiveMap.set(item.id, entry);
    positiveCards.push({
      id: entry.id,
      jpTitle: entry.jpTitle,
      jpDesc: entry.jpDesc,
      tag: entry.tag,
      isStereo: entry.isStereo,
      durationSec: entry.durationSec,
      verdict: entry.verdict,
      triggeredCount: entry.triggeredCount,
      totalFalsifiers: entry.totalFalsifiers,
      vision: entry.vision,
    });
  }

  // 2. Build A/B cards for all 32 falsifiers: F7–F32 first, then F1–F6
  const core6Items = corpus.legacyNegatives.filter((x) => /^ce_F[1-6]$/.test(x.id));
  const orderedCounterexamples = [...corpus.counterexamples, ...core6Items];

  let v01SlipCaughtCount = 0;
  const abCards = [];

  for (const item of orderedCounterexamples) {
    const axisId = item.targetFalsifier;
    const meta = AXIS_META[axisId];
    const falsifierDef = DEFAULT_FALSIFIERS.find((f) => f.id === axisId);
    if (!meta || !falsifierDef) continue;

    const chOpt = item.channels ? { channels: item.channels } : {};
    const rep6 = analyzeSamples(item.samples, item.sampleRate, {
      label: item.id,
      falsifiers: ORIGINAL_6_FALSIFIERS,
      ...chOpt,
    });
    const rep32 = analyzeSamples(item.samples, item.sampleRate, {
      label: item.id,
      falsifiers: DEFAULT_FALSIFIERS,
      ...chOpt,
    });
    const profA = extractAudioProfile(item.samples, item.sampleRate, chOpt);
    audioClips[item.id] = toWavDataUri(item);

    const pair = positiveMap.get(meta.pairId) || positiveMap.get("pos_warm_voice");
    const targetRes = rep32.falsifiers.find((f) => f.id === axisId);
    const otherTriggered = rep32.falsifiers
      .filter((f) => f.triggered && f.id !== axisId)
      .map((f) => AXIS_META[f.id]?.shortId || f.id);

    const isNewAxis = meta.category !== "legacy";
    const slippedV01 = isNewAxis && rep6.verdict === "SURVIVED_KAWAII_CANDIDATE" && Boolean(targetRes?.triggered);
    if (slippedV01) v01SlipCaughtCount++;

    const diffText = renderTextDiff(profA, pair.prof, rep32, pair.rep, {
      width: 44,
      charset: "unicode",
    });

    abCards.push({
      id: item.id,
      axisId,
      shortId: meta.shortId,
      jpTitle: meta.jpTitle,
      enName: falsifierDef.name,
      category: meta.category,
      categoryLabel: CATEGORY_LABELS[meta.category] || meta.category,
      isNewAxis,
      slippedV01,
      core6Triggered: rep6.triggeredCount,
      all32Triggered: rep32.triggeredCount,
      isStereo: Boolean(item.channels && item.channels.length >= 2),
      durationSec: +(item.samples.length / item.sampleRate).toFixed(2),
      description: item.description,
      score: targetRes?.score ?? 0,
      threshold: targetRes?.threshold ?? 0.5,
      triggered: Boolean(targetRes?.triggered),
      evidence: targetRes?.evidence || "",
      hint: targetRes?.hint || "",
      where: formatWhere(targetRes?.where),
      otherTriggered,
      pairId: pair.id,
      pairJpTitle: pair.jpTitle,
      pairIsStereo: pair.isStereo,
      pairDurationSec: pair.durationSec,
      diffText,
    });
  }

  // 3. Optional kuda.mjs bonus samples
  const bonusCards = await buildOptionalKudaBonus(audioClips);

  const stats = {
    survivedCount,
    totalPositives: positiveCards.length,
    newAxisCount: abCards.filter((c) => c.isNewAxis).length,
    legacyAxisCount: abCards.filter((c) => !c.isNewAxis).length,
    v01SlipCaughtCount,
    bonusCount: bonusCards.length,
  };

  // 4. Render self-contained HTML
  const html = renderHtml({ stats, positiveCards, abCards, bonusCards, audioClips });
  fs.writeFileSync(OUT_HTML, html, "utf8");

  const sizeBytes = fs.statSync(OUT_HTML).size;
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
  console.log(
    `[build_demo] Generated ${OUT_HTML} (${sizeMB} MB, ${positiveCards.length} survivors, ${abCards.length} A/B cards, ${bonusCards.length} bonus kuda clips)`
  );
}

// ============================================================================
// HTML Template (Warm Dark Studio Theme, Zero External Assets)
// ============================================================================

function renderSurvivorCard(p) {
  const badgeClass = p.verdict === "SURVIVED_KAWAII_CANDIDATE" ? "badge-pass" : "badge-fail";
  const badgeText = p.verdict === "SURVIVED_KAWAII_CANDIDATE" ? `0/${p.totalFalsifiers} SURVIVED` : `${p.triggeredCount}/${p.totalFalsifiers} REJECTED`;
  return `
    <article class="card survivor-card" data-section="survivor" data-card-id="${escapeHtml(p.id)}">
      <div class="card-top">
        <div class="card-badges">
          <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
          <span class="badge badge-muted">${escapeHtml(p.tag)}</span>
          ${p.isStereo ? '<span class="badge badge-stereo">STEREO</span>' : ""}
        </div>
        <span class="dur">${p.durationSec.toFixed(2)}s</span>
      </div>
      <h3 class="card-title">${escapeHtml(p.jpTitle)}</h3>
      <p class="card-sub"><code>${escapeHtml(p.id)}</code> — ${escapeHtml(p.jpDesc)}</p>
      <div class="play-row">
        <button type="button" class="play-btn play-btn-b" data-clip="${escapeHtml(p.id)}">
          <span class="play-icon">▶</span>
          <span class="play-label">再生して聴く</span>
          <span class="play-prog"><span class="play-prog-fill"></span></span>
        </button>
      </div>
      <details class="vision-box">
        <summary>👁️ LLMの見え方（compact）</summary>
        <pre class="vision-pre">${escapeHtml(p.vision)}</pre>
      </details>
      <div class="judge-bar" data-judge-group="survivor" data-judge-id="${escapeHtml(p.id)}" data-judge-title="${escapeHtml(p.jpTitle)}">
        <div class="judge-btns">
          <button type="button" class="jbtn jbtn-ok" data-val="ok">✨ わかる（かわいい候補OK）</button>
          <button type="button" class="jbtn jbtn-ng" data-val="ng">🤨 かわいくねーよ！（新軸候補）</button>
        </div>
        <input type="text" class="memo-input" placeholder="ひとことメモ（任意）…" aria-label="メモ" />
      </div>
    </article>`;
}

function renderAbCard(c) {
  const v01Badge = c.isNewAxis
    ? c.slippedV01
      ? '<span class="badge badge-slip">v0.1すり抜け → v0.2で発見!</span>'
      : '<span class="badge badge-new">v0.2専用軸で特定</span>'
    : '<span class="badge badge-legacy">既存 v0.1 軸</span>';

  const aLabel = c.isNewAxis
    ? "A: 新しく発見したかわいくないサンプル"
    : "A: 引っかかったサンプル";

  const otherNote =
    c.otherTriggered.length > 0
      ? `<span class="meta-pill">併発: ${escapeHtml(c.otherTriggered.join(", "))}</span>`
      : "";

  return `
    <article class="card ab-card" data-section="ab" data-category="${escapeHtml(c.category)}" data-card-id="${escapeHtml(c.shortId)}">
      <div class="card-top">
        <div class="card-badges">
          <span class="axis-id">${escapeHtml(c.shortId)}</span>
          <span class="badge badge-cat">${escapeHtml(c.categoryLabel)}</span>
          ${v01Badge}
          ${c.isStereo ? '<span class="badge badge-stereo">🎧 STEREO推奨</span>' : ""}
        </div>
        <span class="score-pill">score <strong>${c.score.toFixed(3)}</strong> / th ${c.threshold}</span>
      </div>
      <h3 class="card-title">${escapeHtml(c.jpTitle)}</h3>
      <p class="card-en"><code>${escapeHtml(c.axisId)}</code> · ${escapeHtml(c.enName)}</p>

      <div class="ab-grid">
        <div class="ab-side ab-side-a">
          <div class="ab-side-head">
            <span class="side-tag side-tag-a">A 引っかかった側</span>
            <span class="dur">${c.durationSec.toFixed(2)}s</span>
          </div>
          <button type="button" class="play-btn play-btn-a" data-clip="${escapeHtml(c.id)}">
            <span class="play-icon">▶</span>
            <span class="play-label">${escapeHtml(aLabel)}</span>
            <span class="play-prog"><span class="play-prog-fill"></span></span>
          </button>
          <div class="evidence-box">
            <div class="ev-line"><strong>根拠:</strong> <code>${escapeHtml(c.evidence)}</code>${c.where ? ` <span class="where-tag">[${escapeHtml(c.where)}]</span>` : ""}</div>
            ${c.hint ? `<div class="hint-line">💡 ${escapeHtml(c.hint)}</div>` : ""}
            ${otherNote}
          </div>
        </div>

        <div class="ab-side ab-side-b">
          <div class="ab-side-head">
            <span class="side-tag side-tag-b">B すり抜けた側（0/32）</span>
            <span class="dur">${c.pairDurationSec.toFixed(2)}s</span>
          </div>
          <button type="button" class="play-btn play-btn-b" data-clip="${escapeHtml(c.pairId)}">
            <span class="play-icon">▶</span>
            <span class="play-label">B: すり抜けた対照サンプル</span>
            <span class="play-prog"><span class="play-prog-fill"></span></span>
          </button>
          <div class="pair-info">
            対照: <strong>${escapeHtml(c.pairJpTitle)}</strong> <code>${escapeHtml(c.pairId)}</code>
          </div>
        </div>
      </div>

      <details class="vision-box">
        <summary>👁️ LLMからの見え方（A vs B 差分）</summary>
        <pre class="vision-pre">${escapeHtml(c.diffText)}</pre>
      </details>

      <div class="judge-bar" data-judge-group="ab" data-judge-id="${escapeHtml(c.shortId)}" data-judge-title="${escapeHtml(c.shortId + " " + c.jpTitle)}">
        <div class="judge-btns">
          <button type="button" class="jbtn jbtn-ok" data-val="ok">👏 でかした！（軸OK）</button>
          <button type="button" class="jbtn jbtn-ng" data-val="ng">🤨 すり抜けたほうかわいくねーよ！</button>
          <button type="button" class="jbtn jbtn-warn" data-val="warn">🤔 要調整</button>
        </div>
        <input type="text" class="memo-input" placeholder="ひとことメモ（任意）…" aria-label="メモ" />
      </div>
    </article>`;
}

function renderBonusCard(b) {
  const survived = b.verdict === "SURVIVED_KAWAII_CANDIDATE";
  const badgeClass = survived ? "badge-pass" : "badge-fail";
  const badgeText = survived ? `0/${b.totalFalsifiers} SURVIVED` : `${b.triggeredCount}/${b.totalFalsifiers} REJECTED`;
  const trigHtml =
    b.triggeredList.length > 0
      ? `<div class="evidence-box">${b.triggeredList
          .map(
            (t) =>
              `<div class="ev-line"><strong>${escapeHtml(t.shortId)} ${escapeHtml(t.jpTitle)}</strong> (score ${t.score.toFixed(3)}): <code>${escapeHtml(t.evidence)}</code></div>`
          )
          .join("")}</div>`
      : `<div class="pair-info">全 ${b.totalFalsifiers} 軸をすり抜けました。</div>`;

  return `
    <article class="card survivor-card" data-section="bonus" data-card-id="${escapeHtml(b.id)}">
      <div class="card-top">
        <div class="card-badges">
          <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
          <span class="badge badge-muted">tokiko-axis 実声</span>
        </div>
        <span class="dur">${b.durationSec.toFixed(2)}s</span>
      </div>
      <h3 class="card-title">${escapeHtml(b.jpTitle)}</h3>
      <p class="card-sub">${escapeHtml(b.jpDesc)}</p>
      <div class="play-row">
        <button type="button" class="play-btn ${survived ? "play-btn-b" : "play-btn-a"}" data-clip="${escapeHtml(b.id)}">
          <span class="play-icon">▶</span>
          <span class="play-label">再生して聴く</span>
          <span class="play-prog"><span class="play-prog-fill"></span></span>
        </button>
      </div>
      ${trigHtml}
      <details class="vision-box">
        <summary>👁️ LLMの見え方（compact）</summary>
        <pre class="vision-pre">${escapeHtml(b.vision)}</pre>
      </details>
      <div class="judge-bar" data-judge-group="bonus" data-judge-id="${escapeHtml(b.id)}" data-judge-title="${escapeHtml(b.jpTitle)}">
        <div class="judge-btns">
          <button type="button" class="jbtn jbtn-ok" data-val="ok">👏 判定に納得</button>
          <button type="button" class="jbtn jbtn-ng" data-val="ng">🤨 耳とズレてる！</button>
          <button type="button" class="jbtn jbtn-warn" data-val="warn">🤔 要調整</button>
        </div>
        <input type="text" class="memo-input" placeholder="ひとことメモ（任意）…" aria-label="メモ" />
      </div>
    </article>`;
}

function renderHtml({ stats, positiveCards, abCards, bonusCards, audioClips }) {
  const newAbCards = abCards.filter((c) => c.isNewAxis);
  const legacyAbCards = abCards.filter((c) => !c.isNewAxis);

  const bonusSectionHtml =
    bonusCards.length > 0
      ? `
    <section id="sec-bonus" class="demo-section">
      <div class="section-head">
        <h2>🎤 ボーナス: tokiko-axis (kuda.mjs) 実声サンプル試聴</h2>
        <p class="section-desc">ローカルの <code>tokiko-axis/kuda.mjs</code> で生成した日本語発声サンプルへの yata v0.2 の反応を耳で確かめます。</p>
      </div>
      <div class="survivor-grid">
        ${bonusCards.map(renderBonusCard).join("\n")}
      </div>
    </section>`
      : "";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>yata v0.2 — 耳でジャッジする「かわいくない」A/B試聴ベンチ</title>
  <style>
    :root {
      --bg: #12100f;
      --bg-soft: #1a1715;
      --surface: #221e1b;
      --surface-2: #2a2522;
      --border: #3a332e;
      --text: #f3ece4;
      --text-dim: #ada297;
      --accent: #e9a36b;
      --accent-soft: rgba(233, 163, 107, 0.14);
      --ok: #5dd39e;
      --ok-bg: rgba(93, 211, 158, 0.14);
      --ng: #fb7185;
      --ng-bg: rgba(251, 113, 133, 0.14);
      --warn: #fbbf24;
      --warn-bg: rgba(251, 191, 36, 0.15);
      --slip: #c4b5fd;
      --slip-bg: rgba(196, 181, 253, 0.16);
      --stereo: #67e8f9;
      --stereo-bg: rgba(103, 232, 249, 0.14);
      --radius: 14px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic UI", "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }

    body {
      padding-bottom: 96px;
    }

    .wrap {
      max-width: 1120px;
      margin: 0 auto;
      padding: 24px 18px 40px;
    }

    /* Header */
    .hero {
      background: linear-gradient(135deg, #211c19 0%, #191513 100%);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 24px 24px 20px;
      margin-bottom: 22px;
    }

    .hero-title {
      margin: 0 0 8px;
      font-size: clamp(1.3rem, 2.6vw, 1.75rem);
      font-weight: 700;
      letter-spacing: 0.01em;
      color: var(--text);
    }

    .axiom {
      margin: 0 0 16px;
      padding: 10px 14px;
      border-left: 3px solid var(--accent);
      background: var(--accent-soft);
      border-radius: 0 10px 10px 0;
      font-size: 0.94rem;
      color: #f8dfc9;
    }

    .stats-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
    }

    .stat-chip {
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 6px 14px;
      font-size: 0.84rem;
      color: var(--text-dim);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .stat-chip strong {
      color: var(--text);
      font-weight: 700;
    }

    .stat-chip.stat-ok strong { color: var(--ok); }
    .stat-chip.stat-slip strong { color: var(--slip); }

    /* Filter pills */
    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding-top: 6px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }

    .filter-pill {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--bg-soft);
      color: var(--text-dim);
      border-radius: 999px;
      padding: 7px 14px;
      font-size: 0.84rem;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .filter-pill:hover {
      border-color: var(--accent);
      color: var(--text);
    }

    .filter-pill.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #1a120c;
      font-weight: 700;
    }

    /* Sections */
    .demo-section {
      margin-top: 28px;
    }

    .section-head {
      margin-bottom: 14px;
    }

    .section-head h2 {
      margin: 0 0 4px;
      font-size: 1.2rem;
      font-weight: 700;
    }

    .section-desc {
      margin: 0;
      font-size: 0.88rem;
      color: var(--text-dim);
    }

    .subsection-divider {
      margin: 26px 0 14px;
      padding: 8px 14px;
      border-radius: 10px;
      background: var(--bg-soft);
      border: 1px dashed var(--border);
      font-size: 0.9rem;
      color: var(--text-dim);
      font-weight: 600;
    }

    .survivor-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
      gap: 14px;
    }

    .ab-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Cards */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 18px;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .card.judged-ok { border-color: rgba(93, 211, 158, 0.55); }
    .card.judged-ng { border-color: rgba(251, 113, 133, 0.65); }
    .card.judged-warn { border-color: rgba(251, 191, 36, 0.55); }

    .card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }

    .card-badges {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }

    .axis-id {
      font-family: var(--mono);
      font-weight: 800;
      font-size: 0.86rem;
      padding: 2px 9px;
      border-radius: 7px;
      background: var(--accent);
      color: #1a120c;
    }

    .badge {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 2px 9px;
      border-radius: 999px;
      white-space: nowrap;
    }

    .badge-pass { background: var(--ok-bg); color: var(--ok); border: 1px solid rgba(93,211,158,0.3); }
    .badge-fail { background: var(--ng-bg); color: var(--ng); border: 1px solid rgba(251,113,133,0.3); }
    .badge-cat { background: var(--surface-2); color: #e5d8cc; border: 1px solid var(--border); }
    .badge-slip { background: var(--slip-bg); color: var(--slip); border: 1px solid rgba(196,181,253,0.35); }
    .badge-new { background: var(--accent-soft); color: var(--accent); border: 1px solid rgba(233,163,107,0.3); }
    .badge-legacy { background: rgba(255,255,255,0.06); color: var(--text-dim); border: 1px solid var(--border); }
    .badge-muted { background: var(--bg-soft); color: var(--text-dim); border: 1px solid var(--border); }
    .badge-stereo { background: var(--stereo-bg); color: var(--stereo); border: 1px solid rgba(103,232,249,0.35); }

    .dur, .score-pill {
      font-family: var(--mono);
      font-size: 0.78rem;
      color: var(--text-dim);
    }

    .score-pill strong { color: var(--ng); }

    .card-title {
      margin: 2px 0 4px;
      font-size: 1.06rem;
      font-weight: 700;
    }

    .card-sub, .card-en {
      margin: 0 0 12px;
      font-size: 0.84rem;
      color: var(--text-dim);
    }

    code {
      font-family: var(--mono);
      font-size: 0.82em;
      background: rgba(255,255,255,0.06);
      padding: 1px 5px;
      border-radius: 5px;
      color: #f1dfcf;
    }

    /* A/B side-by-side */
    .ab-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 10px;
    }

    @media (max-width: 720px) {
      .ab-grid { grid-template-columns: 1fr; }
    }

    .ab-side {
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: 11px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .ab-side-a { border-color: rgba(251, 113, 133, 0.28); }
    .ab-side-b { border-color: rgba(93, 211, 158, 0.28); }

    .ab-side-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.78rem;
    }

    .side-tag {
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 6px;
    }
    .side-tag-a { background: var(--ng-bg); color: var(--ng); }
    .side-tag-b { background: var(--ok-bg); color: var(--ok); }

    /* Play button */
    .play-row { margin-bottom: 10px; }

    .play-btn {
      position: relative;
      width: 100%;
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 11px 14px 14px;
      font-family: inherit;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      text-align: left;
      overflow: hidden;
      transition: transform 0.08s ease, background 0.15s ease, border-color 0.15s ease;
    }

    .play-btn:active { transform: scale(0.99); }

    .play-btn-a {
      background: rgba(251, 113, 133, 0.12);
      border-color: rgba(251, 113, 133, 0.42);
      color: #ffe2e7;
    }
    .play-btn-a:hover { background: rgba(251, 113, 133, 0.22); }

    .play-btn-b {
      background: rgba(93, 211, 158, 0.12);
      border-color: rgba(93, 211, 158, 0.42);
      color: #dffef0;
    }
    .play-btn-b:hover { background: rgba(93, 211, 158, 0.22); }

    .play-btn.playing {
      box-shadow: 0 0 0 2px var(--accent);
      border-color: var(--accent);
    }

    .play-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(255,255,255,0.12);
      font-size: 0.82rem;
      flex-shrink: 0;
    }

    .play-btn.playing .play-icon {
      background: var(--accent);
      color: #1a120c;
      animation: pulse 0.9s infinite ease-in-out;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.14); opacity: 0.78; }
    }

    .play-prog {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 4px;
      background: rgba(255,255,255,0.08);
    }

    .play-prog-fill {
      display: block;
      height: 100%;
      width: 0%;
      background: var(--accent);
      transition: width 0.05s linear;
    }

    .evidence-box {
      font-size: 0.8rem;
      color: var(--text-dim);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .ev-line { word-break: break-word; }
    .hint-line { color: #e8cfa9; font-size: 0.79rem; }
    .where-tag { font-family: var(--mono); color: var(--accent); font-size: 0.76rem; }
    .meta-pill { font-size: 0.74rem; color: var(--text-dim); }
    .pair-info { font-size: 0.82rem; color: var(--text-dim); }

    /* LLM Vision collapsible */
    .vision-box {
      margin: 8px 0 12px;
      background: #141210;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 6px 10px;
    }

    .vision-box summary {
      cursor: pointer;
      font-size: 0.82rem;
      color: var(--text-dim);
      font-weight: 600;
      user-select: none;
      padding: 2px 0;
    }

    .vision-box summary:hover { color: var(--text); }

    .vision-pre {
      margin: 8px 0 4px;
      padding: 10px 12px;
      background: #0d0b0a;
      border-radius: 8px;
      font-family: var(--mono);
      font-size: 0.74rem;
      line-height: 1.38;
      color: #e6dfd6;
      overflow-x: auto;
      white-space: pre;
    }

    /* Judge bar */
    .judge-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding-top: 10px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }

    .judge-btns {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .jbtn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--bg-soft);
      color: var(--text-dim);
      border-radius: 8px;
      padding: 6px 11px;
      font-size: 0.8rem;
      font-family: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.12s ease;
    }

    .jbtn:hover { color: var(--text); border-color: #6b5e53; }
    .jbtn-ok.selected { background: var(--ok-bg); border-color: var(--ok); color: var(--ok); }
    .jbtn-ng.selected { background: var(--ng-bg); border-color: var(--ng); color: var(--ng); }
    .jbtn-warn.selected { background: var(--warn-bg); border-color: var(--warn); color: var(--warn); }

    .memo-input {
      flex: 1 1 180px;
      min-width: 140px;
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
      color: var(--text);
      font-family: inherit;
      font-size: 0.82rem;
    }

    .memo-input:focus {
      outline: none;
      border-color: var(--accent);
    }

    /* Sticky Bottom Bar */
    .sticky-bar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 50;
      background: rgba(20, 17, 15, 0.94);
      backdrop-filter: blur(10px);
      border-top: 1px solid var(--border);
      padding: 10px 18px;
    }

    .sticky-inner {
      max-width: 1120px;
      margin: 0 auto;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .tally-group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      font-size: 0.85rem;
    }

    .tally-pill {
      padding: 4px 10px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 0.82rem;
    }

    .tally-ok { background: var(--ok-bg); color: var(--ok); }
    .tally-ng { background: var(--ng-bg); color: var(--ng); }
    .tally-warn { background: var(--warn-bg); color: var(--warn); }
    .tally-total { color: var(--text-dim); font-size: 0.8rem; }

    .sticky-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .action-btn {
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 8px 14px;
      font-family: inherit;
      font-size: 0.84rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-copy {
      background: var(--accent);
      border-color: var(--accent);
      color: #1a120c;
    }
    .btn-copy:hover { filter: brightness(1.08); }

    .btn-reset {
      background: var(--surface);
      color: var(--text-dim);
    }
    .btn-reset:hover { color: var(--text); border-color: var(--ng); }

    /* Fallback Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.72);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 18px;
    }

    .modal-backdrop.open { display: flex; }

    .modal-box {
      width: min(680px, 100%);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .modal-box h3 { margin: 0; font-size: 1rem; }

    .modal-textarea {
      width: 100%;
      min-height: 220px;
      background: #12100f;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      font-family: var(--mono);
      font-size: 0.8rem;
      resize: vertical;
    }

    .modal-foot {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <h1 class="hero-title">yata v0.2 — 耳でジャッジする「かわいくない」A/B試聴ベンチ</h1>
      <p class="axiom">第0公理: 「音声から『かわいくなさ』を多次元的に発見する。それに失敗したら『かわいい』。」</p>
      <div class="stats-row">
        <span class="stat-chip stat-ok">🏆 SURVIVED: <strong>${stats.survivedCount} / ${stats.totalPositives}</strong></span>
        <span class="stat-chip">🔬 新発見軸: <strong>${stats.newAxisCount} (F7–F32)</strong></span>
        <span class="stat-chip">🧱 既存軸: <strong>${stats.legacyAxisCount} (F1–F6)</strong></span>
        <span class="stat-chip stat-slip">✨ v0.1すり抜け→v0.2捕捉: <strong>${stats.v01SlipCaughtCount} / ${stats.newAxisCount}</strong></span>
      </div>
      <nav class="filter-bar" aria-label="ドメインフィルタ">
        <button type="button" class="filter-pill active" data-filter="all">すべて</button>
        <button type="button" class="filter-pill" data-filter="survivor">すり抜け候補 (${stats.totalPositives})</button>
        <button type="button" class="filter-pill" data-filter="waveform">波形・ダイナミクス</button>
        <button type="button" class="filter-pill" data-filter="aggression">威圧・心理音響</button>
        <button type="button" class="filter-pill" data-filter="hollowness">空洞・こもり</button>
        <button type="button" class="filter-pill" data-filter="prosody">韻律・間・制御</button>
        <button type="button" class="filter-pill" data-filter="env_spatial">環境・デジタル・空間</button>
        <button type="button" class="filter-pill" data-filter="legacy">既存 F1–F6</button>
      </nav>
    </header>

    <section id="sec-survivors" class="demo-section">
      <div class="section-head">
        <h2>🏆 いまのところ「かわいくない」をすり抜けた音 (SURVIVED_KAWAII_CANDIDATE)</h2>
        <p class="section-desc">全32軸の反証をすり抜けた ${stats.totalPositives} サンプル。「すり抜けたのにかわいくねーよ！」と思ったら、それが次の新軸のタネです。</p>
      </div>
      <div class="survivor-grid">
        ${positiveCards.map(renderSurvivorCard).join("\n")}
      </div>
    </section>

    <section id="sec-ab" class="demo-section">
      <div class="section-head">
        <h2>🔬 新発見の「かわいくない」軸 A/B 聴き比べカード (F7–F32 + F1–F6)</h2>
        <p class="section-desc">左の <strong>A（引っかかった側）</strong> と右の <strong>B（すり抜けた対照）</strong> をワンクリックで聴き比べて、耳で直感ジャッジしてください。</p>
      </div>
      <div class="ab-list" id="ab-new-list">
        ${newAbCards.map(renderAbCard).join("\n")}
      </div>
      <div class="subsection-divider" id="legacy-divider">🧱 既存コア軸 (v0.1: F1–F6)</div>
      <div class="ab-list" id="ab-legacy-list">
        ${legacyAbCards.map(renderAbCard).join("\n")}
      </div>
    </section>

    ${bonusSectionHtml}
  </div>

  <footer class="sticky-bar" role="region" aria-label="ジャッジ集計バー">
    <div class="sticky-inner">
      <div class="tally-group">
        <span class="tally-pill tally-ok">👏 でかした: <span id="tally-ok">0</span></span>
        <span class="tally-pill tally-ng">🤨 かわいくねーよ: <span id="tally-ng">0</span></span>
        <span class="tally-pill tally-warn">🤔 要調整: <span id="tally-warn">0</span></span>
        <span class="tally-total" id="tally-total">判定済 0</span>
      </div>
      <div class="sticky-actions">
        <button type="button" class="action-btn btn-copy" id="btn-copy">📋 ジャッジ結果をまとめてコピー</button>
        <button type="button" class="action-btn btn-reset" id="btn-reset">🔄 リセット</button>
      </div>
    </div>
  </footer>

  <div class="modal-backdrop" id="copy-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-box">
      <h3 id="modal-title">📋 ジャッジ結果（Markdown）</h3>
      <textarea class="modal-textarea" id="modal-textarea" readonly></textarea>
      <div class="modal-foot">
        <button type="button" class="action-btn btn-copy" id="modal-select">全選択</button>
        <button type="button" class="action-btn btn-reset" id="modal-close">閉じる</button>
      </div>
    </div>
  </div>

  <script>
    (() => {
      const AUDIO_CLIPS = ${safeJsonForScript(audioClips)};
      const STORAGE_KEY = "yata_v02_audition_judgements_v1";

      // ------------------------------------------------------------------
      // Shared single <audio> controller
      // ------------------------------------------------------------------
      const audio = new Audio();
      let activeBtn = null;
      let rafId = null;

      function stopPlayback() {
        audio.pause();
        audio.currentTime = 0;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (activeBtn) {
          activeBtn.classList.remove("playing");
          const icon = activeBtn.querySelector(".play-icon");
          if (icon) icon.textContent = "▶";
          const fill = activeBtn.querySelector(".play-prog-fill");
          if (fill) fill.style.width = "0%";
          activeBtn = null;
        }
      }

      function tickProgress() {
        if (!activeBtn) return;
        const fill = activeBtn.querySelector(".play-prog-fill");
        if (fill && Number.isFinite(audio.duration) && audio.duration > 0) {
          const pct = Math.min(100, Math.max(0, (audio.currentTime / audio.duration) * 100));
          fill.style.width = pct.toFixed(1) + "%";
        }
        if (!audio.paused && !audio.ended) {
          rafId = requestAnimationFrame(tickProgress);
        }
      }

      audio.addEventListener("ended", stopPlayback);
      audio.addEventListener("error", stopPlayback);

      document.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".play-btn");
        if (!btn) return;
        const clipId = btn.dataset.clip;
        if (!clipId || !AUDIO_CLIPS[clipId]) return;

        if (activeBtn === btn && !audio.paused) {
          stopPlayback();
          return;
        }

        stopPlayback();
        activeBtn = btn;
        btn.classList.add("playing");
        const icon = btn.querySelector(".play-icon");
        if (icon) icon.textContent = "■";

        audio.src = AUDIO_CLIPS[clipId];
        audio.currentTime = 0;
        const p = audio.play();
        if (p && typeof p.catch === "function") {
          p.catch(() => stopPlayback());
        }
        rafId = requestAnimationFrame(tickProgress);
      });

      // ------------------------------------------------------------------
      // Domain filter pills
      // ------------------------------------------------------------------
      const secSurvivors = document.getElementById("sec-survivors");
      const secAb = document.getElementById("sec-ab");
      const secBonus = document.getElementById("sec-bonus");
      const legacyDivider = document.getElementById("legacy-divider");
      const abCards = Array.from(document.querySelectorAll(".ab-card"));
      const filterPills = Array.from(document.querySelectorAll(".filter-pill"));

      function applyFilter(filter) {
        for (const pill of filterPills) {
          pill.classList.toggle("active", pill.dataset.filter === filter);
        }

        if (filter === "all") {
          secSurvivors.classList.remove("hidden");
          secAb.classList.remove("hidden");
          if (secBonus) secBonus.classList.remove("hidden");
          legacyDivider.classList.remove("hidden");
          for (const c of abCards) c.classList.remove("hidden");
          return;
        }

        if (filter === "survivor") {
          secSurvivors.classList.remove("hidden");
          secAb.classList.add("hidden");
          if (secBonus) secBonus.classList.remove("hidden");
          return;
        }

        secSurvivors.classList.add("hidden");
        if (secBonus) secBonus.classList.add("hidden");
        secAb.classList.remove("hidden");
        legacyDivider.classList.toggle("hidden", filter !== "legacy");
        for (const c of abCards) {
          c.classList.toggle("hidden", c.dataset.category !== filter);
        }
      }

      for (const pill of filterPills) {
        pill.addEventListener("click", () => applyFilter(pill.dataset.filter));
      }

      // ------------------------------------------------------------------
      // Human judgements + localStorage (safe in sandboxed iframes)
      // ------------------------------------------------------------------
      let state = {};
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) state = JSON.parse(raw) || {};
      } catch (_) {
        state = {};
      }

      function saveState() {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (_) {}
      }

      const judgeBars = Array.from(document.querySelectorAll(".judge-bar"));
      const elOk = document.getElementById("tally-ok");
      const elNg = document.getElementById("tally-ng");
      const elWarn = document.getElementById("tally-warn");
      const elTotal = document.getElementById("tally-total");

      function syncUiFromState() {
        let ok = 0;
        let ng = 0;
        let warn = 0;

        for (const bar of judgeBars) {
          const id = bar.dataset.judgeId;
          const entry = state[id] || {};
          const card = bar.closest(".card");

          if (entry.val === "ok") ok++;
          else if (entry.val === "ng") ng++;
          else if (entry.val === "warn") warn++;

          for (const b of bar.querySelectorAll(".jbtn")) {
            b.classList.toggle("selected", b.dataset.val === entry.val);
          }

          if (card) {
            card.classList.toggle("judged-ok", entry.val === "ok");
            card.classList.toggle("judged-ng", entry.val === "ng");
            card.classList.toggle("judged-warn", entry.val === "warn");
          }

          const inp = bar.querySelector(".memo-input");
          if (inp && inp.value !== (entry.memo || "")) {
            inp.value = entry.memo || "";
          }
        }

        elOk.textContent = String(ok);
        elNg.textContent = String(ng);
        elWarn.textContent = String(warn);
        elTotal.textContent = "判定済 " + (ok + ng + warn) + " / " + judgeBars.length;
      }

      for (const bar of judgeBars) {
        const id = bar.dataset.judgeId;
        const group = bar.dataset.judgeGroup;
        const title = bar.dataset.judgeTitle;

        for (const b of bar.querySelectorAll(".jbtn")) {
          b.addEventListener("click", () => {
            const cur = state[id] || { group, title, val: null, memo: "" };
            cur.val = cur.val === b.dataset.val ? null : b.dataset.val;
            cur.group = group;
            cur.title = title;
            if (!cur.val && !cur.memo) delete state[id];
            else state[id] = cur;
            saveState();
            syncUiFromState();
          });
        }

        const inp = bar.querySelector(".memo-input");
        if (inp) {
          inp.addEventListener("input", () => {
            const cur = state[id] || { group, title, val: null, memo: "" };
            cur.memo = inp.value;
            cur.group = group;
            cur.title = title;
            if (!cur.val && !cur.memo) delete state[id];
            else state[id] = cur;
            saveState();
          });
        }
      }

      syncUiFromState();

      // ------------------------------------------------------------------
      // Copy Markdown summary + Fallback modal
      // ------------------------------------------------------------------
      function buildMarkdownSummary() {
        const groups = { survivor: [], ab: [], bonus: [] };
        let ok = 0, ng = 0, warn = 0;

        for (const bar of judgeBars) {
          const id = bar.dataset.judgeId;
          const entry = state[id];
          if (!entry || (!entry.val && !entry.memo)) continue;
          if (entry.val === "ok") ok++;
          else if (entry.val === "ng") ng++;
          else if (entry.val === "warn") warn++;

          const label =
            entry.val === "ok"
              ? "👏 でかした/OK"
              : entry.val === "ng"
              ? "🤨 かわいくねーよ！"
              : entry.val === "warn"
              ? "🤔 要調整"
              : "📝 メモのみ";
          const memo = entry.memo ? " — " + entry.memo : "";
          const line = "- **" + entry.title + "**: " + label + memo;
          (groups[entry.group] || groups.ab).push(line);
        }

        const lines = [
          "# yata v0.2 耳ジャッジ結果",
          "",
          "- 👏 でかした/OK: " + ok + " | 🤨 かわいくねーよ: " + ng + " | 🤔 要調整: " + warn,
          "",
        ];

        if (groups.ab.length) {
          lines.push("## 🔬 A/B 軸ジャッジ", ...groups.ab, "");
        }
        if (groups.survivor.length) {
          lines.push("## 🏆 すり抜け候補ジャッジ", ...groups.survivor, "");
        }
        if (groups.bonus.length) {
          lines.push("## 🎤 tokiko-axis ボーナス", ...groups.bonus, "");
        }
        if (!groups.ab.length && !groups.survivor.length && !groups.bonus.length) {
          lines.push("（まだジャッジが入力されていません）");
        }
        return lines.join("\\n");
      }

      const btnCopy = document.getElementById("btn-copy");
      const btnReset = document.getElementById("btn-reset");
      const modal = document.getElementById("copy-modal");
      const modalTa = document.getElementById("modal-textarea");
      const modalSelect = document.getElementById("modal-select");
      const modalClose = document.getElementById("modal-close");

      function openFallbackModal(text) {
        modalTa.value = text;
        modal.classList.add("open");
        modalTa.focus();
        modalTa.select();
      }

      btnCopy.addEventListener("click", async () => {
        const md = buildMarkdownSummary();
        let copied = false;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          try {
            await navigator.clipboard.writeText(md);
            copied = true;
          } catch (_) {
            copied = false;
          }
        }
        if (copied) {
          const orig = btnCopy.textContent;
          btnCopy.textContent = "✅ コピーしました！";
          setTimeout(() => { btnCopy.textContent = orig; }, 1800);
        } else {
          openFallbackModal(md);
        }
      });

      modalSelect.addEventListener("click", () => {
        modalTa.focus();
        modalTa.select();
        try { document.execCommand("copy"); } catch (_) {}
      });

      modalClose.addEventListener("click", () => modal.classList.remove("open"));
      modal.addEventListener("click", (ev) => {
        if (ev.target === modal) modal.classList.remove("open");
      });

      btnReset.addEventListener("click", () => {
        state = {};
        saveState();
        for (const bar of judgeBars) {
          const inp = bar.querySelector(".memo-input");
          if (inp) inp.value = "";
        }
        syncUiFromState();
      });
    })();
  </script>
</body>
</html>
`;
}

main().catch((err) => {
  console.error("[build_demo] Failed:", err);
  process.exit(1);
});
