import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as yata from "../unkawaii_detector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "unkawaii_detector.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 20000,
  });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yata-cli-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("M4A: Root Facade Exports & CLI", () => {
  it("re-exports all v0.1 and v0.2 public API symbols", () => {
    const expected = [
      // v0.1
      "decodeWavBuffer",
      "extractFeatures",
      "DEFAULT_FALSIFIERS",
      "analyzeSamples",
      "compareReports",
      "formatForLLM",
      "formatCompareForLLM",
      // v0.2
      "encodeWavBuffer",
      "extractAudioProfile",
      "ORIGINAL_6_FALSIFIERS",
      "createFalsifiers",
      "renderTextVision",
      "renderTextDiff",
      "renderSvgVision",
      "renderSvgDiff",
      "renderPngVision",
      "renderPngDiff",
      "buildCorpus",
      "runDiscoveryLoop",
    ];
    for (const name of expected) {
      assert.ok(name in yata && yata[name] !== undefined, `Missing export: ${name}`);
    }
    assert.equal(yata.ORIGINAL_6_FALSIFIERS.length, 6);
    assert.equal(yata.DEFAULT_FALSIFIERS.length, 36);
  });

  it("supports single-file analysis with --format, --falsifiers, --view, --zoom, --charset, --svg, --png", () => {
    const corpus = yata.buildCorpus({ sampleRate: 24000, seed: 2026 });
    const pos = corpus.positives[0];
    const click = corpus.counterexamples.find((x) => x.id === "ce_F9");

    withTempDir((dir) => {
      const posPath = path.join(dir, "pos.wav");
      const clickPath = path.join(dir, "click.wav");
      const svgOut = path.join(dir, "vision.svg");
      const pngOut = path.join(dir, "vision.png");

      fs.writeFileSync(posPath, yata.encodeWavBuffer(pos.samples, pos.sampleRate));
      fs.writeFileSync(clickPath, yata.encodeWavBuffer(click.samples, click.sampleRate));

      const llmRes = runCli([posPath]);
      assert.equal(llmRes.status, 0, llmRes.stderr);
      assert.match(llmRes.stdout, /SURVIVED_KAWAII_CANDIDATE/);

      const jsonRes = runCli([posPath, "--format", "json"]);
      assert.equal(jsonRes.status, 0, jsonRes.stderr);
      const parsed = JSON.parse(jsonRes.stdout);
      assert.equal(parsed.verdict, "SURVIVED_KAWAII_CANDIDATE");
      assert.equal(parsed.totalFalsifiers, 36);

      const coreRes = runCli([posPath, "--falsifiers", "core", "--format", "json"]);
      assert.equal(coreRes.status, 0, coreRes.stderr);
      assert.equal(JSON.parse(coreRes.stdout).totalFalsifiers, 6);

      const viewRes = runCli([clickPath, "--view", "compact", "--zoom", "auto", "--charset", "unicode", "--svg", svgOut, "--png", pngOut]);
      assert.equal(viewRes.status, 0, viewRes.stderr);
      assert.ok(/[^\x00-\x7f]/.test(viewRes.stdout));
      assert.ok(fs.existsSync(svgOut) && fs.readFileSync(svgOut, "utf8").includes("<svg"));
      const pngBuf = fs.readFileSync(pngOut);
      assert.equal(pngBuf[0], 0x89);
      assert.equal(pngBuf.toString("ascii", 1, 4), "PNG");
    });
  });

  it("supports --compare and --diff with --view, --svg, and --png", () => {
    const corpus = yata.buildCorpus({ sampleRate: 24000, seed: 2026 });
    const a = corpus.positives[0];
    const b = corpus.counterexamples.find((x) => x.id === "ce_F8");

    withTempDir((dir) => {
      const aPath = path.join(dir, "a.wav");
      const bPath = path.join(dir, "b.wav");
      const svgOut = path.join(dir, "diff.svg");
      const pngOut = path.join(dir, "diff.png");
      fs.writeFileSync(aPath, yata.encodeWavBuffer(a.samples, a.sampleRate));
      fs.writeFileSync(bPath, yata.encodeWavBuffer(b.samples, b.sampleRate));

      const cmpRes = runCli(["--compare", aPath, bPath, "--view", "compact"]);
      assert.equal(cmpRes.status, 0, cmpRes.stderr);
      assert.match(cmpRes.stdout, /UNKAWAII COMPARE/);

      const cmpJson = runCli(["--compare", aPath, bPath, "--format", "json"]);
      assert.equal(cmpJson.status, 0, cmpJson.stderr);
      const parsed = JSON.parse(cmpJson.stdout);
      assert.equal(parsed.deltas.length, 36);

      const diffRes = runCli(["--diff", aPath, bPath, "--svg", svgOut, "--png", pngOut]);
      assert.equal(diffRes.status, 0, diffRes.stderr);
      assert.ok(diffRes.stdout.trim().length > 0);
      assert.ok(fs.existsSync(svgOut));
      assert.ok(fs.existsSync(pngOut));
    });
  });

  it("supports --list-falsifiers and --discover in llm and json formats", () => {
    const listLlm = runCli(["--list-falsifiers"]);
    assert.equal(listLlm.status, 0, listLlm.stderr);
    assert.match(listLlm.stdout, /F1_HARSH_EDGE/);
    assert.match(listLlm.stdout, /F36_COARTICULATION_SEAM/);

    const listJson = runCli(["--list-falsifiers", "--format", "json"]);
    assert.equal(listJson.status, 0, listJson.stderr);
    assert.equal(JSON.parse(listJson.stdout).length, 36);

    const discLlm = runCli(["--discover"]);
    assert.equal(discLlm.status, 0, discLlm.stderr);
    assert.match(discLlm.stdout, /UNKAWAII DISCOVERY LOOP/);

    const discJson = runCli(["--discover", "--format", "json"]);
    assert.equal(discJson.status, 0, discJson.stderr);
    const disc = JSON.parse(discJson.stdout);
    assert.equal(disc.positivesSurvived, disc.positivesTotal);
    assert.equal(disc.targetHits, 26);
  });

  it("exits non-zero with diagnostic stderr on unknown flags, missing files, and corrupt WAVs", () => {
    const badFlag = runCli(["--does-not-exist"]);
    assert.notEqual(badFlag.status, 0);
    assert.ok(badFlag.stderr.trim().length > 0);

    withTempDir((dir) => {
      const missing = runCli([path.join(dir, "missing.wav")]);
      assert.notEqual(missing.status, 0);
      assert.ok(missing.stderr.trim().length > 0);

      const corruptPath = path.join(dir, "corrupt.wav");
      fs.writeFileSync(corruptPath, Buffer.from("CORRUPT_NOT_WAV"));
      const corrupt = runCli([corruptPath]);
      assert.notEqual(corrupt.status, 0);
      assert.ok(corrupt.stderr.trim().length > 0);
    });
  });
});
