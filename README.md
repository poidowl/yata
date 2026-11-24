# yata

> **音声から「かわいくなさ」を多次元的に発見する。それに失敗したら「かわいい」。**

**yata**（八咫鏡 — 音という鏡）は、音声から「かわいくなさ（＝聴き手の身体が『一緒にいたくない』と感じる兆候）」を **32次元** で検出し、LLM が少ないトークンで音を「視る」ための **LLM 音声可視化（Text / SVG / PNG）** まで備えた、**ゼロ依存・純 JavaScript (ESM)** の検証スイートです。

人声・ささやき・韻律・間/リズム・UI音/効果音・電子音・空間/ステレオ・録音/デジタル劣化・心理音響まで、TTS に閉じず音全般を対象とします。

- 設計思想の背景: [`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md)
- 番人 LLM・開発憲法: [`AGENTS.md`](AGENTS.md)

---

## 第0公理（思想）

1. **「かわいい」は全部は書けない。でも「かわいくない」は書ける。**
2. 音は「鏡」であり、威圧・トゲ・計算・空洞・破綻・息苦しさ・不自然な間といった「一緒にいたくないなにか」が映ったとき、ヒトはかわいくないと感じる。
3. 32次元の反証軸（Falsifiers `F1`–`F32`）をすべてすり抜けて反証に失敗した音だけを `SURVIVED_KAWAII_CANDIDATE` として残す。
4. すり抜けた反例が見つかったら、新しい検出軸を1本追加して篩（ふるい）を細かくする。

---

## 32次元の「かわいくなさ」反証軸 (`F1`–`F32`)

| カテゴリ | 軸 ID | 検出対象 |
| :--- | :--- | :--- |
| **Core (v0.1 互換)** | `F1`–`F6` | 鋭いエッジ/高域攻撃、機械的硬直、純ノイズ、無相関チャネル、ぶつ切り語尾、フルスケール破綻 |
| **波形・ダイナミクス** | `F7`–`F11` | サブフルスケール平坦クリップ、DCオフセット、微小クリック/欠落、音圧の壁（息苦しさ）、機械的トレモロ |
| **攻撃性・心理音響** | `F12`–`F16`, `F31` | 威圧的低音域、超低域ランブル、ヘルムホルツ粗さ（うなり）、耳障りな高域ホイッスル、歯擦音フィズ、力み（ささやき保護付き） |
| **空洞・音色停滞** | `F17`–`F20`, `F32` | 金属的コム共振、箱鳴り/こもり、電話帯域制限、無菌純音ビープ、音色の完全停滞 |
| **韻律・制御・間** | `F21`–`F27` | 低HNRノイズ沼、平坦モノトーン、不安定ピッチ揺れ、作為的LFOビブラート、Auto-Tune階段、語中リバウンド衝撃、メトロノーム硬直 |
| **環境・デジタル・空間** | `F28`–`F30` | 50/60Hz 電源ハム、ビットクラッシュ/折り返し、ステレオ位相反転・極端な偏り（モノラル自動スキップ） |

全軸の一覧は `node unkawaii_detector.mjs --list-falsifiers` で確認できます。

### 判定ポリシーと v0.4–v0.7 の主な改善

- **既定ポリシー = `core_veto`**: `F1`–`F6`（`ORIGINAL_6_FALSIFIERS`）のみでハード拒否を行い、`F7`–`F32`（`TOOLBOX_FALSIFIERS`）は非拒否の診断ヒント、`F30`（ステレオ逆相）は直交軸（`ORTHOGONAL_AXES`）として分離します。
- **`--policy shelf_veto --contested ...`**: Protected Shelf 監査（`auditFalsifiersAgainstShelf`）で `CONTESTED` になった軸の拒否権を自動停止します。全32軸ハード拒否が必要な場合のみ `--policy veto_all` を明示指定します。
- **v0.7 過剰整えレンズ、2トラック関係対話ミラー & 生きた息の余韻モード（*"The Unpolished & Relational Mirror"*）**:
  - **過剰整え / 生きている不完全さレンズ（`computeSanitizationIndex`・非拒否診断）**: 「完璧じゃない　きれいに整えようとしてない」（[`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md) 第9節）に基づき、微細揺らぎ消去・ピッチ平坦/階段化・ダイナミクス平坦化・リズム/スペクトル硬直の4手がかりから `sanitizationScore`（`[0, 1]`）と `imperfectionLabel`（`alive_unpolished` / `balanced` / `over_sanitized` / `silent`）を算出。`renderTextVision`（`SAN=0.XX`）へ併記し、`--compare` では B が過剰に整えられた場合に `OVER-SANITIZATION WARNING` を通知。
  - **2トラック関係対話ミラー（`src/dialogue.mjs` / `--dialogue <a.wav> <b.wav>`）**: 第5領域「関係の断絶・間」を実装。2トラックを 10ms RMS 枠で整列し、`turnCount`・`overlapRatio`・`meanTurnGapSec`・`mutualSilenceRatio`・`relationLabel`（`responsive_dialogue` / `overlapping_clash` / `disconnected_monologue` / `silent_void`）を5行のコンパクト地図（`renderDialogueMap`）で可視化。
  - **生きた息の余韻反事実モード（`--cf-mode breath_tail`）**: ぶつ切り語尾にクリックゼロの柔らかな指数減衰＋微かな有機的呼気尾（`~0.18s`）を局所付加し、死んだ無音カットオフと生きた抜けを耳で比較可能に。
- **v0.6 呼吸・間プロファイル、Voice Compass、窓別タイムライン差分 & 最小反事実オーディオミラー**:
  - **呼吸・間プロファイル（`computeBreathPauseProfile`）**: `activeDutyCycle` / `pauseCount` / `meanPauseSec` / `longestContinuousSec` / `breathlessWallRatio` / `cadenceLabel`（`silent` / `brief_glance` / `phrased_breath` / `continuous_wall`）を `extractFeatures` と `extractSegmentTimeline` へ統合し、`renderSegmentTimeline` のヘッダ（4行枠維持）に `duty=XX% pauses=N maxRun=X.Xs [cadenceLabel]` を表示。
  - **Voice Compass（`computeVoiceCompass`・非拒否診断レンズ）**: 「声＝誰かに聞かせるために出した音で、呼吸器を使ったもの」（[`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md) 第8節）を `respiratoryScore` × `directnessScore` の2軸4象限（`addressed_breath` / `distant_or_private_breath` / `non_breath_signal` / `ambient_or_hollow`）へ分解し、`extractFeatures`・`extractSegmentTimeline`・`renderTextVision`（`RESP=0.XX DIR=0.XX [label]`）へ統合。
  - **窓別タイムライン差分（`renderTimelineDiff` / `--timeline-diff` / `--compare ... --timeline`）**: 2音の `0.5s` 窓ごとの変化（`dPRES`, `dACT%`, `dMPS`, `dF0`）を5行で表示し、最も変化した半秒窓（`HOTSPOT`）を特定。
  - **最小反事実オーディオミラー（`src/counterfactual.mjs` / `--counterfactual <out.wav>`）**: `findTimelineHotspot` で最も粗い半秒窓を特定し、`generateCounterfactualSlice` がその窓 `[startSec..endSec]` **だけ**をゼロ位相ローパス＋30–150 Hz エンベロープ粗さ減衰＋コサインクロスフェードで局所緩和（窓外のサンプルはビット単位で原音と同一）した試聴用 WAV と差分を同時出力。
- **v0.5 神経科学 DSP レンズ & 時間分割ミラー（`--timeline`）**:
  - **Arnal MPS 30–150 Hz 粗さ**（`mpsRoughness30_150` / `mpsSpeech4_16` / `mpsRoughToSpeechRatio` — Arnal et al. 2015/2025）と **非線形サブハーモニクス**（`subharmonicRatio` — Fitch et al. 2002 / Anikin 2020）を純 JS で実装し、コンパクトテキスト視覚（`MPS30-150`, `SUBH`）へ統合。
  - `extractSegmentTimeline` / `renderSegmentTimeline` / `--timeline` により、`0.5s` 窓ごとの存在感 `PRES(active%)`（有声・連動の質＋その半秒で音が鳴っていた割合）× MPS 30–150 Hz 粗さ × F0 を4行で一覧表示。
- **v0.5 耳判例メモリ（`--shelf` / `--precedents` + `--scope`）**:
  - オーナーのブラインド3択・2択鏡審査結果（コミット `245ed15` 版での `🪞 原音派 5–0`、独立等確率のもとで全5回原音になる単純確率 `1/108 ≈ 0.0093`、`#4 tie`）を [`bench/real_audio_audit/MIRROR_AUDIT_VERDICT.md`](bench/real_audio_audit/MIRROR_AUDIT_VERDICT.md) および [`bench/real_audio_audit/ear_precedents.json`](bench/real_audio_audit/ear_precedents.json) に永続化。
  - `--shelf bench/real_audio_audit/ear_precedents.json --scope tokiko_japanese_speech` のように適用範囲（`--scope`）を明示した場合のみスコープ付き判例（`[EAR-OVERRULED 5-0 @ tokiko_japanese_speech (245ed15)]` 等）が適用され、別ドメインの音への誤適用を防ぎます（`general_audio` の `[ORTHOGONAL]` のみ常時適用）。
- **鏡の耳審査 & 実音監査**:
  - 3択ブラインド「なる」鏡審査デモ（原音 vs 抑揚保持・揺れ弱め vs 完全フラット）: [`bench/mirror_audit_demo.html`](bench/mirror_audit_demo.html)
  - 再現可能な実音・保護棚監査レポート（MPS / サブハーモニクス実音評価含む）: [`bench/real_audio_audit/RESULTS.md`](bench/real_audio_audit/RESULTS.md)

---

## 使い方（CLI）

Node.js v18+ があれば外部パッケージなしでそのまま動きます。

```bash
# 1. 基本解析（既定は --policy core_veto：基本6軸で判定＋ツールボックス軸を診断併記）
node unkawaii_detector.mjs sample.wav
node unkawaii_detector.mjs sample.wav --format json
node unkawaii_detector.mjs sample.wav --shelf bench/real_audio_audit/ear_precedents.json --scope tokiko_japanese_speech
node unkawaii_detector.mjs sample.wav --policy shelf_veto --contested F24_CALCULATED_PITCH_LFO,F23_ERRATIC_PITCH_WARBLE
node unkawaii_detector.mjs sample.wav --policy veto_all    # 全32軸でハード拒否
node unkawaii_detector.mjs sample.wav --falsifiers core   # v0.1 の6軸のみで検証

# 2. LLM 音声可視化（高密度テキスト / 60Hz MEL下限 / 異常区間ズーム / 0.5s 時間分割ミラー / 最小反事実 WAV / SVG / PNG）
node unkawaii_detector.mjs sample.wav --view compact --charset unicode
node unkawaii_detector.mjs sample.wav --view micro
node unkawaii_detector.mjs sample.wav --view compact --zoom auto
node unkawaii_detector.mjs sample.wav --view compact --zoom 0.1..0.4
node unkawaii_detector.mjs sample.wav --timeline
node unkawaii_detector.mjs sample.wav --counterfactual cf_softened.wav
node unkawaii_detector.mjs sample.wav --counterfactual cf_softened.wav --cf-window 0.5..1.0
node unkawaii_detector.mjs sample.wav --counterfactual cf_breath.wav --cf-mode breath_tail
node unkawaii_detector.mjs sample.wav --svg vision.svg --png vision.png

# 3. 2音の比較・A/B ビジュアル差分・窓別タイムライン差分・2トラック関係対話ミラー
node unkawaii_detector.mjs --compare a.wav b.wav
node unkawaii_detector.mjs --compare a.wav b.wav --timeline
node unkawaii_detector.mjs --compare a.wav b.wav --view compact --svg cmp.svg --png cmp.png
node unkawaii_detector.mjs --diff a.wav b.wav --timeline --charset unicode --svg diff.svg --png diff.png
node unkawaii_detector.mjs --timeline-diff a.wav b.wav
node unkawaii_detector.mjs --dialogue speaker_a.wav speaker_b.wav
node unkawaii_detector.mjs --dialogue speaker_a.wav speaker_b.wav --format json

# 4. 反例発見ループ（合成コーパスで v0.1 6軸 vs 全32軸を比較）
node unkawaii_detector.mjs --discover
node unkawaii_detector.mjs --discover --view

# 5. 全32軸の一覧
node unkawaii_detector.mjs --list-falsifiers
```

---

## プログラムから使う（ES Module）

v0.1 のすべてのエクスポートと 100% 後方互換です。

```js
import {
  decodeWavBuffer,
  encodeWavBuffer,
  extractFeatures,
  extractAudioProfile,
  extractSegmentTimeline,
  computeBreathPauseProfile,
  computeVoiceCompass,
  computeSanitizationIndex,
  analyzeDialogue,
  renderDialogueMap,
  findTimelineHotspot,
  generateCounterfactualSlice,
  DEFAULT_FALSIFIERS,
  ORIGINAL_6_FALSIFIERS,
  TOOLBOX_FALSIFIERS,
  ORTHOGONAL_AXES,
  createFalsifiers,
  analyzeSamples,
  compareReports,
  formatForLLM,
  auditFalsifiersAgainstShelf,
  formatShelfAuditForLLM,
  loadEarPrecedents,
  applyEarPrecedents,
  renderTextVision,
  renderSegmentTimeline,
  renderTimelineDiff,
  renderSvgVision,
  renderPngVision,
  buildCorpus,
  runDiscoveryLoop,
} from "./unkawaii_detector.mjs";

// 既定は policy: "core_veto"（必要に応じ "shelf_veto" / "veto_all" や precedents を指定）
const precedents = loadEarPrecedents("./bench/real_audio_audit/ear_precedents.json");
const report = analyzeSamples(float32Samples, 24000, { label: "take_01", precedents });
console.log(formatForLLM(report));

const profile = extractAudioProfile(float32Samples, 24000);
console.log(renderTextVision(profile, report, { mode: "compact", zoom: "auto" }));
console.log(renderSegmentTimeline(extractSegmentTimeline(profile, float32Samples, 24000)));

// 最も粗い0.5s窓だけを局所緩和した最小反事実オーディオを生成（または mode: "breath_tail"）
const cf = generateCounterfactualSlice(float32Samples, 24000);
console.log(cf.timelineDiff);

// 2トラックの掛け合い・被り・間を可視化
const dlg = analyzeDialogue(samplesA, 24000, samplesB, 24000);
console.log(renderDialogueMap(dlg));
```

### 新しい「かわいくなさ」軸を1本足す

```js
const customFalsifiers = [
  ...DEFAULT_FALSIFIERS,
  {
    id: "F33_CUSTOM_UNKAWAII",
    domain: "custom",
    name: "My Newly Discovered Unkawaii Dimension",
    detect(f) {
      const triggered = f.meanHfRatio > 0.65;
      return {
        triggered,
        score: f.meanHfRatio,
        threshold: 0.65,
        evidence: `hfRatio=${f.meanHfRatio}`,
        hint: "Adjust spectral tilt.",
      };
    },
  },
];
```

閾値だけを安全に上書きしたい場合は `createFalsifiers({ F8_DC_OFFSET_BIAS: 0.05 })` を使えます（`DEFAULT_FALSIFIERS` は変更されません）。

---

## テスト & ベンチマーク

```bash
npm test          # 単体・統合テスト (test/*.test.mjs)
npm run test:e2e  # 独立 E2E テストスイート (e2e/*.test.mjs)
npm run bench     # 検出マトリクス & レイテンシベンチマーク
npm run discover  # 反例発見ループ
```

## 同梱構成

- `unkawaii_detector.mjs` — 後方互換ファサード＆CLI
- `src/wav.mjs`, `src/dsp.mjs`, `src/features.mjs` — ゼロ依存 WAV I/O・Radix-2 FFT/STFT・音響特徴量・呼吸/間プロファイル・Voice Compass・過剰整えレンズ・`AudioProfile`
- `src/dialogue.mjs` — 2トラック関係対話ミラー（ターン交代・被り衝突・共有沈黙）
- `src/counterfactual.mjs` — ホットスポット検出＆最小局所反事実オーディオ生成（`soften_mps` / `breath_tail`）
- `src/falsifiers/*.mjs`, `src/report.mjs`, `src/shelf.mjs` — 32次元反証軸レジストリ・ポリシー分離（`core_veto` / `shelf_veto` / `veto_all`）・Protected Shelf 監査
- `src/visualize/*.mjs` — 段階的テキスト可視化（60Hz MEL下限）・時間分割ミラー＆窓別差分・6パネル SVG・純 JS PNG エンコーダ＆可視化
- `src/synth.mjs`, `src/discovery.mjs` — 決定論的合成コーパス＆反例発見ループ
- `bench/` — ベンチマーク・3択ブラインド鏡審査デモ（[`mirror_audit_demo.html`](bench/mirror_audit_demo.html)）・実音監査（[`real_audio_audit/RESULTS.md`](bench/real_audio_audit/RESULTS.md)）
- `docs/PHILOSOPHY.md`, `AGENTS.md` — 思想ブリーフ＆番人ガイド
