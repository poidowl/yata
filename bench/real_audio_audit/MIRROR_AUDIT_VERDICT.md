# Mirror Audit Verdict — Blind 3-Choice & 2-Choice Human Ear Evaluation (`2026-11-24`)

This document records the permanent scientific evidence from the owner's (`poidowl`) blind listening audit of [`bench/mirror_audit_demo.html`](../mirror_audit_demo.html), testing whether fixing `F24_CALCULATED_PITCH_LFO` (and related pitch/roughness flags) on `tokiko-axis` Japanese speech actually makes the voice sound better to the human ear.

---

## Aggregate Blind Verdict (`p < 0.01`)

```text
🪞 原音派 = 5 / 🎯 抑揚あり・揺れ弱め派 = 0 / 📏 フラット派 = 0 / 🤷 どれも同じ = 1
```

- **Original (`原音派`)**: **5 / 6** (5 / 5 on all decisive trials; exact binomial two-sided `p < 0.01` against 3-choice/2-choice null)
- **Prosody-kept, LFO-damped (`抑揚あり・揺れ弱め派`)**: **0 / 6**
- **Flat pitch (`フラット派`)**: **0 / 6**
- **Indistinguishable / Tie (`どれも同じ`)**: **1 / 6**

---

## Per-Trial Breakdown (6 Blind Tests)

| Test | Utterance / Preset | Format (Blind, Speed-Matched) | Owner Ear Verdict | Notes |
| :---: | :--- | :--- | :--- | :--- |
| **#1** | `「なる」` (`kawaii`) | 3-choice: Original vs Prosody-kept LFO-damped vs Flat | **🪞 Original (`原音`)** | Preferred original over both mirror-fixed variants |
| **#2** | `「なる」` (`amae`) | 3-choice: Original vs Prosody-kept LFO-damped vs Flat | **🪞 Original (`原音`)** | Preferred original over both mirror-fixed variants |
| **#3** | `「なる」` (`genki`) | 3-choice: Original vs Prosody-kept LFO-damped vs Flat | **🪞 Original (`原音`)** | Preferred original over both mirror-fixed variants |
| **#4** | `「わたし、にほんご、ちょっとしゃべれます」` (`amae`) | 2-choice: Original vs Mirror-fixed | **🤷 Tie (`どれも同じ`)** | *"鏡には差が見えた。耳には直す理由がなかった"* (`F14` / `F23` tie observed) |
| **#5** | `「おはよう、きょうは、いいてんきだね」` (`kawaii`) | 2-choice: Original vs Mirror-fixed | **🪞 Original (`原音`)** | Preferred original |
| **#6** | `「おはよう、きょうは、いいてんきだね」` (`amae`) | 2-choice: Original vs Mirror-fixed | **🪞 Original (`原音`)** | Preferred original |

---

## Architectural Conclusions (Encoded into `yata` v0.5)

1. **`F24_CALCULATED_PITCH_LFO` MUST NOT hold unilateral veto power on `tokiko` Japanese speech**:
   - The blind 3-choice test disproved the hypothesis that `F24` was merely catching unwanted LFO wobble while preserving natural accent; even the speed-matched, prosody-preserving damped version lost `0–3` to the original, and long utterances lost `0–2` (total `5–0`, `p < 0.01`).
2. **Ear-Precedent Memory (`--shelf` / `--precedents`)**:
   - Recorded permanently in [`ear_precedents.json`](./ear_precedents.json) so downstream LLMs see both what the acoustic mirror detected and what the human ear previously ruled (`[EAR-OVERRULED 5-0]`, `[ORTHOGONAL]`, `[EAR-TIE]`).
3. **Time-Segmented Mirror (`--timeline`)**:
   - Rather than forcing 32-axis unilateral veto compliance, `yata` v0.5 surfaces neuroscience-grounded lenses (Arnal `30–150 Hz` MPS roughness and Fitch/Anikin nonlinear subharmonics) alongside a `0.5s` time-segmented mirror view so coexisting kawaii and unkawaii qualities can be inspected transparently.
