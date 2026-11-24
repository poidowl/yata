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
  genLocalizedClick,
  genNonVocalChime,
  genPleasantWarmTone,
  genStereoPhaseInverted,
  loadPublicApi,
  requireExport,
  runCli,
  withTempDir,
  writeWavFile,
} from "./_helpers.mjs";

const SR = 24000;

describe("Tier 3: Cross-Feature Pairwise Interactions E2E", () => {
  it("CLI --compare combined with --view compact, --svg, and --png succeeds in one invocation", async () => {
    await withTempDir((dir) => {
      const aPath = path.join(dir, "warm.wav");
      const bPath = path.join(dir, "dc.wav");
      const svgOut = path.join(dir, "cmp.svg");
      const pngOut = path.join(dir, "cmp.png");
      writeWavFile(aPath, genPleasantWarmTone(SR, 0.5), SR);
      writeWavFile(bPath, genDcBiased(SR, 0.5, 0.36), SR);

      const res = runCli([
        "--compare",
        aPath,
        bPath,
        "--view",
        "compact",
        "--svg",
        svgOut,
        "--png",
        pngOut,
      ]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.ok(res.stdout.trim().length > 0, "Expected comparison + compact view stdout");
      assert.ok(fs.existsSync(svgOut), "Expected --svg file to be written");
      assert.ok(fs.existsSync(pngOut), "Expected --png file to be written");
      assertValidSvg(fs.readFileSync(svgOut, "utf8"));
      assertValidPng(fs.readFileSync(pngOut));
    });
  });

  it("--zoom auto on localized anomaly (click at t=0.40s) focuses on anomaly region and stays compact", async () => {
    const api = await loadPublicApi();
    const extractAudioProfile = requireExport(api, "extractAudioProfile");
    const analyzeSamples = requireExport(api, "analyzeSamples");
    const renderTextVision = requireExport(api, "renderTextVision");
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");

    const clickAudio = genLocalizedClick(SR, 0.8, 0.4);
    const profile = extractAudioProfile(clickAudio, SR);
    const report = analyzeSamples(clickAudio, SR, {
      label: "click_040",
      falsifiers: DEFAULT_FALSIFIERS,
    });

    const fullText = renderTextVision(profile, report, { mode: "compact", zoom: null });
    const zoomedText = renderTextVision(profile, report, { mode: "compact", zoom: "auto" });

    assert.ok(countLines(zoomedText) <= 32, "Zoomed compact output must stay <= 32 lines");
    assert.notEqual(
      zoomedText,
      fullText,
      "zoom: 'auto' on localized anomaly should differ from full unzoomed view"
    );
    // Verify the zoomed view references a timestamp near 0.40s (e.g., 0.25..0.55, 0.40s, t=0.400s, 400ms)
    const timeMatches = [];
    // 1. Milliseconds with explicit 'ms' unit (e.g. 280ms, 400ms, 350ms..450ms)
    for (const m of zoomedText.matchAll(/\b(\d+(?:\.\d+)?)\s*ms\b/gi)) {
      timeMatches.push(Number.parseFloat(m[1]) / 1000);
    }
    // 2. Seconds with explicit 's' unit (e.g. 0.40s, 0.3s..0.5s, t=0.400s)
    for (const m of zoomedText.matchAll(/(?<![A-Za-z0-9_])(\d+\.\d{1,3})\s*s\b/gi)) {
      timeMatches.push(Number.parseFloat(m[1]));
    }
    // 3. Time ranges t0..t1 or decimal t0-t1 / t0 to t1 (without ms suffix)
    for (const m of zoomedText.matchAll(
      /(?<![A-Za-z0-9_.])(\d+(?:\.\d{1,3})?)\s*s?(?!\s*ms\b)\s*\.\.\s*(\d+(?:\.\d{1,3})?)\s*s?(?!\s*ms\b)(?![A-Za-z0-9_])/gi
    )) {
      timeMatches.push(Number.parseFloat(m[1]), Number.parseFloat(m[2]));
    }
    for (const m of zoomedText.matchAll(
      /(?<![A-Za-z0-9_.])(\d+\.\d{1,3})\s*s?(?!\s*ms\b)\s*(?:[-–—]|\s+to\s+)\s*(\d+\.\d{1,3})\s*s?(?!\s*ms\b)(?![A-Za-z0-9_])/gi
    )) {
      timeMatches.push(Number.parseFloat(m[1]), Number.parseFloat(m[2]));
    }
    // 4. Prefixed timestamps (t=0.40, @0.40) without ms suffix
    for (const m of zoomedText.matchAll(/(?:\bt\s*=\s*|@\s*)(\d+(?:\.\d{1,3})?)(?![0-9.])(?!\s*ms\b)/gi)) {
      timeMatches.push(Number.parseFloat(m[1]));
    }
    assert.ok(
      timeMatches.some((t) => Number.isFinite(t) && t >= 0.2 && t <= 0.6),
      `Expected zoomed vision to reference time window around 0.40s, found times: ${JSON.stringify(timeMatches)}`
    );

    await withTempDir((dir) => {
      const wavPath = path.join(dir, "click.wav");
      writeWavFile(wavPath, clickAudio, SR);
      const cliRes = runCli([wavPath, "--view", "compact", "--zoom", "auto"]);
      assert.equal(cliRes.status, 0, `stderr: ${cliRes.stderr}`);
      assert.ok(cliRes.stdout.trim().length > 0);
    });
  });

  it("--falsifiers core vs --falsifiers all shows slip-through delta on targeted counterexample", async () => {
    await withTempDir((dir) => {
      // Stereo phase inversion (R = -L) on warm audio: invisible to core 6, caught by all 32 (F30)
      const phasePath = path.join(dir, "phase_inv.wav");
      writeWavFile(phasePath, genStereoPhaseInverted(SR, 0.6), SR);

      const coreRes = runCli([phasePath, "--falsifiers", "core", "--format", "json"]);
      assert.equal(coreRes.status, 0, `stderr: ${coreRes.stderr}`);
      const coreReport = JSON.parse(coreRes.stdout);

      const allRes = runCli([phasePath, "--falsifiers", "all", "--format", "json"]);
      assert.equal(allRes.status, 0, `stderr: ${allRes.stderr}`);
      const allReport = JSON.parse(allRes.stdout);

      assert.equal(coreReport.totalFalsifiers, 6);
      assert.equal(allReport.totalFalsifiers, 32);
      assert.equal(allReport.verdict, "REJECTED_UNKAWAII");
      assert.ok(
        allReport.triggeredCount > coreReport.triggeredCount,
        `Expected --falsifiers all (${allReport.triggeredCount}) to trigger more than core (${coreReport.triggeredCount})`
      );
    });
  });

  it("createFalsifiers(thresholdOverrides) alters detection deterministically without mutating DEFAULT_FALSIFIERS", async () => {
    const api = await loadPublicApi();
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");
    const createFalsifiers = requireExport(api, "createFalsifiers");
    const analyzeSamples = requireExport(api, "analyzeSamples");

    const dcAudio = genDcBiased(SR, 0.6, 0.36);
    const defaultIdsBefore = DEFAULT_FALSIFIERS.map((f) => f.id);
    const beforeReport = analyzeSamples(dcAudio, SR, {
      label: "dc_default_before",
      falsifiers: DEFAULT_FALSIFIERS,
    });
    const f8Before = beforeReport.falsifiers.find((f) => f.id.startsWith("F8_"));
    assert.ok(f8Before, "F8 falsifier must exist");
    assert.equal(f8Before.triggered, true, "Baseline F8 should trigger on 0.36 DC offset");

    // Relax F8 threshold far above observed DC offset / dcToRmsRatio so it no longer triggers
    const highThreshold = Math.max(100, (f8Before.threshold || 1) * 1000);
    const relaxedFalsifiers = createFalsifiers({ [f8Before.id]: highThreshold });
    assert.equal(relaxedFalsifiers.length, 32);
    assert.notEqual(relaxedFalsifiers, DEFAULT_FALSIFIERS);

    const relaxedReport1 = analyzeSamples(dcAudio, SR, {
      label: "dc_relaxed_1",
      falsifiers: relaxedFalsifiers,
    });
    const relaxedReport2 = analyzeSamples(dcAudio, SR, {
      label: "dc_relaxed_2",
      falsifiers: relaxedFalsifiers,
    });
    const f8Relaxed1 = relaxedReport1.falsifiers.find((f) => f.id === f8Before.id);
    const f8Relaxed2 = relaxedReport2.falsifiers.find((f) => f.id === f8Before.id);
    assert.ok(f8Relaxed1, "Overridden F8 falsifier must exist in report");
    assert.ok(
      f8Relaxed1.triggered === false || f8Relaxed1.threshold !== f8Before.threshold,
      `Expected relaxed F8 override (${highThreshold}) to suppress trigger or update threshold (got triggered=${f8Relaxed1.triggered}, threshold=${f8Relaxed1.threshold}, before=${f8Before.threshold})`
    );
    assert.equal(f8Relaxed1.triggered, f8Relaxed2.triggered, "Overridden falsifier must be deterministic");
    assert.equal(f8Relaxed1.score, f8Relaxed2.score, "Overridden falsifier must be deterministic");

    // Verify DEFAULT_FALSIFIERS was not mutated
    assert.deepEqual(
      DEFAULT_FALSIFIERS.map((f) => f.id),
      defaultIdsBefore
    );
    const afterReport = analyzeSamples(dcAudio, SR, {
      label: "dc_default_after",
      falsifiers: DEFAULT_FALSIFIERS,
    });
    const f8After = afterReport.falsifiers.find((f) => f.id === f8Before.id);
    assert.equal(f8After.triggered, true, "DEFAULT_FALSIFIERS must remain unmutated");
    assert.equal(f8After.threshold, f8Before.threshold, "DEFAULT_FALSIFIERS threshold must remain unchanged");
    assert.equal(f8After.score, f8Before.score);
  });

  it("processes non-vocal UI chime / electronic pluck cleanly through 32 falsifiers and all vision renderers", async () => {
    const api = await loadPublicApi();
    const extractAudioProfile = requireExport(api, "extractAudioProfile");
    const analyzeSamples = requireExport(api, "analyzeSamples");
    const renderTextVision = requireExport(api, "renderTextVision");
    const renderSvgVision = requireExport(api, "renderSvgVision");
    const renderPngVision = requireExport(api, "renderPngVision");
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");

    const chime = genNonVocalChime(SR, 0.7);
    const profile = extractAudioProfile(chime, SR);
    const report = analyzeSamples(chime, SR, {
      label: "ui_chime",
      falsifiers: DEFAULT_FALSIFIERS,
    });

    assertAllNumericFinite(report.features, "chime.features");
    for (const f of report.falsifiers) {
      assert.ok(
        Number.isFinite(f.score) && f.score >= 0 && f.score <= 1,
        `Non-vocal chime falsifier ${f.id} score invalid: ${f.score}`
      );
    }

    const text = renderTextVision(profile, report, { mode: "compact" });
    assert.ok(text.trim().length > 0 && countLines(text) <= 32);

    const svg = renderSvgVision(profile, report);
    assertValidSvg(svg);

    const png = renderPngVision(profile, report);
    assertValidPng(png);
  });
});
