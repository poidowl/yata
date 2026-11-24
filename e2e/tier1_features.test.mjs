import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEMO_HTML_PATH,
  V01_FEATURE_KEYS,
  assertAllNumericFinite,
  assertValidPng,
  assertValidSvg,
  genHardClipped,
  genPiercingWhistle,
  genPleasantWarmTone,
  loadPublicApi,
  requireExport,
  runCli,
  withTempDir,
  writeWavFile,
} from "./_helpers.mjs";
import { DEFAULT_FALSIFIERS as REGISTRY } from "../src/falsifiers/index.mjs";
// Axis count is derived from the registry, never hardcoded (v0.11 shipped with 5 stale "32" asserts).
const N_AXES = REGISTRY.length;

const SR = 24000;

describe("Tier 1: Feature Coverage (Happy-Path E2E)", () => {
  it("WAV encode/decode roundtrip preserves mono and stereo channels[]", async () => {
    const api = await loadPublicApi();
    const encodeWavBuffer = requireExport(api, "encodeWavBuffer");
    const decodeWavBuffer = requireExport(api, "decodeWavBuffer");

    // Mono roundtrip
    const mono = genPleasantWarmTone(SR, 0.25, 11);
    const monoBuf = encodeWavBuffer(mono, SR);
    assert.ok(Buffer.isBuffer(monoBuf) || monoBuf instanceof Uint8Array);
    const monoDec = decodeWavBuffer(monoBuf);
    assert.equal(monoDec.sampleRate, SR);
    assert.equal(monoDec.numChannels, 1);
    assert.equal(monoDec.bitsPerSample, 16);
    assert.equal(monoDec.samples.length, mono.length);
    assert.ok(Array.isArray(monoDec.channels) && monoDec.channels.length === 1);
    for (let i = 0; i < mono.length; i += 17) {
      assert.ok(
        Math.abs(monoDec.samples[i] - mono[i]) < 1e-3,
        `Mono sample mismatch at ${i}`
      );
    }

    // Stereo roundtrip
    const left = genPleasantWarmTone(SR, 0.25, 12);
    const right = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) right[i] = -0.5 * left[i];
    const stereoBuf = encodeWavBuffer([left, right], SR);
    const stereoDec = decodeWavBuffer(stereoBuf);
    assert.equal(stereoDec.sampleRate, SR);
    assert.equal(stereoDec.numChannels, 2);
    assert.equal(stereoDec.samples.length, left.length);
    assert.ok(Array.isArray(stereoDec.channels) && stereoDec.channels.length === 2);
    assert.equal(stereoDec.channels[0].length, left.length);
    assert.equal(stereoDec.channels[1].length, right.length);
    for (let i = 0; i < left.length; i += 19) {
      assert.ok(Math.abs(stereoDec.channels[0][i] - left[i]) < 1e-3);
      assert.ok(Math.abs(stereoDec.channels[1][i] - right[i]) < 1e-3);
    }
  });

  it("CLI single-file analysis supports --format llm and --format json", async () => {
    await withTempDir((dir) => {
      const wavPath = path.join(dir, "warm.wav");
      writeWavFile(wavPath, genPleasantWarmTone(SR, 0.5), SR);

      const llmRes = runCli([wavPath, "--format", "llm"]);
      assert.equal(llmRes.status, 0, `stderr: ${llmRes.stderr}`);
      assert.ok(llmRes.stdout.trim().length > 0, "LLM output must be non-empty");
      assert.match(llmRes.stdout, /(SURVIVED_KAWAII_CANDIDATE|REJECTED_UNKAWAII)/);

      const jsonRes = runCli([wavPath, "--format", "json"]);
      assert.equal(jsonRes.status, 0, `stderr: ${jsonRes.stderr}`);
      const report = JSON.parse(jsonRes.stdout);
      assert.ok(
        report.verdict === "SURVIVED_KAWAII_CANDIDATE" ||
          report.verdict === "REJECTED_UNKAWAII"
      );
      assert.equal(typeof report.triggeredCount, "number");
      assert.equal(report.totalFalsifiers, N_AXES);
      assert.ok(report.features && typeof report.features === "object");
      assert.ok(Array.isArray(report.falsifiers) && report.falsifiers.length === N_AXES);
      assertAllNumericFinite(report.features, "cli.json.features");
    });
  });

  it("CLI --compare compares two WAVs in both llm and json formats", async () => {
    await withTempDir((dir) => {
      const aPath = path.join(dir, "a_warm.wav");
      const bPath = path.join(dir, "b_piercing.wav");
      writeWavFile(aPath, genPleasantWarmTone(SR, 0.5), SR);
      writeWavFile(bPath, genPiercingWhistle(SR, 0.5), SR);

      const llmRes = runCli(["--compare", aPath, bPath, "--format", "llm"]);
      assert.equal(llmRes.status, 0, `stderr: ${llmRes.stderr}`);
      assert.ok(llmRes.stdout.trim().length > 0);

      const jsonRes = runCli(["--compare", aPath, bPath, "--format", "json"]);
      assert.equal(jsonRes.status, 0, `stderr: ${jsonRes.stderr}`);
      const cmp = JSON.parse(jsonRes.stdout);
      assert.ok(cmp && typeof cmp === "object" && !Array.isArray(cmp));
      const cmpKeys = Object.keys(cmp);
      assert.ok(cmpKeys.length > 0, "--compare --format json must not return an empty object");
      assert.ok(
        cmpKeys.some((k) => /^(?:a|b)$|report|delta|diff|verdict|falsifier|compare|winner/i.test(k)),
        `--compare --format json missing expected comparison fields, got keys: ${cmpKeys.join(", ")}`
      );
    });
  });

  it("CLI --diff produces text diff as well as valid --svg and --png diff files", async () => {
    await withTempDir((dir) => {
      const aPath = path.join(dir, "a.wav");
      const bPath = path.join(dir, "b.wav");
      const svgOut = path.join(dir, "diff.svg");
      const pngOut = path.join(dir, "diff.png");
      writeWavFile(aPath, genPleasantWarmTone(SR, 0.5), SR);
      writeWavFile(bPath, genHardClipped(SR, 0.5), SR);

      const res = runCli(["--diff", aPath, bPath, "--svg", svgOut, "--png", pngOut]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.ok(res.stdout.trim().length > 0, "--diff must emit text diff");

      assert.ok(fs.existsSync(svgOut), "--diff --svg must write SVG file");
      assertValidSvg(fs.readFileSync(svgOut, "utf8"));

      assert.ok(fs.existsSync(pngOut), "--diff --png must write PNG file");
      assertValidPng(fs.readFileSync(pngOut));
    });
  });

  it("CLI --view supports micro, compact, and full modes with ascii and unicode charsets", async () => {
    await withTempDir((dir) => {
      const wavPath = path.join(dir, "sample.wav");
      writeWavFile(wavPath, genPleasantWarmTone(SR, 0.5), SR);

      const outputs = {};
      for (const mode of ["micro", "compact", "full"]) {
        for (const charset of ["ascii", "unicode"]) {
          const res = runCli([wavPath, "--view", mode, "--charset", charset]);
          assert.equal(
            res.status,
            0,
            `--view ${mode} --charset ${charset} failed: ${res.stderr}`
          );
          assert.ok(
            res.stdout.trim().length > 0,
            `--view ${mode} --charset ${charset} produced empty stdout`
          );
          outputs[`${mode}:${charset}`] = res.stdout;
        }
      }

      // Ensure modes actually change rendered output (not silently ignored)
      assert.notEqual(
        outputs["micro:ascii"],
        outputs["full:ascii"],
        "--view micro and --view full must produce distinct outputs"
      );
      assert.notEqual(
        outputs["compact:ascii"],
        outputs["compact:unicode"],
        "--charset ascii and --charset unicode must produce distinct outputs"
      );
      assert.ok(
        /[^\x00-\x7f]/.test(outputs["compact:unicode"]),
        "--charset unicode output should contain non-ASCII Unicode glyphs"
      );
    });
  });

  it("CLI --zoom supports auto and explicit t0..t1 ranges", async () => {
    await withTempDir((dir) => {
      const wavPath = path.join(dir, "sample.wav");
      writeWavFile(wavPath, genPleasantWarmTone(SR, 0.6), SR);

      const baseRes = runCli([wavPath, "--view", "compact"]);
      assert.equal(baseRes.status, 0, `stderr: ${baseRes.stderr}`);

      const autoRes = runCli([wavPath, "--view", "compact", "--zoom", "auto"]);
      assert.equal(autoRes.status, 0, `stderr: ${autoRes.stderr}`);
      assert.ok(autoRes.stdout.trim().length > 0);

      const rangeRes = runCli([wavPath, "--view", "compact", "--zoom", "0.1..0.4"]);
      assert.equal(rangeRes.status, 0, `stderr: ${rangeRes.stderr}`);
      assert.ok(rangeRes.stdout.trim().length > 0);
      assert.notEqual(
        rangeRes.stdout,
        baseRes.stdout,
        "--zoom 0.1..0.4 should produce zoomed view distinct from unzoomed --view compact"
      );
    });
  });

  it("CLI --svg and --png produce structurally valid vector and raster vision files", async () => {
    await withTempDir((dir) => {
      const wavPath = path.join(dir, "sample.wav");
      const svgOut = path.join(dir, "vision.svg");
      const pngOut = path.join(dir, "vision.png");
      writeWavFile(wavPath, genPleasantWarmTone(SR, 0.5), SR);

      const res = runCli([wavPath, "--svg", svgOut, "--png", pngOut]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.ok(fs.existsSync(svgOut), "SVG output file missing");
      assert.ok(fs.existsSync(pngOut), "PNG output file missing");
      assertValidSvg(fs.readFileSync(svgOut, "utf8"));
      assertValidPng(fs.readFileSync(pngOut));
    });
  });

  it("CLI --discover runs in both llm and json formats", () => {
    const llmRes = runCli(["--discover", "--format", "llm"]);
    assert.equal(llmRes.status, 0, `stderr: ${llmRes.stderr}`);
    assert.ok(llmRes.stdout.trim().length > 0);

    const jsonRes = runCli(["--discover", "--format", "json"]);
    assert.equal(jsonRes.status, 0, `stderr: ${jsonRes.stderr}`);
    const parsed = JSON.parse(jsonRes.stdout);
    assert.ok(parsed && typeof parsed === "object");
    const keys = Array.isArray(parsed) ? parsed : Object.keys(parsed);
    assert.ok(keys.length > 0, "--discover --format json must not return an empty structure");
    if (!Array.isArray(parsed)) {
      assert.ok(
        keys.some((k) =>
          /summary|corpus|positive|counterexample|slip|caught|falsifier|dossier|results|items/i.test(k)
        ),
        `--discover --format json missing expected discovery fields, got keys: ${keys.join(", ")}`
      );
    }
  });

  it("CLI --list-falsifiers lists all registry falsifier IDs F1_..FN_ in llm and json", () => {
    const llmRes = runCli(["--list-falsifiers", "--format", "llm"]);
    assert.equal(llmRes.status, 0, `stderr: ${llmRes.stderr}`);
    for (let i = 1; i <= N_AXES; i++) {
      assert.match(
        llmRes.stdout,
        new RegExp(`\\bF${i}_[A-Z0-9_]+\\b`),
        `Missing F${i}_* in --list-falsifiers --format llm`
      );
    }

    const jsonRes = runCli(["--list-falsifiers", "--format", "json"]);
    assert.equal(jsonRes.status, 0, `stderr: ${jsonRes.stderr}`);
    const parsed = JSON.parse(jsonRes.stdout);
    const list = Array.isArray(parsed) ? parsed : parsed.falsifiers;
    assert.ok(Array.isArray(list), "JSON --list-falsifiers must contain an array");
    assert.equal(list.length, N_AXES);
    const ids = list.map((item) => (typeof item === "string" ? item : item.id));
    for (let i = 1; i <= N_AXES; i++) {
      assert.ok(
        ids.some((id) => typeof id === "string" && id.startsWith(`F${i}_`)),
        `Missing F${i}_* in --list-falsifiers --format json`
      );
    }
  });

  it("registry falsifiers public API smoke: registry sizes, v0.1+ features, bounded scores, verdicts", async () => {
    const api = await loadPublicApi();
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");
    const ORIGINAL_6_FALSIFIERS = requireExport(api, "ORIGINAL_6_FALSIFIERS");
    const extractFeatures = requireExport(api, "extractFeatures");
    const analyzeSamples = requireExport(api, "analyzeSamples");

    assert.equal(DEFAULT_FALSIFIERS.length, N_AXES);
    assert.equal(ORIGINAL_6_FALSIFIERS.length, 6);
    for (let i = 1; i <= N_AXES; i++) {
      assert.ok(
        DEFAULT_FALSIFIERS.some((f) => f.id.startsWith(`F${i}_`)),
        `DEFAULT_FALSIFIERS missing F${i}_*`
      );
    }

    const pleasant = genPleasantWarmTone(SR, 0.6);
    const feats = extractFeatures(pleasant, SR);
    for (const k of V01_FEATURE_KEYS) {
      assert.equal(typeof feats[k], "number", `Missing v0.1 feature key: ${k}`);
    }
    assert.ok(
      Object.keys(feats).length > V01_FEATURE_KEYS.length,
      "extractFeatures must include new F7-F32 scalar keys beyond v0.1"
    );
    assertAllNumericFinite(feats, "extractFeatures(pleasant)");

    const cleanReport = analyzeSamples(pleasant, SR, {
      label: "pleasant",
      falsifiers: DEFAULT_FALSIFIERS,
    });
    assert.ok(
      cleanReport.verdict === "SURVIVED_KAWAII_CANDIDATE" ||
        cleanReport.verdict === "REJECTED_UNKAWAII"
    );
    assert.equal(cleanReport.totalFalsifiers, N_AXES);
    for (const f of cleanReport.falsifiers) {
      assert.ok(
        Number.isFinite(f.score) && f.score >= 0 && f.score <= 1,
        `Falsifier ${f.id} score out of [0,1]: ${f.score}`
      );
    }

    const badReport = analyzeSamples(genHardClipped(SR, 0.6), SR, {
      label: "clipped",
      falsifiers: DEFAULT_FALSIFIERS,
    });
    assert.equal(badReport.verdict, "REJECTED_UNKAWAII");
    assert.ok(badReport.triggeredCount >= 1);
  });

  it("bench/yata_audition_demo.html exists and is valid standalone HTML", () => {
    assert.ok(fs.existsSync(DEMO_HTML_PATH), `Missing demo HTML at ${DEMO_HTML_PATH}`);
    const html = fs.readFileSync(DEMO_HTML_PATH, "utf8");
    assert.ok(html.length > 500, "Demo HTML appears unexpectedly empty");
    assert.match(html, /<!doctype\s+html>/i);
    assert.match(html, /<\/html>/i);
  });
});
