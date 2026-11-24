# yata

> **音声から「かわいくなさ」を多次元的に発見する。それに失敗したら「かわいい」。**

**yata**（八咫鏡 — 音という鏡）は、音声から「かわいくなさ（＝聴き手の身体が『一緒にいたくない』と感じる兆候）」を多次元的に検出する、ゼロ依存・純 JavaScript の LLM フレンドリーな検証モジュールです。

## 思想（第0公理）

1. **「かわいい」は全部は書けない。でも「かわいくない」は書ける。**
2. 音は「鏡」であり、その向こうに威圧・トゲ・計算・空洞・破綻といった「一緒にいたくないなにか」が映ったとき、ヒトはかわいくないと感じる。
3. 多次元の「かわいくなさ検出器（Falsifiers）」をすべてすり抜けて反証に失敗した音だけを、`SURVIVED_KAWAII_CANDIDATE` として残す。
4. すり抜けた反例が見つかったら、`DEFAULT_FALSIFIERS` に新しい検出次元を 1 本追加する。

## 使い方（CLI）

Node.js (v18+) があれば依存パッケージなしでそのまま動きます。

```bash
# LLMがそのまま読んで推論できるコンパクトレポートを出力
node unkawaii_detector.mjs sample.wav

# 構造化 JSON で出力
node unkawaii_detector.mjs sample.wav --format json

# 2つの音声の「かわいくなさ差分」を比較（例：人の声 vs 合成音 / 鳴った vs ナッタ）
node unkawaii_detector.mjs --compare a.wav b.wav
```

## プログラムから使う（ES Module）

```js
import { analyzeSamples, formatForLLM, DEFAULT_FALSIFIERS } from "./unkawaii_detector.mjs";

const report = analyzeSamples(float32Samples, 44100, { label: "take_01" });
console.log(formatForLLM(report));
```

### 新しい「かわいくなさ」次元を追加する

```js
const myFalsifiers = [
  ...DEFAULT_FALSIFIERS,
  {
    id: "F7_CUSTOM_UNKAWAII",
    domain: "custom",
    name: "My Newly Discovered Unkawaii Dimension",
    detect(f) {
      const triggered = f.meanHfRatio > 0.65;
      return {
        triggered,
        score: f.meanHfRatio,
        threshold: 0.65,
        evidence: `hfRatio=${f.meanHfRatio}`,
        hint: "Adjust spectral tilt."
      };
    }
  }
];
```

## 同梱ファイル

- `unkawaii_detector.mjs` — ゼロ依存 WAV パーサー・6次元「かわいくなさ」検出器・LLM フォーマッタ・CLI
- `bench/kawaii_static_verifier.html` — 「鳴る・ナル・鳴った・ナッタ」の静的三面図＆簡易シンセ実験ベンチ
- `package.json` / `LICENSE` (MIT)
