# yata — E2E Testing Infrastructure (`TEST_INFRA.md`)

## 1. Test Philosophy
- **Requirement-Driven & Opaque-Box**: All E2E tests are derived strictly from `ORIGINAL_REQUEST.md` and `PROJECT.md` (`§ Feature Inventory` & `§ Interface Contracts`). Tests assert observable CLI stdout/stderr/exit codes, generated SVG/PNG/HTML artifacts, and documented public ESM contracts — never private helper internals or source code structure.
- **Zero External Dependencies**: Uses only Node.js built-ins (`node:test`, `node:assert/strict`, `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:zlib`).
- **Deterministic & Self-Contained**: All test audio fixtures are generated deterministically in-memory (fixed seeds, pure math) and written to isolated temporary directories (`fs.mkdtempSync(path.join(os.tmpdir(), 'yata-e2e-...'))`) that are cleaned up in `after` hooks. No external network, no reliance on `/home/antigravity/poidowl/tokiko-axis`.
- **Fast & Non-Flaky**: Short audio clips (0.015s–1.2s at 24 kHz) keep total suite runtime under a few seconds while exercising every spectral, prosodic, waveform, spatial, and visual path.

## 2. Runner Command
```bash
node --test e2e/*.test.mjs
```
Individual tiers can also be run directly:
```bash
node --test e2e/tier1_features.test.mjs
node --test e2e/tier2_boundaries.test.mjs
node --test e2e/tier3_interactions.test.mjs
node --test e2e/tier4_scenarios.test.mjs
```

## 3. Feature Inventory Covered
1. **WAV I/O** (`decodeWavBuffer`, `encodeWavBuffer`): mono & stereo PCM16 encode/decode roundtrip, 8/16/24-bit PCM & 32-bit float decoding, safe bounds clamping, `channels[]` preservation.
2. **Feature Extraction & Audio Profile** (`extractFeatures`, `extractAudioProfile`): all 16 v0.1 backward-compatible scalar keys + F7–F32 scalar keys (all finite), full `AudioProfile` frames/spectrogram/spectralSlice/markers/phaseLoop.
3. **32-Axis Falsifiers & Registry** (`ORIGINAL_6_FALSIFIERS`, `DEFAULT_FALSIFIERS`, `createFalsifiers`, `analyzeSamples`, `compareReports`, `formatForLLM`, `formatCompareForLLM`): IDs `F1`–`F32`, domains, bounded scores `[0, 1]`, verdict `SURVIVED_KAWAII_CANDIDATE` vs `REJECTED_UNKAWAII`, ID-safe comparison, threshold overrides.
4. **Token-Efficient LLM Audio Vision** (`renderTextVision`, `renderTextDiff`, `renderSvgVision`, `renderSvgDiff`, `renderPngVision`, `renderPngDiff`):
   - Text views: `micro` (≤ 15 lines), `compact` (≤ 32 lines), `full`, `--zoom auto|t0..t1`, `ascii` & `unicode` charsets, A/B diff.
   - Vector SVG: valid `<svg>...</svg>`, no `NaN`/`Infinity`, compact size (`< 50 KB`), A/B diff SVG.
   - Raster PNG: valid PNG magic (`89 50 4E 47 0D 0A 1A 0A`), valid IHDR/IDAT/IEND chunk CRCs, `zlib.inflateSync`-verifiable pixel payload, A/B diff PNG.
5. **CLI Surface** (`node unkawaii_detector.mjs ...`):
   - Single file analysis (`--format llm|json`, `--verbose`, `--falsifiers all|core`, `--view`, `--zoom`, `--charset`, `--width`, `--svg`, `--png`).
   - Pairwise `--compare` and `--diff` (text, SVG, PNG).
   - `--discover` (counterexample discovery loop) and `--list-falsifiers`.
   - Exit code `0` on valid runs (including `REJECTED_UNKAWAII`), non-zero on invalid flags or corrupt/missing WAV.
6. **Synthetic Corpus & Discovery Loop** (`buildCorpus`, `runDiscoveryLoop`): deterministic pleasant controls + targeted `F7`–`F32` counterexamples that slip through `ORIGINAL_6_FALSIFIERS` and are caught by `DEFAULT_FALSIFIERS`.
7. **Self-Contained Audition Demo** (`bench/yata_audition_demo.html`): single-file HTML, no external CDN/script links, playable embedded audio (`data:audio/wav;base64,...` or Web Audio), `SURVIVED_KAWAII_CANDIDATE` showcase, A/B counterexample cards with human judge controls, and LLM vision views.

## 4. Four-Tier E2E Methodology

| Tier | File | Focus |
|------|------|-------|
| **Tier 1** | `e2e/tier1_features.test.mjs` | Isolated happy-path coverage of every user-facing feature (WAV I/O, CLI modes, `--format json`, `--compare`, `--diff`, `--view micro\|compact\|full`, `--zoom`, `--svg`, `--png`, `--discover`, `--list-falsifiers`, 32 falsifiers positive/negative smoke, audition HTML demo check). |
| **Tier 2** | `e2e/tier2_boundaries.test.mjs` | Boundary, edge-case, and error-handling contracts (silence, 15 ms ultra-short clip, hard-clipped / DC-biased / stereo-inverted WAV, corrupt WAV non-zero exit, unknown CLI flags, strict line budgets on `micro` ≤ 15L & `compact` ≤ 32L, binary PNG signature/IHDR/CRC/zlib-inflate integrity, SVG well-formedness with zero `NaN`/`Infinity`). |
| **Tier 3** | `e2e/tier3_interactions.test.mjs` | Cross-feature pairwise interactions (`--compare` + `--view` + `--svg` + `--png`, `--zoom auto` on localized anomaly WAV, `--falsifiers core` vs `--falsifiers all` slip-through delta, `createFalsifiers` threshold overrides, non-vocal SFX/UI chime/electronic synth audio through vision + falsifiers). |
| **Tier 4** | `e2e/tier4_scenarios.test.mjs` | End-to-end real-world workflows (synthesize adversarial counterexample → inspect via text/SVG/PNG vision → verify `ORIGINAL_6_FALSIFIERS` misses it while `DEFAULT_FALSIFIERS` catches it; verify diverse pleasant controls survive 0/32; verify `bench/yata_audition_demo.html` self-contained structure, playable WAV data URIs, A/B judge UI, and LLM vision panels). |

## 5. Shared E2E Helpers (`e2e/_helpers.mjs`)
- Pure-JS PCM16 WAV encoder (independent of `src/wav.mjs` so E2E fixtures never depend on SUT internals for test setup).
- Deterministic PRNG & simple signal generators (pleasant chime/harmonic voice, silence, localized click/spike, hard-clipped tone, DC offset, stereo phase-inverted, high-pitched piercing whistle, comb-filtered hollow tone, metronomic pulses).
- CLI runner wrapper (`runCli(args, opts)`) using `child_process.spawnSync(process.execPath, [CLI_PATH, ...args])`.
- Binary PNG structural validator (magic bytes, chunk layout, IEEE CRC32 check, IHDR width/height, `zlib.inflateSync` on concatenated IDAT chunks).
- Temp-directory lifecycle helper with guaranteed cleanup.
