# yata v0.8 — Strictly Unseen PD / CC0 Held-Out Evaluation (`HELDOUT_RESULTS.md`)

> **Zero-Tuning Discipline**: None of the 9 Wikimedia Commons clips below were used to choose or adjust any threshold in `yata v0.8`. Every clip is strictly **CC0** or **Public Domain** (zero CC BY / CC BY-SA clips), converted to 24 kHz mono WAV (≤ 3.0s) and evaluated once as-is under default `--policy core_veto`.

Manifest: [`heldout_pd_cc0_manifest.json`](./heldout_pd_cc0_manifest.json)

## Summary (Zero-Tuning Out-of-Sample, `core_veto`)

| Held-Out Group (PD / CC0 only) | Clips | `core_veto` Result | Honest Notes |
| :--- | ---: | ---: | :--- |
| **Unseen Benign Human Speech / Shhh / Whisper** | 5 | **80.0%** survival (4/5; FPR 20.0%) | `ho_shhh` ("しーっ"), `ho_good_morning`, `ho_bonjour`, `ho_lullaby_word` PASS; `ho_whisper` FP on `F1` |
| **Unseen Benign All (Human + Puppy)** | 6 | **66.7%** survival (4/6; FPR 33.3%) | `ho_whisper` and `ho_puppy` FP on `F1` (`hfRatio > 0.50`, `roughness > 0.85`) |
| **Unseen Expected-Unkawaii (Threat / Mechanical)** | 3 | **66.7%** recall (2/3) | `ho_angry_tiger` (CC0) & `ho_tram_beep` (PD) CAUGHT on first try; `ho_dishwasher` steady drone missed by Core-6 |

## Per-Clip Breakdown

| Clip ID | Group | License | Title | `core_veto` | Unobserved | `RESP` | `DIR` | `voiced` | `flat` | `atk` | `hf` | `rough` |
| :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ho_whisper` | `benign_human` | CC0 | Real human whispering | **F1 (0.955)** | — | 0.89 | 0.93 | 0.29 | 0.06 | 0.41 | 0.51 | 0.86 |
| `ho_shhh` | `benign_human` | CC0 | Human voiceless sibilant fricative ("しーっ") | **PASS** | — | 0.92 | 0.97 | 0.50 | 0.07 | 0.37 | 0.49 | 0.66 |
| `ho_good_morning` | `benign_human` | CC0 | Real human speech: Good Morning | **PASS** | — | 0.89 | 0.68 | 0.97 | 0.00 | 0.25 | 0.01 | 0.12 |
| `ho_bonjour` | `benign_human` | CC0 | Real human speech: French Good morning | **PASS** | — | 0.93 | 0.85 | 0.81 | 0.01 | 0.22 | 0.08 | 0.25 |
| `ho_lullaby_word` | `benign_human` | CC0 | Real human speech: lullaby | **PASS** | — | 0.92 | 0.82 | 0.90 | 0.00 | 0.33 | 0.01 | 0.48 |
| `ho_puppy` | `benign_animal` | CC0 | Puppy at a night | **F1 (1.000)** | `F5` | 0.72 | 0.22 | 0.29 | 0.01 | 0.40 | 0.67 | 0.96 |
| `ho_angry_tiger` | `expected_unkawaii` | CC0 | Angry tiger growl/roar | **F1 (0.796)** | `F5` | 0.73 | 0.76 | 0.31 | 0.03 | 0.31 | 0.06 | 0.57 |
| `ho_tram_beep` | `expected_unkawaii` | Public domain | Tram doors hiss & warning beep | **F1 (0.751), F4 (0.800)** | `F5` | 0.72 | 0.43 | 0.15 | 0.04 | 0.50 | 0.12 | 0.56 |
| `ho_dishwasher` | `expected_unkawaii` | Public domain | Dishwasher droning hissing humming | **PASS (MISS)** | `F5` | 0.80 | 0.63 | 0.70 | 0.01 | 0.22 | 0.02 | 0.38 |

## Key Takeaways
1. **Unseen biological threat generalization works**: `ho_angry_tiger` (CC0) and `ho_tram_beep` (PD) were caught immediately by `F1` without ever seeing them during calibration.
2. **Human "しーっ" vs whisper boundary is now exposed honestly**: `ho_shhh` passed cleanly, while `ho_whisper` (`voiced=0.29, hf=0.51, rough=0.86`) triggered `F1` because broadband unvoiced whisper overlaps with `F1`'s high-frequency roughness zone. Separating gentle human whisper from aggressive cat hiss remains an open, genuine physical challenge for v0.9.
3. **F5 observability works cleanly on real 3s excerpts**: All 4 clips trimmed mid-sound at 3.0s cleanly reported `F5` as `unobservable` (`observed: false`) instead of falsely claiming either an abrupt cutoff or a natural smooth release.
