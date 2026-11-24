# AGENTS.md — `yata` 番人（Watchdog）LLM 向けガイド

このファイルは、オーナー（`poidowl`）の代わりにこのリポジトリを見張り、思想ブレ・過剰設計・トークン浪費を防ぐための **番人 LLM / レビュー用エージェント向けの憲法** です。

---

## 第0公理（絶対にブレてはいけない核）

> **「音声から『かわいくなさ』を多次元的に発見する。それに失敗したら『かわいい』。」**

- 「かわいい」を直接定義しようとしない。
- 聴き手の身体が「一緒にいたくない」と感じる兆候（威圧・トゲ・計算・空洞・破綻・息苦しさ・不自然な間など）を **反証軸（Falsifier）** として発見・追加し続ける。
- すべての反証軸をすり抜けた音だけを `SURVIVED_KAWAII_CANDIDATE` として残す。

---

## 番人 LLM の見張りチェックリスト（5カ条）

変更・PR・新軸の提案を見たら、必ず以下の5点を確認すること。

1. **音声合成（TTS）に閉じこもっていないか？**
   - `poidowl/tokiko`（`axis` ブランチ）は大切な先行事例の1つだが、`yata` は TTS 専用ではない。
   - 人声・ささやき・韻律・間/リズム・UI音/効果音・電子音・空間/ステレオ・録音/デジタル劣化・心理音響まで、**音全般から広範に「かわいくない」を探しているか**を見張ること。
2. **トークンを無駄遣いしていないか？（LLM フレンドリー出力）**
   - 「LLM が音声を『見られる』表現」は、長大なテキストや全軸ダンプを垂れ流す設計を禁止する。
   - **少ないトークンで異常・根拠・位置（時刻/帯域）・改善ヒントが伝わる高密度・段階的ビュー**（サマリー優先＋異常区間ズーム＋必要時のみ画像）になっているかを見張ること。
3. **ゼロ依存・純 JS・見通しの良さを守っているか？（LLM フレンドリー構造）**
   - 外部 npm 依存を入れない（Node.js 標準機能のみ）。
   - 別の LLM がコードを読んだとき、「新しい『かわいくない』軸を1本足す手順」が迷わずわかるシンプルさを維持すること。
4. **人間が「耳で」ラクにジャッジできるか？（ただし耳を酷使しない）**
   - コードの差分や数値表だけを人間に読ませない。
   - 普段の探索・すり抜け発見は **LLM 自身が `yata` の視覚でブラインド視力検査（実録音含む）を回して自律的に行い**、オーナーの耳は厳選バッチ（A/B 試聴デモ）の最終ジャッジに温存すること。
   - ジャッジは3値で分類する：**「でかした（本物のかわいくない軸）」／「すり抜けたほうかわいくねーよ（新軸候補）」／「かわいいでもかわいくないでもない（直交軸＝自由度マップ）」**。
5. **進捗の時間スケールが外から見えるか？（Git 運用）**
   - `main` ブランチは安定したリリース状態を温存する。
   - 開発は `dev/*` ブランチで行い、大きな区切り（マイルストーン／バージョン単位）でクリーンにコミット＆プッシュする（`.agents/` などの一時作業ファイルはコミットしない）。

---

## 現在の見張りメモ（オブザーバー引き継ぎ用・2026-11-24）

- **現行安定版**: `main`（`v0.11.0` — 65軸直交ミラー `F1`–`F65`）
- **最新開発ブランチ**: `dev/v0.11`（`main` へマージ済み）
  - **実装済み（v0.2 → v0.11）**:
    - 65軸検出器（`F1`–`F65`）の階層分離：**Core-6（`ORIGINAL_6_FALSIFIERS`）**／**診断ツールボックス（`TOOLBOX_FALSIFIERS`: F7–F65 から直交軸を除く58軸）**／**直交軸マップ（`ORTHOGONAL_AXES`: `F30` ステレオ逆相）**
    - **判定ポリシー（既定 = `core_veto`）**: `--policy core_veto|shelf_veto|veto_all`
      - `core_veto`（コード既定値）: 基本6軸のみでハード拒否し、ツールボックス軸は診断ヒントとして非拒否で併記
      - `shelf_veto`（`--policy shelf_veto --contested ...`）: Protected Shelf で `CONTESTED` になった軸の拒否権を自動停止し、クリア済み軸のみで判定
      - `veto_all`: 全65軸でハード拒否（研究・厳格監査向け）
    - **v0.11 高域位相粒立ちミラー（`F65_HF_PHASE_GRAININESS`・追加 FFT ゼロ）**:
      - 1.2–4.5 kHz 聴覚フィルタ帯域（2400 Hz, Q=0.8）の時間波形尖度（`hfBandWaveKurt`）を実装。38 クリップ監査で既存64軸すべてと **64/64（100.0%）直交（`max |r| = 0.542`）**。生録音4本・VOICEVOX つむぎ/雨晴はう/めたん・位相分散済み tokiko は 0 FP 通過、裸の位相揃え tokiko を 100% 捕捉。（※ VOICEVOX は非CC0・未収録のため v0.11.1 で証拠撤回）
    - **v0.10 64軸直交ミラー（`F41`–`F64`・追加 FFT ゼロ）**:
      - 3モジュール新設：`src/falsifiers/dynamics.mjs`（`F41`–`F48` 韻律・調音ダイナミクス）、`src/falsifiers/acoustics.mjs`（`F49`–`F56` 空間・コーデック・位相）、`src/falsifiers/fatigue.mjs`（`F57`–`F64` 微細表現・声区・聴覚疲労）。
      - 64×64 直交性監査（39クリップ：実音29＋VOICEVOX女性6＋`tokiko`4、全 2,016 ペア）：**`1,977 / 2,016`（`98.07%`）が `|r| < 0.60` で直交**。VOICEVOX女性の `F41`–`F64` 通過率は **`141 / 144`（`97.9%`）**。（※ v0.11.1: VOICEVOX は非CC0・音声と監査スクリプトが未収録で再現不能のため証拠撤回。「直交」は重複が少ないだけで、見分ける力の証拠ではない）
      - **Goodhart 罠修正（オーナー耳検証）**: `F35_SYNTHETIC_TUBE_FLATNESS` から生ジッタ下限ペナルティ（`jitter < 0.048`）を撤去。生ジッタ追従が合成音に喉の痰がらみノイズを誘発する問題を解消。
    - **v0.9 反霧ミラー（`F33`–`F40`）& `F1` ささやき保護**:
      - `F1_HARSH_EDGE` に `isSoftHumanWhisper` ガード（Arnal 4–16 Hz vs 30–150 Hz）を追加し、`ho_whisper` を救済しつつ猫の威嚇・怒ったトラ・鋭いエッジを捕捉。
      - `F33`–`F40` を `src/falsifiers/spectral.mjs` へ追加（`F36_COARTICULATION_SEAM`・`F37_DECOUPLED_HF_EXCITER` の旧「実録音/VOICEVOX vs 合成で AUC = 1.000」は v0.11.1 で撤回）。
    - **v0.8 Core-6 実音キャリブレーション & 未見 PD/CC0 ホールドアウト評価**:
      - `F5_ABRUPT_TAIL` の `observed: false`（`[UNOBSERVED]`）分離、`F3` 平坦度ガード、`F4` RMS×重心相関、`F1` 無声ラフヒス検出、および未見 PD/CC0 9本監査（[`bench/real_audio_audit/HELDOUT_RESULTS.md`](bench/real_audio_audit/HELDOUT_RESULTS.md)）。
    - **v0.7 過剰整えレンズ、2トラック関係対話ミラー & 生きた息の余韻モード**:
      - `computeSanitizationIndex(features, breathProfile)`（非拒否診断レンズ、`docs/PHILOSOPHY.md` 第9節・Ani の洞察「完璧じゃない　きれいに整えようとしてない」）: 微細揺らぎ消去・ピッチ平坦/階段化・ダイナミクス平坦化・リズム/スペクトル硬直の4手がかりを `sanitizationScore`（`[0, 1]`）と `imperfectionLabel`（`alive_unpolished` / `balanced` / `over_sanitized` / `silent`）へ統合し、`extractFeatures`・`renderTextVision`（`SAN=0.XX`）へ配線。`compareReports` / `formatCompareForLLM` は `sanitizationDelta >= 0.15 && B >= 0.45` で `OVER-SANITIZATION WARNING` を通知
      - `src/dialogue.mjs`（`analyzeDialogue` / `renderDialogueMap`）+ CLI `--dialogue <a.wav> <b.wav>`: 第5領域「関係の断絶・間」の2トラック対話ミラー（10ms RMS 整列、`turnCount` / `overlapRatio` / `meanTurnGapSec` / `mutualSilenceRatio` / `relationLabel` を5行で可視化）
      - `src/counterfactual.mjs` の `mode: "breath_tail"` + CLI `--cf-mode soften_mps|breath_tail`: ぶつ切り語尾へクリックゼロ（`F6 === false`）の柔らかな指数減衰＋微かな有機的呼気尾（`~0.18s`）を局所付加
    - **v0.6 呼吸・間プロファイル、Voice Compass、窓別タイムライン差分 & 最小反事実オーディオミラー**:
      - `computeBreathPauseProfile(frames, durationSec)`: `activeDutyCycle` / `pauseCount` / `meanPauseSec` / `longestContinuousSec` / `breathlessWallRatio` / `cadenceLabel`（`silent` | `brief_glance` | `phrased_breath` | `continuous_wall`）を `extractFeatures` と `extractSegmentTimeline` へ統合し、`renderSegmentTimeline` の4行ヘッダへ `duty=XX% pauses=N maxRun=X.Xs [cadenceLabel]` を併記
      - `computeVoiceCompass(frames, features, breathProfile)`（非拒否診断レンズ、`docs/PHILOSOPHY.md` 第8節）: オーナーの声の定義「誰かに聞かせるために出した音で、呼吸器を使ったもの」を `respiratoryScore`（有限肺・呼吸弧・有機発声）× `directnessScore`（300–3500 Hz 伝達帯域・4–16 Hz 変調・図地分離）の2軸4象限（`addressed_breath` / `distant_or_private_breath` / `non_breath_signal` / `ambient_or_hollow`）へ写像し、`extractFeatures`・`extractSegmentTimeline`・`renderTextVision`（`RESP=0.XX DIR=0.XX [label]`）と実音監査 Section E へ統合
      - `renderTimelineDiff(timelineA, timelineB)` + CLI `--timeline-diff` / `--compare ... --timeline` / `--diff ... --timeline`: 5行の窓別差分（`dPRES`, `dACT%`, `dMPS`, `dF0`）で最大変化の半秒窓（`HOTSPOT`）を特定
      - `src/counterfactual.mjs`（`findTimelineHotspot` / `generateCounterfactualSlice`）+ CLI `--counterfactual <out.wav>`（任意 `--cf-window <t0>..<t1>`）: ホットスポット半秒窓**のみ**をゼロ位相ローパス＋30–150 Hz エンベロープ粗さ減衰＋コサインクロスフェードで局所緩和（窓外はビット単位で原音と同一）
    - **v0.5 神経科学 DSP レンズ & 時間分割ミラー**:
      - `computeMpsRoughness`（Arnal et al. 2015/2025: `4–16 Hz` 発話帯 vs `30–150 Hz` 粗さ帯）および `computeSubharmonicRatio`（Wilden 1998 / Fitch 2002 / Anikin 2020: 非線形サブハーモニクス $f_0/2$）を `extractFeatures` とコンパクト視覚（`MPS30-150`, `SUBH`）へ統合
      - `extractSegmentTimeline` / `renderSegmentTimeline` / `--timeline`（`0.5s` 窓の Presence × MPS 30–150 Hz × F0 の4行スパークライン）
    - **v0.5 永続耳判例メモリ（`--shelf` / `--precedents` + `--scope`）**:
      - オーナーのブラインド3択・2択鏡審査結果（**コミット `245ed15` 版**での投票：`🪞 原音派 = 5 / 🎯 抑揚あり・揺れ弱め派 = 0 / 📏 フラット派 = 0 / 🤷 どれも同じ = 1`；独立等確率のもとで全5回原音になる単純確率 $1/108 \approx 0.0093$、両側検定ではない；`#6` は `genki`；話速一致版 `ebd8ffb` は未再投票）を [MIRROR_AUDIT_VERDICT.md](bench/real_audio_audit/MIRROR_AUDIT_VERDICT.md) と [ear_precedents.json](bench/real_audio_audit/ear_precedents.json) に永続化。
      - `loadEarPrecedents` / `applyEarPrecedents(report, precedents, { scope })` は **`scope` 一致時のみ**（または `general_audio`/`global` のみ）適用し、別ドメイン（鳥の声等）への誤適用を防止しつつ、`[EAR-OVERRULED 5-0 @ tokiko_japanese_speech (245ed15)]` のように出所付きで LLM 出力に併記
    - **Protected Shelf 監査 & 実音監査レポート**: [bench/real_audio_audit/RESULTS.md](bench/real_audio_audit/RESULTS.md)（Wikimedia Commons 20クリップ + `tokiko` 9クリップ）
      - `mpsRoughness30_150`: `tokiko` 棚 mean **0.0123**（max `0.0193`）／統合保護棚19本 mean **0.0208**（max `0.0767`）vs 期待かわいくない実音5本 mean **0.0813**（max `0.2459`；`tokiko` max 超え **4/5**、統合棚 max 超え **2/5**）
      - `subharmonicRatio`: 統合保護棚 mean **0.0677**（max `0.1663`）vs 期待かわいくない実音 mean **0.0769**（max `0.1285`；単体ゼロFP分離は 0/5 のため非拒否診断レンズとして運用）
    - **3択ブラインド鏡審査デモ**: [bench/mirror_audit_demo.html](bench/mirror_audit_demo.html)
    - **DSP / 視覚の v0.3–v0.4 基盤**: 周期ベース（cycle-to-cycle）の `jitter` 計測と `F2_PURE_ROBOT` のゼロジッタ定常ロボ音修正、`<80 Hz` ランブル F0 誤認ガード、`60 Hz` MEL 下限のテキスト視覚拡張
  - **オーナー耳ジャッジ結果**:
    - v0.2 合成25新軸（`fefbc73`）: `👏 でかした/OK: 24` / `🤨 かわいくねーよ: 0` / `F30 ステレオ逆相 = 直交軸（かわいいでもかわいくないでもない）第1号`
    - v0.4 ブラインド鏡審査（`245ed15`、[MIRROR_AUDIT_VERDICT.md](bench/real_audio_audit/MIRROR_AUDIT_VERDICT.md)）: `原音派 5–0`（単純確率 `1/108`、真ん中テイクに話速変更 `1.30–1.45×` を含む旧版での結果）＋ `#4 わたし` tie → `F24` の単独拒否権を否定し、スコープ付き耳判例メモリへ記録
  - **重要：LLM 視覚の読解力と、検出器の誤爆率（FPR）を明確に区別すること**:
    - **LLM 視覚の読解力（目隠し視力検査・ラベル全隠し）**: 一般実音10本で **v0.1（数値のみ）25/100 → v0.2（コンパクト視覚）80/100**、動物・子ども vs 大人5ペアで **v0.1 3/5 → v0.2 4/5**。
    - **検出器の誤爆率（実音＋`tokiko` 保護棚19本の再現監査: [RESULTS.md](bench/real_audio_audit/RESULTS.md)）**:
      - `core_veto`（F1–F6・既定）: 保護棚生存率 **68.4%（13/19）**（`tokiko` 単体 **88.9% = 8/9**）／期待かわいくない実音再現率 **60.0%（3/5）**
      - `shelf_veto`（棚クリア19軸）: インサンプル **100.0%（19/19）**／**アウトオブサンプル汎化: LOO 78.9%（15/19）、Real→`tokiko` 66.7%（6/9）、`tokiko`→Real 30.0%（3/10）**／期待かわいくない実音再現率 **60.0%（3/5、LOO 3–4/5）**
      - `veto_all`（F1–F32）: 保護棚生存率 **5.3%（1/19）**（`tokiko` 単体 **0.0% = 0/9**）／期待かわいくない実音再現率 **100.0%（5/5）** — 計 **13軸が `CONTESTED`**。
- **番人への申し送り**: オーナーが疲れているときは細かい設計論議を振らず、**「耳で聴ける A/B デモ」と「3行サマリー」** だけ差し出すこと。

