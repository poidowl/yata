import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertAllNumericFinite,
  assertValidPng,
  assertValidSvg,
  countLines,
  genDcBiased,
  genHardClipped,
  genPleasantWarmTone,
  genSilence,
  genStereoPhaseInverted,
  genUltraShort,
  loadPublicApi,
  requireExport,
  runCli,
  withTempDir,
  writeWavFile,
} from "./_helpers.mjs";

const SR = 24000;

describe("Tier 2: Boundary & Error-Handling E2E", () => {
  it("handles all-zero silence WAV without crash or NaN/Infinity", async () => {
    const api = await loadPublicApi();
    const extractFeatures = requireExport(api, "extractFeatures");
    const analyzeSamples = requireExport(api, "analyzeSamples");
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");

    const silence = genSilence(SR, 0.4);
    const feats = extractFeatures(silence, SR);
    assertAllNumericFinite(feats, "silence.features");

    const report = analyzeSamples(silence, SR, {
      label: "silence",
      falsifiers: DEFAULT_FALSIFIERS,
    });
    assert.ok(
      report.verdict === "SURVIVED_KAWAII_CANDIDATE" ||
        report.verdict === "REJECTED_UNKAWAII"
    );
    for (const f of report.falsifiers) {
      assert.ok(
        Number.isFinite(f.score) && f.score >= 0 && f.score <= 1,
        `Silence falsifier ${f.id} score invalid: ${f.score}`
      );
    }

    await withTempDir((dir) => {
      const wavPath = path.join(dir, "silence.wav");
      writeWavFile(wavPath, silence, SR);
      const res = runCli([wavPath, "--format", "json"]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      const cliReport = JSON.parse(res.stdout);
      assertAllNumericFinite(cliReport.features, "cli.silence.features");
    });
  });

  it("handles 15 ms ultra-short clip with finite features and valid verdict", async () => {
    const api = await loadPublicApi();
    const extractFeatures = requireExport(api, "extractFeatures");
    const analyzeSamples = requireExport(api, "analyzeSamples");
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");

    const clip = genUltraShort(SR, 0.015);
    const feats = extractFeatures(clip, SR);
    assertAllNumericFinite(feats, "ultraShort.features");

    const report = analyzeSamples(clip, SR, {
      label: "ultra_short",
      falsifiers: DEFAULT_FALSIFIERS,
    });
    assert.ok(
      report.verdict === "SURVIVED_KAWAII_CANDIDATE" ||
        report.verdict === "REJECTED_UNKAWAII"
    );
    for (const f of report.falsifiers) {
      assert.ok(Number.isFinite(f.score) && f.score >= 0 && f.score <= 1);
    }

    await withTempDir((dir) => {
      const wavPath = path.join(dir, "short15ms.wav");
      writeWavFile(wavPath, clip, SR);
      const res = runCli([wavPath, "--format", "json"]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      const cliReport = JSON.parse(res.stdout);
      assertAllNumericFinite(cliReport.features, "cli.short15ms.features");
    });
  });

  it("detects hard-clipped flat-top, DC-offset, and stereo phase-inverted WAVs cleanly", async () => {
    await withTempDir((dir) => {
      const clippedPath = path.join(dir, "clipped.wav");
      const dcPath = path.join(dir, "dc.wav");
      const phasePath = path.join(dir, "phase_inv.wav");

      writeWavFile(clippedPath, genHardClipped(SR, 0.6), SR);
      writeWavFile(dcPath, genDcBiased(SR, 0.6, 0.36), SR);
      writeWavFile(phasePath, genStereoPhaseInverted(SR, 0.6), SR);

      // Hard-clipped flat-top
      const clipRes = runCli([clippedPath, "--policy", "veto_all", "--format", "json"]);
      assert.equal(clipRes.status, 0, `stderr: ${clipRes.stderr}`);
      const clipReport = JSON.parse(clipRes.stdout);
      assertAllNumericFinite(clipReport.features, "clipped.features");
      assert.equal(clipReport.verdict, "REJECTED_UNKAWAII");
      assert.ok(
        clipReport.falsifiers.some((f) => f.triggered && (f.id.startsWith("F7_") || f.id.startsWith("F6_"))),
        "Hard-clipped WAV should trigger F7 or F6"
      );

      // DC-offset bias
      const dcRes = runCli([dcPath, "--policy", "veto_all", "--format", "json"]);
      assert.equal(dcRes.status, 0, `stderr: ${dcRes.stderr}`);
      const dcReport = JSON.parse(dcRes.stdout);
      assertAllNumericFinite(dcReport.features, "dc.features");
      assert.equal(dcReport.verdict, "REJECTED_UNKAWAII");
      assert.ok(
        dcReport.falsifiers.some((f) => f.triggered && f.id.startsWith("F8_")),
        "DC-biased WAV should trigger F8_DC_OFFSET_BIAS"
      );

      // Stereo phase inversion (R = -L)
      const phaseRes = runCli([phasePath, "--policy", "veto_all", "--format", "json"]);
      assert.equal(phaseRes.status, 0, `stderr: ${phaseRes.stderr}`);
      const phaseReport = JSON.parse(phaseRes.stdout);
      assertAllNumericFinite(phaseReport.features, "phase.features");
      assert.equal(phaseReport.verdict, "REJECTED_UNKAWAII");
      assert.ok(
        phaseReport.falsifiers.some((f) => f.triggered && f.id.startsWith("F30_")),
        "Stereo phase-inverted WAV should trigger F30_STEREO_PHASE_DISCOMFORT"
      );
    });
  });

  it("CLI exits non-zero with diagnostic stderr on corrupt WAV and nonexistent path", async () => {
    await withTempDir((dir) => {
      const corruptPath = path.join(dir, "corrupt.wav");
      fs.writeFileSync(corruptPath, Buffer.from("NOT_A_WAV_FILE_1234567890"));

      const corruptRes = runCli([corruptPath]);
      assert.notEqual(corruptRes.status, 0, "Corrupt WAV must exit non-zero");
      assert.ok(
        corruptRes.stderr.trim().length > 0,
        "Corrupt WAV must emit diagnostic stderr"
      );

      const missingPath = path.join(dir, "does_not_exist.wav");
      const missingRes = runCli([missingPath]);
      assert.notEqual(missingRes.status, 0, "Missing WAV path must exit non-zero");
      assert.ok(
        missingRes.stderr.trim().length > 0,
        "Missing WAV path must emit diagnostic stderr"
      );
    });
  });

  it("CLI exits non-zero on unknown CLI flag", () => {
    const res = runCli(["--nonexistent-flag-xyz"]);
    assert.notEqual(res.status, 0, "Unknown CLI flag must exit non-zero");
  });

  it("enforces token-budget line limits: micro <= 15 lines, compact <= 32 lines (clean and rejected audio)", async () => {
    const api = await loadPublicApi();
    const extractAudioProfile = requireExport(api, "extractAudioProfile");
    const analyzeSamples = requireExport(api, "analyzeSamples");
    const renderTextVision = requireExport(api, "renderTextVision");
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");

    const cases = [
      { label: "budget_clean", samples: genPleasantWarmTone(SR, 0.6), expectRejected: false },
      { label: "budget_rejected_clipped", samples: genHardClipped(SR, 0.6), expectRejected: true },
    ];

    for (const c of cases) {
      const profile = extractAudioProfile(c.samples, SR);
      const report = analyzeSamples(c.samples, SR, {
        label: c.label,
        falsifiers: DEFAULT_FALSIFIERS,
      });
      if (c.expectRejected) {
        assert.equal(report.verdict, "REJECTED_UNKAWAII", `${c.label} must be rejected`);
        assert.ok(report.triggeredCount >= 1, `${c.label} must trigger at least one falsifier`);
      }

      const microOut = renderTextVision(profile, report, { mode: "micro" });
      const microLines = countLines(microOut);
      assert.ok(
        microLines > 0 && microLines <= 15,
        `${c.label}: micro vision exceeded 15-line budget: got ${microLines} lines`
      );

      const compactOut = renderTextVision(profile, report, { mode: "compact" });
      const compactLines = countLines(compactOut);
      assert.ok(
        compactLines > 0 && compactLines <= 32,
        `${c.label}: compact vision exceeded 32-line budget: got ${compactLines} lines`
      );
    }
  });

  it("validates PNG binary integrity (magic, IHDR, CRC32, IEND, zlib inflate) on vision, diff, and CLI", async () => {
    const api = await loadPublicApi();
    const extractAudioProfile = requireExport(api, "extractAudioProfile");
    const analyzeSamples = requireExport(api, "analyzeSamples");
    const renderPngVision = requireExport(api, "renderPngVision");
    const renderPngDiff = requireExport(api, "renderPngDiff");
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");

    const a = genPleasantWarmTone(SR, 0.5, 21);
    const b = genHardClipped(SR, 0.5);
    const profA = extractAudioProfile(a, SR);
    const profB = extractAudioProfile(b, SR);
    const repA = analyzeSamples(a, SR, { label: "a", falsifiers: DEFAULT_FALSIFIERS });
    const repB = analyzeSamples(b, SR, { label: "b", falsifiers: DEFAULT_FALSIFIERS });

    const singlePng = renderPngVision(profA, repA);
    const singleMeta = assertValidPng(singlePng);
    assert.ok(singleMeta.width >= 100 && singleMeta.height >= 100);

    const diffPng = renderPngDiff(profA, profB, repA, repB);
    const diffMeta = assertValidPng(diffPng);
    assert.ok(diffMeta.width >= 100 && diffMeta.height >= 100);

    await withTempDir((dir) => {
      const wavPath = path.join(dir, "a.wav");
      const pngPath = path.join(dir, "out.png");
      writeWavFile(wavPath, a, SR);
      const res = runCli([wavPath, "--png", pngPath]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assertValidPng(fs.readFileSync(pngPath));
    });
  });

  it("validates SVG XML well-formedness, no NaN/Infinity, and < 50 KB compact size", async () => {
    const api = await loadPublicApi();
    const extractAudioProfile = requireExport(api, "extractAudioProfile");
    const analyzeSamples = requireExport(api, "analyzeSamples");
    const renderSvgVision = requireExport(api, "renderSvgVision");
    const renderSvgDiff = requireExport(api, "renderSvgDiff");
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");

    const a = genPleasantWarmTone(SR, 0.5, 22);
    const b = genDcBiased(SR, 0.5, 0.35);
    const profA = extractAudioProfile(a, SR);
    const profB = extractAudioProfile(b, SR);
    const repA = analyzeSamples(a, SR, { label: "a", falsifiers: DEFAULT_FALSIFIERS });
    const repB = analyzeSamples(b, SR, { label: "b", falsifiers: DEFAULT_FALSIFIERS });

    assertValidSvg(renderSvgVision(profA, repA), { maxBytes: 50 * 1024 });
    assertValidSvg(renderSvgDiff(profA, profB, repA, repB), { maxBytes: 50 * 1024 });
  });
});
