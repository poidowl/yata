# Mirror Audit Verdict — Blind 3-Choice & 2-Choice Human Ear Evaluation (`2026-11-24`)

This document records the exact, unmodified evidence from the owner's (`poidowl`) blind listening audit of `bench/mirror_audit_demo.html` built at commit **`245ed15`** (`dev/v0.4`).

> **Important Experimental Condition Note (`245ed15` vs `ebd8ffb`)**:
> These votes were cast on the **`245ed15`** build of `bench/build_mirror_audit_demo.mjs`, in which the middle take ("抑揚あり・揺れ弱め") for Tests `#1`–`#3` (`「なる」`) changed speaking rate (`rate × 1.30–1.45`) alongside `hopf` damping. The later speed-matched (`1.0×` identical duration) build introduced in commit **`ebd8ffb`** has **not** yet been re-voted; therefore, these votes remain strictly bound to **`245ed15`**.

---

## Aggregate Blind Verdict (Commit `245ed15`)

```text
🪞 原音派 = 5 / 🎯 抑揚あり・揺れ弱め派 = 0 / 📏 フラット派 = 0 / 🤷 どれも同じ = 1
```

- **Original (`原音派`)**: **5 / 6** (`5 / 5` on all decisive trials)
- **Middle take (`抑揚あり・揺れ弱め派`, `rate × 1.30–1.45` in `245ed15`)**: **0 / 6**
- **Flat pitch (`フラット派`)**: **0 / 6**
- **Indistinguishable / Tie (`どれも同じ`)**: **1 / 6**
- **Exact single-outcome probability under uniform random choice**: Under the null hypothesis of independent uniform random selection across three 3-choice trials and two 2-choice trials, the probability of choosing Original on all 5 decisive trials is $(1/3)^3 \times (1/2)^2 = 1/108 \approx 0.00926$. *(This is the exact probability of that specific all-original outcome, not a two-sided binomial test.)*

---

## Per-Trial Breakdown (6 Blind Tests, Commit `245ed15`)

| Test | Utterance / Preset | Format (Blind, Commit `245ed15`) | Owner Ear Verdict | Raw Vote | Notes |
| :---: | :--- | :--- | :--- | :---: | :--- |
| **#1** | `「なる」` (`kawaii`) | 3-choice: Original vs Damped (`rate×1.35, hopf=0`) vs Flat | **🪞 Original (`原音`)** | `Take X` | Target axis: `F24` |
| **#2** | `「なる」` (`amae`) | 3-choice: Original vs Damped (`rate×1.30, hopf=0`) vs Flat | **🪞 Original (`原音`)** | `Take Y` | Target axis: `F24` |
| **#3** | `「なる」` (`genki`) | 3-choice: Original vs Damped (`rate×1.45, hopf=0.35`) vs Flat | **🪞 Original (`原音`)** | `Take Z` | Target axis: `F24` |
| **#4** | `「わたし、にほんご、ちょっとしゃべれます」` (`amae`) | 2-choice: Original vs 2.2kHz Low-Pass | **🤷 Tie (`どれも同じ`)** | `tie` | *"鏡には差が見えた。耳には直す理由がなかった"* (`F14` / `F23`) |
| **#5** | `「おはよう、きょうは、いいてんきだね」` (`kawaii`) | 2-choice: Original vs Mirror-fixed | **🪞 Original (`原音`)** | `Take Y` | Target axis: `F24` |
| **#6** | `「おはよう、きょうは、いいてんきだね」` (`genki`) | 2-choice: Original vs Mirror-fixed | **🪞 Original (`原音`)** | `Take X` | Target axes: `F23` / `F24` |

---

## What This Evidence Supports (and What It Does Not)

1. **Supported**: On `tokiko` Japanese speech (`245ed15` build), eliminating `F24_CALCULATED_PITCH_LFO` cannot be treated as an automatic improvement — the owner chose the `F24`-flagged original `5–0` over the `F24`-cleared variants, supporting `v0.4`'s decision to keep `F24` as a non-vetoing diagnostic note.
2. **Not yet isolated**: Because the middle take of `「なる」` in `245ed15` also changed `rate`, this trial alone does not isolate whether the ear preferred the pitch wobble itself or the original speaking rate. Re-voting on the speed-matched `ebd8ffb` build is required to separate those two factors.
3. **Scoped Ear-Precedent Memory (`--shelf` + `--scope`)**: Recorded in [`ear_precedents.json`](./ear_precedents.json) with explicit `scope: "tokiko_japanese_speech"`, `testedCommit: "245ed15"`, and `judge: "poidowl"`. Precedents only apply when the caller explicitly passes a matching `--scope` (or when `scope` is `"general_audio"` / `"global"`), preventing `tokiko` rulings from leaking onto unrelated audio such as bird calls.
