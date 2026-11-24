# Project: yata — Multidimensional "Unkawaii" Falsifier & LLM Audio-Vision Suite

> **0th Axiom**: 「音声から『かわいくなさ』を多次元的に発見する。それに失敗したら『かわいい』。」
> **Design Philosophy**: Zero external npm dependencies, pure ES Modules (`"type": "module"`, Node.js v18+), domain-general across all audio (voice, prosody, rhythm/pauses, SFX/UI/electronic, spatial/room/stereo, recording/digital artifacts, psychoacoustics), token-efficient LLM-first interfaces, 100% backward-compatible with `unkawaii_detector.mjs` v0.1.0.

---

## Architecture

```text
                       ┌──────────────────────────────┐
                       │   unkawaii_detector.mjs      │
                       │ (Backward-Compat Facade+CLI) │
                       └──────────────┬───────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌───────────────────┐       ┌───────────────────┐         ┌───────────────────┐
│   Core DSP/WAV    │       │  32 Falsifiers &  │         │  LLM Audio Vision │
│  src/wav.mjs      │──────▶│   Report Engine   │         │  src/visualize/   │
│  src/dsp.mjs      │       │  src/falsifiers/  │────────▶│   ascii.mjs       │
│  src/features.mjs │──────▶│  src/report.mjs   │         │   svg.mjs         │
└───────────────────┘       └─────────┬─────────┘         │   png_encoder.mjs │
                                      │                   │   png.mjs         │
                                      ▼                   └───────────────────┘
                            ┌───────────────────┐
                            │ Synth & Discovery │
                            │  src/synth.mjs    │
                            │  src/discovery.mjs│
                            │  bench/*.mjs      │
                            └───────────────────┘
```

- **Zero Runtime Dependencies**: Only Node.js built-ins (`node:fs`, `node:path`, `node:url`, `node:zlib`, `node:test`, `node:assert/strict`). `/home/antigravity/poidowl/tokiko-axis` is a strictly read-only optional benchmark reference, never imported by core library code.
- **Token-Efficiency Principle**: Default text outputs are compact and high-density (`micro` ≤ 15 lines, `compact` ≤ 32 lines) with on-demand `--zoom auto|t0..t1` anomaly magnification and file-based SVG/PNG outputs (zero stdout bloat).

---

## Feature Inventory

Every feature discovered in the 4-Explorer Survey is assigned to a milestone (none unassigned):

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Bounds-safe WAV decoder & PCM16 encoder | `decodeWavBuffer` supporting 8/16/24-bit PCM & 32-bit float, safe `dataSize` clamping, `fmt`-after-`data` handling, optional stereo `channels: [L, R]` preserved alongside mono `samples`; plus `encodeWavBuffer` | M1 | survey_1, survey_3 |
| 2 | Pure-JS Radix-2 FFT & Hann STFT | In-place radix-2 Cooley-Tukey FFT, Hann-windowed STFT, Mel/log-band filterbank, spectral centroid, rolloff, flatness, flux, band harshness | M1 | survey_1, survey_2, survey_3 |
| 3 | Upgraded F0, HNR, Roughness, Cepstrum & Modulation DSP | DC measurement & AC separation; parabolic-interpolated F0 (`55–1000 Hz`) + `domHz` non-vocal fallback; voiced HNR; Plomp-Levelt sensory roughness; real cepstrum (comb notches); amplitude & pitch modulation DFT; onset flux/IOI; envelope curvature `|Δ²E|`; real-audio phase-space loop; anomaly hotspots | M1 | survey_2, survey_3, survey_4 |
| 4 | Backward-compatible `extractFeatures` & `extractAudioProfile` | Preserve all 16 v0.1 scalar fields verbatim + add scalar features for `F7`–`F32` + full `AudioProfile` time-series/spectrogram/markers for visualizers | M1 | survey_1, survey_2, survey_3 |
| 5 | Preserved Core 6 Falsifiers (`F1`–`F6`) | `ORIGINAL_6_FALSIFIERS` (`F1_HARSH_EDGE`..`F6_PHYSICAL_GLITCH`) with exact v0.1 IDs, domains, and contracts | M2 | survey_1, survey_3 |
| 6 | Waveform & Dynamics Falsifiers (`F7`–`F11`) | `F7_FLAT_TOP_CLIPPING`, `F8_DC_OFFSET_BIAS`, `F9_MICRO_CLICK_DROPOUT`, `F10_BRICKWALL_SUFFOCATION`, `F11_PUMPING_TREMOLO` | M2 | survey_3 |
| 7 | Aggression & Psychoacoustic Falsifiers (`F12`–`F16`, `F31`) | `F12_MENACING_LOW_REGISTER`, `F13_SUBBASS_RUMBLE`, `F14_HELMHOLTZ_ROUGHNESS`, `F15_PIERCING_WHISTLE`, `F16_HARSH_SIBILANCE_FIZZ`, `F31_PRESSED_STRAIN` (with `sasayaki` whisper guard) | M2 | survey_3, survey_4 |
| 8 | Hollowness & Timbral Stasis Falsifiers (`F17`–`F20`, `F32`) | `F17_HOLLOW_METALLIC_COMB`, `F18_MUDDY_BOXINESS`, `F19_TELEPHONE_BANDLIMIT`, `F20_STERILE_PURE_TONE`, `F32_SPECTRAL_STASIS` | M2 | survey_3, survey_4 |
| 9 | Prosody, Control, Artifice & Cadence Falsifiers (`F21`–`F27`) | `F21_NOISY_HNR_SWAMP`, `F22_MONOTONE_FLAT_PROSODY`, `F23_ERRATIC_PITCH_WARBLE`, `F24_CALCULATED_PITCH_LFO`, `F25_AUTOTUNE_STAIRCASE`, `F26_INTERNAL_REBOUND_SHOCK`, `F27_METRONOMIC_CADENCE` | M2 | survey_3, survey_4 |
| 10 | Environment, Digital & Spatial Falsifiers (`F28`–`F30`) | `F28_MAINS_HUM_DRONE`, `F29_BITCRUSH_ALIASING`, `F30_STEREO_PHASE_DISCOMFORT` (graceful no-op on mono) | M2 | survey_3 |
| 11 | Extensible Registry & ID-Safe Report Engine | `DEFAULT_FALSIFIERS` (32), `ORIGINAL_6_FALSIFIERS` (6), `createFalsifiers(overrides)`, `analyzeSamples`, ID-safe `compareReports`, token-efficient `formatForLLM` (triggered-first compact summary + optional verbose), `formatCompareForLLM` | M2 | survey_1, survey_3 |
| 12 | Token-Efficient Progressive Text Vision | `renderTextVision` (`micro` ≤ 15L, `compact` ≤ 32L default, `full`, `--zoom auto|t0..t1`, `ascii`/`unicode` charset, aligned sparklines + 8×48 Mel spectrogram + 8-band balance + falsifier spotlight) & `renderTextDiff` (A/B signed spectrogram/feature delta) | M3 | survey_2 |
| 13 | Pure-JS PNG Encoder & 6-Panel Raster Vision | `png_encoder.mjs` (`node:zlib` `deflateSync` + CRC32 + RGBA canvas + 5×7 ASCII bitmap font) + `renderPngVision` & `renderPngDiff` (waveform/envelope, Magma Mel spectrogram, F0/domHz+HNR, spectral slice, phase-space loop + tail inset, falsifier scoreboard) | M3 | survey_1, survey_2 |
| 14 | Pure-JS 6-Panel Vector SVG Vision | `renderSvgVision` & `renderSvgDiff` with crisp vector axes/annotations and inline pure-JS base64 PNG spectrogram (keeping SVG compact `< 50 KB`) | M3 | survey_1, survey_2 |
| 15 | Deterministic Pure-JS Synthetic Corpus (`src/synth.mjs`) | Seeded Mulberry32 PRNG; ≥8 diverse pleasant/kawaii positive controls (voice, whisper/sigh, chirp, marimba, celesta/UI chime, lullaby, `鳴る`, `鳴った`) + 26 targeted `F1`–`F6` slip-through counterexamples (`ce_F7`..`ce_F32`) + 2 legacy katakana controls (`ナル`, `ナッタ`) | M4 | survey_3, survey_4 |
| 16 | Counterexample Discovery & Visual Inspection Loop | `src/discovery.mjs`: runs `ORIGINAL_6_FALSIFIERS` vs `DEFAULT_FALSIFIERS`, identifies slip-throughs & false positives, generates compact LLM audio-vision dossiers (text + optional SVG/PNG) | M4 | survey_1, survey_3 |
| 17 | Backward-Compatible Root CLI & Facade (`unkawaii_detector.mjs`) | Preserves all v0.1 exports & CLI (`<file.wav>`, `--compare`, `--format llm|json`); adds `--view [micro|compact|full]`, `--zoom [auto|t0..t1]`, `--charset`, `--width`, `--svg`, `--png`, `--diff`, `--discover`, `--list-falsifiers`, `--falsifiers core|all`; fixes symlink entrypoint & arg parsing quirks | M4 | survey_1, survey_2 |
| 18 | Benchmarks, Optional `tokiko-axis` Real-Speech Bench & Docs | `bench/benchmark.mjs` (detection matrix + latency), `bench/tokiko_axis_bench.mjs` (optional read-only `kuda.mjs` matrix verifying `kawaii`/`amae`/`genki`/`sasayaki`/`kawaii_ts_j` survive 0/32 and counterexamples caught, graceful skip if absent), `package.json` scripts (`test`, `bench`, `discover`, `build:demo`), comprehensive `README.md` | M4 | survey_1, survey_4 |
| 19 | Self-Contained Interactive HTML Audition Demo Page | `bench/build_demo.mjs` generating zero-dep single-file `bench/yata_audition_demo.html` (opens directly in browser, one-click audio playback via embedded WAV data URIs): (1) `SURVIVED_KAWAII_CANDIDATE` showcase corner (pure-JS + optional `kuda.mjs` Japanese voices), (2) **A/B Comparison Cards for every discovered axis (`F7`–`F32` + `F1`–`F6`)** pairing **A (caught unkawaii sample)** vs **B (clean/survived counterpart)** with one-click play & compact LLM A/B diff + SVG view, (3) **Human Quick-Judge buttons** (`でかした！（軸OK）` / `すり抜けたほうかわいくねーよ！` / optional note) + one-click "Copy Judge Log" button for pasting directly into chat | M4 | follow-up_3, follow-up_4 |
| 20 | Independent Opaque-Box E2E Test Suite (Tiers 1–4) | Requirement-driven E2E tests in `e2e/` covering all features across Tiers 1–4 + `TEST_INFRA.md` & `TEST_READY.md` | E2E Track | dual-track |
| 21 | Final E2E Verification & Tier 5 Adversarial Hardening | Pass 100% of E2E Tiers 1–4, then run white-box Tier 5 adversarial challenger hardening until no gaps remain | M5 | dual-track |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|--------------|--------|
| M1 | Core WAV, Pure-JS DSP & Audio Profile | `src/wav.mjs`, `src/dsp.mjs`, `src/features.mjs`, `test/wav.test.mjs`, `test/dsp.test.mjs` | none | IN_PROGRESS |
| M2 | 32-Axis Falsifiers & Report Engine | `src/falsifiers/*.mjs`, `src/report.mjs`, `test/falsifiers.test.mjs` | M1 | PLANNED |
| M3 | Token-Efficient LLM Audio Vision (Text/SVG/PNG) | `src/visualize/*.mjs`, `test/visualize.test.mjs` | M1 | PLANNED |
| M4 | Synth Corpus, Discovery Loop, CLI, Demo Page, Benches & Docs | `src/synth.mjs`, `src/discovery.mjs`, `unkawaii_detector.mjs`, `bench/benchmark.mjs`, `bench/tokiko_axis_bench.mjs`, `bench/build_demo.mjs`, `bench/yata_audition_demo.html`, `package.json`, `README.md`, `test/synth.test.mjs`, `test/cli.test.mjs` | M2, M3 | PLANNED |
| E2E | E2E Testing Track (Opaque-Box Tiers 1–4) | `TEST_INFRA.md`, `e2e/*.mjs`, `TEST_READY.md` | none (parallel) | DONE (27 tests, Iter 3 PASS, Auditor CLEAN) |
| M5 | Final Milestone (E2E Tiers 1–4 Pass + Tier 5 Hardening) | Fix any E2E failures across Tiers 1–4, then Tier 5 white-box adversarial hardening | M4, E2E | PLANNED |

---

## Interface Contracts

### `src/wav.mjs`
```js
export function decodeWavBuffer(buffer);
// Returns: {
//   samples: Float32Array,       // mono downmix (backward-compatible)
//   sampleRate: number,
//   durationSec: number,
//   numChannels: number,
//   bitsPerSample: number,
//   channels: Float32Array[],    // per-channel raw Float32Arrays (length === numChannels)
// }

export function encodeWavBuffer(samplesOrChannels, sampleRate, opts = { bitsPerSample: 16 });
// Accepts Float32Array (mono) or Float32Array[] (multi-channel), returns Buffer (RIFF/WAVE PCM16)
```

### `src/dsp.mjs` & `src/features.mjs`
```js
export function fftRadix2(re, im); // in-place radix-2 Cooley-Tukey FFT (length must be power of 2)

export function extractAudioProfile(samples, sampleRate, opts = {});
// opts: { fftSize?, hopMs = 10, melBands = 48, fMin = 60, fMax = 8000, channels? }
// Returns AudioProfile:
// {
//   sampleRate, durationSec, fftSize, hopSize,
//   frames: Array<{
//     timeSec, rms, rmsDb, peakPos, peakNeg, zcrRate, hfRatio,
//     f0, domHz, periodicity, voiced, hnrDb,
//     spectralCentroidHz, spectralRolloffHz, spectralFlatness,
//     harshnessRatio, spectralFlux, envelopeCurvature, clipped
//   }>,
//   spectrogram: { times: number[], freqsHz: number[], dbMatrix: Float32Array[], minDb: number, maxDb: number },
//   spectralSlice: { freqsHz: number[], meanDb: number[], peakDb: number[], peaks: Array<{ hz: number, db: number }> },
//   markers: { onsets: number[], curvatureSpikes: number[], valleys: number[], clips: number[], tailWindow: { startSec: number, endSec: number }, hotspots: Array<{ startSec: number, endSec: number, reason: string, severity: number }> },
//   phaseLoop: Array<{ t: number, tension: number, breath: number }>
// }

export function extractFeatures(samples, sampleRate, opts = {});
// Preserves ALL 16 v0.1 scalar keys verbatim:
//   sampleRate, durationSec, frameCount, activeFrameCount, peak, clipRatio, maxSampleJump,
//   maxAttackSlope, maxAttackTimeSec, meanHfRatio, voicedRatio, jitter, shimmer,
//   commonCauseCoupling, tailDecaySec, tailStartSec
// Plus new scalar keys for F7–F32 (all finite numbers, no NaN/Infinity):
//   exactFlatRatio, clippedPeakCycles, dcOffset, dcToRmsRatio,
//   clickRatio, maxClickJump, clickTimeSec, dropoutCount, dropoutTimeSec,
//   crestFactorDb, activeRmsCv, ampModDepth, ampModSinusoidality, ampModFreqHz,
//   medianF0, spectralCentroidHz, lowBandRatio, subBassRatio,
//   meanRoughness, piercingProminenceDb, piercingBandShare, piercingPersistence, piercingFreqHz,
//   meanSibilanceRatio, p90SibilanceRatio,
//   nonPitchCepstralPeak, combNotchDepthDb, combDelayMs,
//   boxyRatio, presenceRatio, midOnlyRatio, lowWarmthRatio, highAirRatio,
//   meanTop1PeakShare, meanVoicedHnrDb, meanSpectralFlatness,
//   voicedDurationSec, voicedFrameCount, f0RangeSemitones,
//   f0MeanAbsDiffSemi, f0SecondDiffSemi,
//   f0ModDepthSemi, f0ModSinusoidality, f0ModFreqHz,
//   flatStepRatio, snapJumpCount,
//   maxInternalShock, internalShockTimeSec,
//   onsetCount, ioiCv, meanIoiSec,
//   mainsHumRatio, mainsPersistence, mainsFreqHz,
//   uniqueLevelRatio, aliasingFloorRatio,
//   numChannels, stereoCorr, lrImbalance,
//   lowToMidTiltDb, midHighFlatness, meanSpectralFlux
```

### `src/falsifiers/index.mjs` & `src/report.mjs`
```js
// Each falsifier:
// {
//   id: string,           // e.g. "F1_HARSH_EDGE" .. "F32_SPECTRAL_STASIS"
//   domain: string,       // e.g. "aggression", "absence_of_presence", "no_arrow_of_time",
//                         //      "mechanical_failure", "dynamics", "hollowness",
//                         //      "broken_control", "calculated_artifice", "rhythm_timing",
//                         //      "environment_digital_spatial"
//   name: string,
//   detect(features, thresholds?): {
//     triggered: boolean,
//     score: number,      // [0, 1] finite
//     threshold: number,
//     evidence: string,
//     hint: string,
//     where?: { startSec?: number, endSec?: number, freqHz?: number }
//   }
// }

export const ORIGINAL_6_FALSIFIERS; // [F1..F6]
export const DEFAULT_FALSIFIERS;    // [F1..F32]
export function createFalsifiers(thresholdOverrides = {});

export function analyzeSamples(samples, sampleRate, options = {});
// options: { label = "untitled", falsifiers = DEFAULT_FALSIFIERS, channels?, includeProfile = false, thresholds? }
// Returns report with v0.1-compatible shape:
// { schema: "unkawaii_report/v0.2", label, verdict, triggeredCount, totalFalsifiers, mirrorSummary, features, falsifiers, profile? }
// verdict: "SURVIVED_KAWAII_CANDIDATE" | "REJECTED_UNKAWAII"

export function compareReports(reportA, reportB); // ID-safe lookup
export function formatForLLM(report, opts = { verbose: false });
export function formatCompareForLLM(cmp, opts = { verbose: false });
```

### `src/visualize/index.mjs`
```js
export function renderTextVision(profile, report, opts = { mode: "compact", width: 48, specRows: 8, charset: "ascii", zoom: null });
export function renderTextDiff(profileA, profileB, reportA, reportB, opts = { width: 48, specRows: 8, charset: "ascii" });
export function renderSvgVision(profile, report, opts = {});  // returns valid <svg>...</svg> string
export function renderSvgDiff(profileA, profileB, reportA, reportB, opts = {});
export function renderPngVision(profile, report, opts = {});  // returns valid PNG Buffer
export function renderPngDiff(profileA, profileB, reportA, reportB, opts = {});
```

### `src/synth.mjs` & `src/discovery.mjs`
```js
export function buildCorpus(opts = { sampleRate: 24000, seed: 2026 });
// Returns { positives: CorpusItem[], counterexamples: CorpusItem[], legacyNegatives: CorpusItem[] }
// CorpusItem: { id, kind, targetFalsifier?, description, samples: Float32Array, channels?: Float32Array[], sampleRate }

export function runDiscoveryLoop(opts = {});
// Evaluates corpus against ORIGINAL_6_FALSIFIERS vs DEFAULT_FALSIFIERS, returns structured summary + compact visual dossiers
```

### CLI Contract (`unkawaii_detector.mjs`)
- `node unkawaii_detector.mjs <file.wav> [--format llm|json] [--verbose] [--falsifiers all|core] [--view [micro|compact|full]] [--zoom [auto|<t0>..<t1>]] [--charset ascii|unicode] [--width <N>] [--svg <out.svg>] [--png <out.png>]`
- `node unkawaii_detector.mjs --compare <a.wav> <b.wav> [--format llm|json] [--view [micro|compact|full]] [--svg <out.svg>] [--png <out.png>]`
- `node unkawaii_detector.mjs --diff <a.wav> <b.wav> [--charset ascii|unicode] [--width <N>] [--svg <out.svg>] [--png <out.png>]`
- `node unkawaii_detector.mjs --discover [--format llm|json] [--view]`
- `node unkawaii_detector.mjs --list-falsifiers [--format llm|json]`
- Exit code `0` on valid execution (including `REJECTED_UNKAWAII`), non-zero on invalid arguments or unreadable/corrupt WAV.

---

## Code Layout

```text
/home/antigravity/poidowl/yata/
├── unkawaii_detector.mjs            # Root backward-compatible facade & CLI
├── package.json                     # Zero deps, "type": "module", scripts: test/bench/discover
├── README.md                        # Updated user & LLM developer guide
├── PROJECT.md                       # Living project architecture & milestone status
├── TEST_INFRA.md                    # E2E testing methodology & architecture (E2E Track)
├── TEST_READY.md                    # E2E completion signal (E2E Track)
├── src/
│   ├── wav.mjs                      # M1: WAV decode (8/16/24-bit PCM, Float32, stereo) & PCM16 encode
│   ├── dsp.mjs                      # M1: Radix-2 FFT, Hann STFT, Mel bands, F0, HNR, roughness, cepstrum, mod-DFT
│   ├── features.mjs                 # M1: extractFeatures (v0.1 + F7–F32) & extractAudioProfile
│   ├── falsifiers/
│   │   ├── index.mjs                # M2: DEFAULT_FALSIFIERS (32), ORIGINAL_6_FALSIFIERS (6), registry
│   │   ├── core.mjs                 # M2: F1–F6 (backward-compatible)
│   │   ├── waveform.mjs             # M2: F7–F11 (mechanical_failure & dynamics)
│   │   ├── spectral.mjs             # M2: F12–F20, F31, F32 (aggression, hollowness, strain, stasis)
│   │   ├── prosody.mjs              # M2: F21–F27 (presence, broken_control, artifice, rebound, cadence)
│   │   └── spatial.mjs              # M2: F28–F30 (mains hum, bitcrush/aliasing, stereo phase)
│   ├── report.mjs                   # M2: analyzeSamples, compareReports, formatForLLM, formatCompareForLLM
│   ├── visualize/
│   │   ├── index.mjs                # M3: Unified visualization API
│   │   ├── ascii.mjs                # M3: Token-efficient progressive text views, anomaly zoom, A/B diff
│   │   ├── png_encoder.mjs          # M3: Zero-dep pure-JS PNG encoder (node:zlib + CRC32 + RGBA + 5×7 font)
│   │   ├── svg.mjs                  # M3: 6-panel vector diagnostic SVG & A/B diff SVG
│   │   └── png.mjs                  # M3: 6-panel raster PNG & A/B diff PNG
│   ├── synth.mjs                    # M4: Deterministic pure-JS positive & adversarial counterexample corpus
│   └── discovery.mjs                # M4: Counterexample discovery & LLM visual inspection loop
├── test/                            # Unit & integration tests (`node --test`)
│   ├── wav.test.mjs                 # M1
│   ├── dsp.test.mjs                 # M1
│   ├── falsifiers.test.mjs          # M2
│   ├── visualize.test.mjs           # M3
│   ├── synth.test.mjs               # M4
│   └── cli.test.mjs                 # M4
├── bench/
│   ├── kawaii_static_verifier.html  # Existing browser bench (keep intact!)
│   ├── benchmark.mjs                # M4: Detection matrix & throughput benchmark
│   └── tokiko_axis_bench.mjs        # M4: Optional read-only kuda.mjs real-speech bench (graceful skip)
└── e2e/                             # E2E Track: Opaque-box Tiers 1–4 test suite
```
