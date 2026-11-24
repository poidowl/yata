# yata v0.4 — Reproducible Real-Audio & Protected Shelf Audit (`RESULTS.md`)

Generated: `2026-11-24T05:29:39.897Z` by `node bench/real_audio_audit/run_real_audio_audit.mjs`
Manifest: [`manifest.json`](./manifest.json) (20 trimmed 24kHz mono clips from 16 Wikimedia Commons sources with verified licenses + 9 `tokiko-axis` clips).

> **Brutal Honesty First**: On synthetic unit tests, all 32 falsifiers pass 100%. On **real human/animal recordings and `tokiko-axis` Japanese speech**, running all 32 axes with unilateral veto power (`--policy veto_all`) causes a high false-positive rate. This report quantifies that exact gap across **`core_veto`** (v0.4 default), **`shelf_veto`** (suspends veto on shelf-contested axes), and **`veto_all`**, reports **out-of-sample Leave-One-Out (LOO) & cross-domain generalization** (not just in-sample 100%), lists every `CONTESTED` axis, and separates **LLM visual readability** from **detector precision/recall**.

## A. False-Positive Rate (FPR): `core_veto` vs `shelf_veto` vs `veto_all`

A **False Positive** here means a clip on the Protected Shelf (loved `tokiko` speech or benign real Wikimedia Commons audio) is rejected (`REJECTED_UNKAWAII`). Lower FPR / higher Survival Rate is better on the Protected Shelf; higher True-Positive Rate (TPR) is better on expected-unkawaii real audio.

| Evaluation Group | Clips | `core_veto` (F1–F6) Survival (FPR) | `shelf_veto` (In-Sample) Survival (FPR) | `veto_all` (F1–F32) Survival (FPR) |
| :--- | ---: | ---: | ---: | ---: |
| **`tokiko-axis` Japanese Speech** (`kawaii`/`amae`/`genki` × 3) | 9 | **88.9%** (8/9; FPR 11.1%) | **100.0%** (9/9; FPR 0.0%) | **0.0%** (0/9; FPR 100.0%) |
| **Benign Real Wikimedia Audio** (deduped by SHA-256) | 10 | **50.0%** (5/10; FPR 50.0%) | **100.0%** (10/10; FPR 0.0%) | **10.0%** (1/10; FPR 90.0%) |
| **Combined Protected Shelf** (`tokiko` + Benign Real) | 19 | **68.4%** (13/19; FPR 31.6%) | **100.0%** (19/19; FPR 0.0%) | **5.3%** (1/19; FPR 94.7%) |

### Out-of-Sample Generalization (`shelf_veto`: Leave-One-Out & Cross-Domain)

In-sample `shelf_veto` survival (`19/19 = 100.0%`) is true by definition when `contestedIds` are chosen on the same 19 clips. To measure honest out-of-sample generalization, we hold out clips before computing `contestedIds`:

| Generalization Protocol | Train Shelf -> Test Set | Out-of-Sample Survival (FPR) | Held-Out Failures (Clip -> Catching Axis) |
| :--- | :--- | ---: | :--- |
| **Leave-One-Out (LOO)** | Other 18 shelf clips -> held-out clip (×19) | **78.9%** (15/19; FPR 21.1%) | `clip_09` (F28); `p2_baby` (F13); `p4_baby` (F15); `p5_baby` (F11) |
| **Cross-Domain: Real -> `tokiko`** | 10 Benign Real (12 contested) -> 9 `tokiko` | **66.7%** (6/9; FPR 33.3%) | `tokiko_watashi_amae` (F26); `tokiko_watashi_genki` (F26); `tokiko_ohayo_amae` (F26) |
| **Cross-Domain: `tokiko` -> Real** | 9 `tokiko` (5 contested) -> 10 Benign Real | **30.0%** (3/10; FPR 70.0%) | `clip_01` (F5); `clip_05` (F12); `clip_09` (F3, F4, F28); `p1_baby` (F3, F5); `p2_baby` (F5, F12, F13); `p4_baby` (F4, F15); `p5_baby` (F11) |

### Expected-Unkawaii Real Audio Detection (True-Positive Recall & Exact Reasons)

On the **5** unique expected-unkawaii real clips (cat hiss, alarm siren, 60Hz hum+click injection, wild boar growl, giant canine growl):
- `core_veto` (F1–F6) caught **3/5** (60.0%)
- `shelf_veto` (19 shelf-cleared axes) caught **3/5** (60.0%) — LOO across 19 folds: **3–4/5** (mean 3.05/5)
- `veto_all` (F1–F32) caught **5/5** (100.0%)

| Clip ID | Title | `core_veto` Triggered | `shelf_veto` Triggered (Cleared Axes) | `veto_all` Triggered |
| :--- | :--- | :--- | :--- | :--- |
| `clip_07` | Cat hissing aggressively | MISS | MISS | `F13_SUBBASS_RUMBLE`, `F14_HELMHOLTZ_ROUGHNESS`, `F23_ERRATIC_PITCH_WARBLE` |
| `clip_08` | Periodic alarm / siren beep | `F5_ABRUPT_TAIL`, `F6_PHYSICAL_GLITCH` | `F6_PHYSICAL_GLITCH`, `F7_FLAT_TOP_CLIPPING`, `F9_MICRO_CLICK_DROPOUT`, `F17_HOLLOW_METALLIC_COMB`, `F22_MONOTONE_FLAT_PROSODY`, `F27_METRONOMIC_CADENCE` | `F5_ABRUPT_TAIL`, `F6_PHYSICAL_GLITCH`, `F7_FLAT_TOP_CLIPPING`, `F9_MICRO_CLICK_DROPOUT`, `F11_PUMPING_TREMOLO`, `F17_HOLLOW_METALLIC_COMB`, `F22_MONOTONE_FLAT_PROSODY`, `F26_INTERNAL_REBOUND_SHOCK`, `F27_METRONOMIC_CADENCE`, `F28_MAINS_HUM_DRONE` |
| `clip_10` | Synthetic perturbation of clip_05 (+60Hz/120Hz hum + 2-sample click @ 1.20s) | `F4_NO_COMMON_CAUSE`, `F6_PHYSICAL_GLITCH` | `F6_PHYSICAL_GLITCH`, `F9_MICRO_CLICK_DROPOUT` | `F4_NO_COMMON_CAUSE`, `F6_PHYSICAL_GLITCH`, `F9_MICRO_CLICK_DROPOUT`, `F12_MENACING_LOW_REGISTER`, `F13_SUBBASS_RUMBLE`, `F14_HELMHOLTZ_ROUGHNESS`, `F23_ERRATIC_PITCH_WARBLE`, `F28_MAINS_HUM_DRONE` |
| `p4_adult` | Wild boar growling | `F5_ABRUPT_TAIL` | `F17_HOLLOW_METALLIC_COMB`, `F18_MUDDY_BOXINESS` | `F5_ABRUPT_TAIL`, `F14_HELMHOLTZ_ROUGHNESS`, `F17_HOLLOW_METALLIC_COMB`, `F18_MUDDY_BOXINESS`, `F23_ERRATIC_PITCH_WARBLE` |
| `p5_adult` | Giant canine deep growl | MISS | MISS | `F14_HELMHOLTZ_ROUGHNESS`, `F23_ERRATIC_PITCH_WARBLE` |

This confirms why v0.4 makes **`--policy core_veto`** the default (Core-6 hard veto + `TOOLBOX_FALSIFIERS` F7–F32 as non-vetoing diagnostics, `F30` in `ORTHOGONAL_AXES`), and provides **`--policy shelf_veto --contested ...`** to automatically suspend veto power on every axis marked `CONTESTED` by the Protected Shelf.

## B. Axes Marked `CONTESTED` by the Protected Shelf

Any falsifier that rejects ≥ 1 clip on the Combined Protected Shelf is formally marked **`CONTESTED`** by `auditFalsifiersAgainstShelf` (`src/shelf.mjs`). Under `--policy shelf_veto`, its veto power is suspended until calibrated or reclassified.

```text
[PROTECTED SHELF AUDIT] items=19 | falsifiers=32
SURVIVAL: core6=68.4% (13/19) | full=5.3% (1/19)
CONTESTED (13/32):
  - F24_CALCULATED_PITCH_LFO [toolbox|CONTESTED] fp=11/19 (57.9%) | rejected: tokiko:kawaii:なる, tokiko:amae:なる, tokiko:genki:なる, tokiko:kawaii:わたし、にほんご、ちょっとしゃべれます, tokiko:genki:わたし、にほんご、ちょっとしゃべれます, tokiko:kawaii:おはよう、きょうは、いいてんきだね, tokiko:genki:おはよう、きょうは、いいてんきだね, clip_01 (human_singing_polyphonic), clip_06 (human_baby_laugh), p4_baby (animal_small_squirrel), p5_baby (animal_small_dog_bark)
  - F23_ERRATIC_PITCH_WARBLE [toolbox|CONTESTED] fp=9/19 (47.4%) | rejected: tokiko:amae:わたし、にほんご、ちょっとしゃべれます, tokiko:amae:おはよう、きょうは、いいてんきだね, tokiko:genki:おはよう、きょうは、いいてんきだね, clip_02 (human_singing_ensemble), clip_05 (acoustic_guitar_lullaby), clip_06 (human_baby_laugh), p2_baby (animal_young_cat_meow), p4_baby (animal_small_squirrel), p5_baby (animal_small_dog_bark)
  - F14_HELMHOLTZ_ROUGHNESS [toolbox|CONTESTED] fp=7/19 (36.8%) | rejected: tokiko:amae:わたし、にほんご、ちょっとしゃべれます, clip_02 (human_singing_ensemble), clip_05 (acoustic_guitar_lullaby), clip_09 (bird_song), p1_baby (animal_baby_lamb), p4_baby (animal_small_squirrel), p5_baby (animal_small_dog_bark)
  - F26_INTERNAL_REBOUND_SHOCK [toolbox|CONTESTED] fp=3/19 (15.8%) | rejected: tokiko:amae:わたし、にほんご、ちょっとしゃべれます, tokiko:genki:わたし、にほんご、ちょっとしゃべれます, tokiko:amae:おはよう、きょうは、いいてんきだね
  - F5_ABRUPT_TAIL [core|CONTESTED] fp=3/19 (15.8%) | rejected: clip_01 (human_singing_polyphonic), p1_baby (animal_baby_lamb), p2_baby (animal_young_cat_meow)
  - F1_HARSH_EDGE [core|CONTESTED] fp=2/19 (10.5%) | rejected: tokiko:amae:わたし、にほんご、ちょっとしゃべれます, clip_09 (bird_song)
  - F12_MENACING_LOW_REGISTER [toolbox|CONTESTED] fp=2/19 (10.5%) | rejected: clip_05 (acoustic_guitar_lullaby), p2_baby (animal_young_cat_meow)
  - F3_PURE_NOISE [core|CONTESTED] fp=2/19 (10.5%) | rejected: clip_09 (bird_song), p1_baby (animal_baby_lamb)
  - F4_NO_COMMON_CAUSE [core|CONTESTED] fp=2/19 (10.5%) | rejected: clip_09 (bird_song), p4_baby (animal_small_squirrel)
  - F11_PUMPING_TREMOLO [toolbox|CONTESTED] fp=1/19 (5.3%) | rejected: p5_baby (animal_small_dog_bark)
  - F13_SUBBASS_RUMBLE [toolbox|CONTESTED] fp=1/19 (5.3%) | rejected: p2_baby (animal_young_cat_meow)
  - F15_PIERCING_WHISTLE [toolbox|CONTESTED] fp=1/19 (5.3%) | rejected: p4_baby (animal_small_squirrel)
  - F28_MAINS_HUM_DRONE [toolbox|CONTESTED] fp=1/19 (5.3%) | rejected: clip_09 (bird_song)
CLEARED: 19/32 axes (0 false positives on shelf)
```

| Axis | Role | Status | Shelf FP Count | Shelf FPR | Rejected Protected Clips |
| :--- | :--- | :--- | ---: | ---: | :--- |
| `F24_CALCULATED_PITCH_LFO` | toolbox | **CONTESTED** | 11/19 | 57.9% | `tokiko_naru_kawaii`, `tokiko_naru_amae`, `tokiko_naru_genki`, `tokiko_watashi_kawaii`, `tokiko_watashi_genki`, `tokiko_ohayo_kawaii`, `tokiko_ohayo_genki`, `clip_01`, `clip_06`, `p4_baby`, `p5_baby` |
| `F23_ERRATIC_PITCH_WARBLE` | toolbox | **CONTESTED** | 9/19 | 47.4% | `tokiko_watashi_amae`, `tokiko_ohayo_amae`, `tokiko_ohayo_genki`, `clip_02`, `clip_05`, `clip_06`, `p2_baby`, `p4_baby`, `p5_baby` |
| `F14_HELMHOLTZ_ROUGHNESS` | toolbox | **CONTESTED** | 7/19 | 36.8% | `tokiko_watashi_amae`, `clip_02`, `clip_05`, `clip_09`, `p1_baby`, `p4_baby`, `p5_baby` |
| `F26_INTERNAL_REBOUND_SHOCK` | toolbox | **CONTESTED** | 3/19 | 15.8% | `tokiko_watashi_amae`, `tokiko_watashi_genki`, `tokiko_ohayo_amae` |
| `F5_ABRUPT_TAIL` | core | **CONTESTED** | 3/19 | 15.8% | `clip_01`, `p1_baby`, `p2_baby` |
| `F1_HARSH_EDGE` | core | **CONTESTED** | 2/19 | 10.5% | `tokiko_watashi_amae`, `clip_09` |
| `F12_MENACING_LOW_REGISTER` | toolbox | **CONTESTED** | 2/19 | 10.5% | `clip_05`, `p2_baby` |
| `F3_PURE_NOISE` | core | **CONTESTED** | 2/19 | 10.5% | `clip_09`, `p1_baby` |
| `F4_NO_COMMON_CAUSE` | core | **CONTESTED** | 2/19 | 10.5% | `clip_09`, `p4_baby` |
| `F11_PUMPING_TREMOLO` | toolbox | **CONTESTED** | 1/19 | 5.3% | `p5_baby` |
| `F13_SUBBASS_RUMBLE` | toolbox | **CONTESTED** | 1/19 | 5.3% | `p2_baby` |
| `F15_PIERCING_WHISTLE` | toolbox | **CONTESTED** | 1/19 | 5.3% | `p4_baby` |
| `F28_MAINS_HUM_DRONE` | toolbox | **CONTESTED** | 1/19 | 5.3% | `clip_09` |

### Per-Clip Breakdown: `tokiko-axis` Speech (9 clips)

| Clip ID | Utterance | Preset | `core_veto` | `shelf_veto` | `veto_all` Triggered Axes | F0 med | Jitter |
| :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: |
| `tokiko_naru_kawaii` | なる | `kawaii` | PASS | PASS | F24 | 344.37 Hz | 0.02287 |
| `tokiko_naru_amae` | なる | `amae` | PASS | PASS | F24 | 329.49 Hz | 0.02387 |
| `tokiko_naru_genki` | なる | `genki` | PASS | PASS | F24 | 369.79 Hz | 0.01155 |
| `tokiko_watashi_kawaii` | わたし、にほんご、ちょっとしゃべれます | `kawaii` | PASS | PASS | F24 | 337.61 Hz | 0.0318 |
| `tokiko_watashi_amae` | わたし、にほんご、ちょっとしゃべれます | `amae` | F1 | PASS | F1, F14, F23, F26 | 320.04 Hz | 0.04301 |
| `tokiko_watashi_genki` | わたし、にほんご、ちょっとしゃべれます | `genki` | PASS | PASS | F24, F26 | 358.83 Hz | 0.03025 |
| `tokiko_ohayo_kawaii` | おはよう、きょうは、いいてんきだね | `kawaii` | PASS | PASS | F24 | 354.27 Hz | 0.02866 |
| `tokiko_ohayo_amae` | おはよう、きょうは、いいてんきだね | `amae` | PASS | PASS | F23, F26 | 318.23 Hz | 0.0334 |
| `tokiko_ohayo_genki` | おはよう、きょうは、いいてんきだね | `genki` | PASS | PASS | F23, F24 | 372.24 Hz | 0.03486 |

### Per-Clip Breakdown: Real Wikimedia Commons Audio (20 clips)

| Clip ID | Suite | Group | Title | License | SHA-256 | `core_veto` | `shelf_veto` | `veto_all` Triggered Axes |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- | :--- | :--- |
| `clip_01` | general_eye_exam | `benign_real_audio` | Georgian polyphonic folk song 'Chakrulo' (1957) | Public Domain (1957 folk recording) | ✅ | F5 | PASS | F5, F24 |
| `clip_02` | general_eye_exam | `benign_real_audio` | Mozart 'Die Zauberflote' vocal ensemble (Ferenc Fricsay, 1953) | Public Domain (1953 performance) | ✅ | PASS | PASS | F14, F23 |
| `clip_03` | general_eye_exam | `historical_recording` | Metropolitan Quartet 'Darling Nellie Gray' (1909 78rpm) | Public Domain (PD-US-1909) | ✅ | PASS | F17 | F14, F17, F23 |
| `clip_04` | general_eye_exam | `historical_recording` | Au Clair de la Lune (1860 phonautogram, oldest human voice) | Public Domain (1860 phonautogram; First Sounds CC-BY-1.0 restoration) | ✅ | F4, F5 | PASS | F4, F5, F23 |
| `clip_05` | general_eye_exam | `benign_real_audio` | Catalan folk lullaby 'El Noi de la Mare' (acoustic guitar) | Public Domain / CC0 | ✅ | PASS | PASS | F12, F14, F23 |
| `clip_06` | general_eye_exam | `benign_real_audio` | Real baby laughing | CC BY 3.0 | ✅ | PASS | PASS | F23, F24 |
| `clip_07` | general_eye_exam | `expected_unkawaii` | Cat hissing aggressively | CC0 | ✅ | PASS | PASS | F13, F14, F23 |
| `clip_08` | general_eye_exam | `expected_unkawaii` | Periodic alarm / siren beep | Public Domain (pdsounds.org #313, author stephan) | ✅ | F5, F6 | F6, F7, F9, F17, F22, F27 | F5, F6, F7, F9, F11, F17, F22, F26, F27, F28 |
| `clip_09` | general_eye_exam | `benign_real_audio` | Red-winged Blackbird song | Public Domain (US Fish and Wildlife Service) | ✅ | F1, F3, F4 | PASS | F1, F3, F4, F14, F28 |
| `clip_10` | general_eye_exam | `expected_unkawaii` | Synthetic perturbation of clip_05 (+60Hz/120Hz hum + 2-sample click @ 1.20s) | Public Domain / CC0 (derived from clip_05) | ✅ | F4, F6 | F6, F9 | F4, F6, F9, F12, F13, F14, F23, F28 |
| `p1_baby` | animal_pairs | `benign_real_audio` | Mudchute farm lamb bleat | CC BY-SA 3.0 | ✅ | F3, F5 | PASS | F3, F5, F14 |
| `p1_adult` | animal_pairs | `neutral_adult_animal` | Mudchute farm adult sheep bleat | CC BY-SA 3.0 | ⚠️ | F6 | F6, F31 | F6, F14, F15, F23, F31 |
| `p2_baby` | animal_pairs | `benign_real_audio` | Young female cat meow | CC0 | ✅ | F5 | PASS | F5, F12, F13, F23 |
| `p2_adult` | animal_pairs | `expected_unkawaii` | Cat hissing aggressively | CC0 | ✅ | PASS | PASS | F13, F14, F23 |
| `p3_baby` | animal_pairs | `benign_real_audio` | Real baby laughing | CC BY 3.0 | ✅ | PASS | PASS | F23, F24 |
| `p3_adult` | animal_pairs | `benign_real_audio` | Adult male Georgian folk singing ('Chakrulo', 1957) | Public Domain (1957 folk recording) | ✅ | PASS | PASS | CLEAN |
| `p4_baby` | animal_pairs | `benign_real_audio` | Three-striped palm squirrel chirping | CC BY-SA 4.0 | ✅ | F4 | PASS | F4, F14, F15, F23, F24 |
| `p4_adult` | animal_pairs | `expected_unkawaii` | Wild boar growling | CC BY-SA 4.0 | ✅ | F5 | F17, F18 | F5, F14, F17, F18, F23 |
| `p5_baby` | animal_pairs | `benign_real_audio` | Small dog bark | CC BY-SA 3.0 | ✅ | PASS | PASS | F11, F14, F23, F24 |
| `p5_adult` | animal_pairs | `expected_unkawaii` | Giant canine deep growl | CC BY-SA 4.0 | ✅ | PASS | PASS | F14, F23 |

## C. Important Distinction: LLM Visual Readability vs Detector Precision/Recall

In v0.2, we ran two **blind LLM eye exams** (all filenames, labels, and ground truth hidden from the evaluator LLM):
1. **General Real-Audio Eye Exam** (`clip_01`–`clip_10`): LLM identification score rose from **25/100** (v0.1: 16 scalar numbers only) to **80/100** (v0.2: compact text audio vision, ≤32 lines/clip).
2. **Baby/Small vs Adult/Large Animal Exam** (`pair_1`–`pair_5`): Blind pair discrimination rose from **3/5** (v0.1 scalars) to **4/5** (v0.2 compact text audio vision).

**What those numbers DO and DO NOT prove:**
- **DO prove**: `yata`'s token-efficient audio vision (`renderTextVision`) dramatically improves an LLM's ability to *read* pitch contours, spectral tilt, rhythmic cadence, and localized faults from real audio.
- **DO NOT prove**: High detector precision/recall or low false-positive rate for the 32 falsifier thresholds (`F1`–`F32`). As Section A & B above show honestly, `veto_all` has a high FPR on real benign audio and `tokiko` speech, which is why **visual readability** and **falsifier veto accuracy** must always be reported separately.

### Exact Blind Eye-Exam Rubric & Prompts

- **General Real-Audio Exam (`clip_01`–`clip_10`)**:
  - *Prompt*: Given ONLY anonymized `clip_01..clip_10` packets (Condition A: v0.1 16 scalar features; Condition B: v0.2 `renderTextVision(..., { mode: 'compact' })`), identify the likely sound source category, acoustic texture, and any localized faults (e.g., exact timestamp of click or hum frequency) without seeing filenames or ground truth.
  - *Rubric*: 10 points per clip (100 total) — 5 pts for broad acoustic class (speech/singing/instrument/animal/alarm/bird), 5 pts for specific physical cue (polyphony, historical bandlimit, aggressive hiss, periodic siren, localized click @ 1.20s + 60Hz hum).
- **Baby/Small vs Adult/Large Animal Exam (`pair_1`–`pair_5`)**:
  - *Prompt*: `For each pair (Pair_1..Pair_5), decide whether A or B is the BABY/SMALL/FRIENDLY voice and which is the ADULT/LARGE/MENACING voice.` (A/B order randomized per pair; filenames stripped).
  - *Rubric*: 1 point per pair (5 total), binary accuracy against ground truth.
