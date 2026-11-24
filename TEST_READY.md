# E2E Testing Track — READY (`TEST_READY.md`)

- **Status**: `READY` (Gate PASSED on Iteration 3)
- **Runner Command**: `node --test e2e/*.test.mjs`
- **Dependencies**: Zero external npm dependencies (Node.js built-ins only)
- **Methodology**: Requirement-driven, opaque-box, 4-tier E2E suite (see `TEST_INFRA.md`)

## Suite Inventory (27 Tests across 4 Suites)
- `e2e/_helpers.mjs` — Independent pure-JS PCM16 WAV encoder, deterministic Mulberry32 PRNG + 11 signal generators, `runCli`, strict binary PNG validator (magic + IEEE CRC32 + IHDR/IEND + `zlib.inflateSync` scanline length), strict SVG validator (data-URI-safe, path-aware `NaN`/`Infinity` detection, `< 50 KB`), dynamic `loadPublicApi()`, `withTempDir()`.
- `e2e/tier1_features.test.mjs` (11 tests) — Isolated happy-path feature coverage (WAV roundtrip, CLI `--format llm|json`, `--compare`, `--diff`, `--view micro|compact|full`, `--zoom`, `--svg`, `--png`, `--discover`, `--list-falsifiers`, 32 falsifiers API smoke, `bench/yata_audition_demo.html` check).
- `e2e/tier2_boundaries.test.mjs` (8 tests) — Boundaries & error handling (silence, 15 ms ultra-short clip, hard-clipped/DC/stereo-inverted WAVs, corrupt/missing WAV & unknown CLI flag non-zero exits, `micro <= 15` & `compact <= 32` line budgets on both clean & rejected audio, PNG CRC/zlib & SVG `< 50 KB` integrity).
- `e2e/tier3_interactions.test.mjs` (5 tests) — Pairwise interactions (`--compare` + `--view` + `--svg` + `--png`, `--zoom auto` localized anomaly focus, `--falsifiers core` vs `all` slip-through delta, `createFalsifiers` threshold override determinism & immutability, non-vocal UI chime through 32 falsifiers + vision).
- `e2e/tier4_scenarios.test.mjs` (3 tests) — End-to-end real-world workflows (discovery loop + vision inspection on slip-through counterexample, >= 8 positive controls surviving 0/32, self-contained `bench/yata_audition_demo.html` audio/survivor/A-B judge/LLM vision verification).

## Verification Gate (Iteration 3 — PASS)
- `node --check e2e/*.mjs`: exit 0
- `node --test --test-reporter=spec e2e/*.test.mjs`: 27 tests, 4 suites, 6 pass on current M1+v0.1 baseline, 21 fail cleanly on unimplemented M2–M4 contracts (0 syntax/helper crashes, 0 leftover temp dirs, ~4.4s runtime).
- **Auditor (Intermediate Track Audit: `TEST_INFRA.md`, `e2e/`)**: `CLEAN`
- **Reviewer 1 (Full Suite)**: `APPROVE`
- **Reviewer 2 (Contracts)**: `APPROVE`
- **Challenger 1 (Helpers)**: `CONFIRMED`
- **Challenger 2 (Edge Cases)**: `CONFIRMED`
