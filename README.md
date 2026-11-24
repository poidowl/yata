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

---

## 使い方（CLI）

Node.js v18+ があれば外部パッケージなしでそのまま動きます。

```bash
# 1. 基本解析（トークン節約型の発火優先サマリー / JSON）
node unkawaii_detector.mjs sample.wav
node unkawaii_detector.mjs sample.wav --format json
node unkawaii_detector.mjs sample.wav --falsifiers core   # v0.1 の6軸のみで検証

# 2. LLM 音声可視化（高密度テキスト / 異常区間ズーム / SVG / PNG）
node unkawaii_detector.mjs sample.wav --view compact --charset unicode
node unkawaii_detector.mjs sample.wav --view micro
node unkawaii_detector.mjs sample.wav --view compact --zoom auto
node unkawaii_detector.mjs sample.wav --view compact --zoom 0.1..0.4
node unkawaii_detector.mjs sample.wav --svg vision.svg --png vision.png

# 3. 2音の比較 & A/B ビジュアル差分（例: 鳴った vs ナッタ）
node unkawaii_detector.mjs --compare a.wav b.wav
node unkawaii_detector.mjs --compare a.wav b.wav --view compact --svg cmp.svg --png cmp.png
node unkawaii_detector.mjs --diff a.wav b.wav --charset unicode --svg diff.svg --png diff.png

# 4. 反例発見ループ（合成コーパスで v0.1 6軸 vs v0.2 32軸を比較）
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
  DEFAULT_FALSIFIERS,
  ORIGINAL_6_FALSIFIERS,
  createFalsifiers,
  analyzeSamples,
  compareReports,
  formatForLLM,
  renderTextVision,
  renderSvgVision,
  renderPngVision,
  buildCorpus,
  runDiscoveryLoop,
} from "./unkawaii_detector.mjs";

const report = analyzeSamples(float32Samples, 24000, { label: "take_01" });
console.log(formatForLLM(report));

const profile = extractAudioProfile(float32Samples, 24000);
console.log(renderTextVision(profile, report, { mode: "compact", zoom: "auto" }));
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
- `src/wav.mjs`, `src/dsp.mjs`, `src/features.mjs` — ゼロ依存 WAV I/O・Radix-2 FFT/STFT・音響特徴量・`AudioProfile`
- `src/falsifiers/*.mjs`, `src/report.mjs` — 32次元反証軸レジストリ・ID安全な比較・トークン節約型レポート
- `src/visualize/*.mjs` — 段階的テキスト可視化・6パネル SVG・純 JS PNG エンコーダ＆可視化
- `src/synth.mjs`, `src/discovery.mjs` — 決定論的合成コーパス＆反例発見ループ
- `bench/` — ベンチマーク＆A/B試聴デモページ
- `docs/PHILOSOPHY.md`, `AGENTS.md` — 思想ブリーフ＆番人ガイド
