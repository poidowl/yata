import test from "node:test";
import assert from "node:assert/strict";
import {
  computeBicoherence,
  computeScatteringTexture,
  computePermutationEntropy,
  extractFeatures,
} from "../unkawaii_detector.mjs";

test("computeBicoherence distinguishes phase-coupled harmonics from white noise and silence", () => {
  const sr = 24000;
  const dur = 1.0;
  const n = Math.floor(sr * dur);
  const hopSec = 0.01;
  const nFrames = Math.floor(dur / hopSec);
  const f0 = 220;

  const coupled = new Float32Array(n);
  const noise = new Float32Array(n);
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // Phase-locked harmonics with fixed quadratic coupling
    coupled[i] =
      0.5 * Math.sin(2 * Math.PI * f0 * t) +
      0.35 * Math.sin(2 * Math.PI * 2 * f0 * t + 0.3) +
      0.25 * Math.sin(2 * Math.PI * 3 * f0 * t + 0.6) +
      0.15 * Math.sin(2 * Math.PI * 4 * f0 * t + 0.9);
    noise[i] = 0.5 * rand();
  }

  const frames = [];
  for (let i = 0; i < nFrames; i++) {
    frames.push({ timeSec: i * hopSec, voiced: true, f0, rms: 0.3 });
  }

  const resCoupled = computeBicoherence(coupled, sr, frames, hopSec);
  const resNoise = computeBicoherence(noise, sr, frames, hopSec);
  const resSilent = computeBicoherence(new Float32Array(n), sr, frames, hopSec);

  assert.ok(resCoupled.bicoherenceMean > 0.7, `expected coupled > 0.7, got ${resCoupled.bicoherenceMean}`);
  assert.ok(resNoise.bicoherenceMean < 0.35, `expected noise < 0.35, got ${resNoise.bicoherenceMean}`);
  assert.equal(resSilent.bicoherenceMean, 0);
});

test("computeScatteringTexture separates smooth 6 Hz modulation from grainy 30 Hz modulation", () => {
  const hopSec = 0.01; // 100 Hz frame rate
  const F = 128;
  const nBands = 48;
  const frames = Array.from({ length: F }, (_, i) => ({ timeSec: i * hopSec, rms: 0.2 }));

  const makeMat = (modHz) => {
    const mat = [];
    for (let i = 0; i < F; i++) {
      const row = new Float32Array(nBands);
      const t = i * hopSec;
      const envDb = -20 + 8 * Math.sin(2 * Math.PI * modHz * t);
      for (let b = 0; b < nBands; b++) row[b] = envDb;
      mat.push(row);
    }
    return mat;
  };

  const smooth = computeScatteringTexture(makeMat(6), frames, hopSec);
  const grainy = computeScatteringTexture(makeMat(30), frames, hopSec);
  const empty = computeScatteringTexture([], [], hopSec);

  assert.ok(smooth.scatteringSilkRatio > 0.85, `expected smooth silkRatio > 0.85, got ${smooth.scatteringSilkRatio}`);
  assert.ok(smooth.scatteringCoMod > 0.9, `expected smooth coMod > 0.9, got ${smooth.scatteringCoMod}`);
  assert.ok(grainy.scatteringSilkRatio < 0.2, `expected grainy silkRatio < 0.2, got ${grainy.scatteringSilkRatio}`);
  assert.equal(empty.scatteringSilkRatio, 0);
  assert.equal(empty.scatteringCoMod, 0);
});

test("computePermutationEntropy orders monotonic < smooth sine < white noise", () => {
  const ramp = Array.from({ length: 100 }, (_, i) => i * 0.5);
  const sine = Array.from({ length: 100 }, (_, i) => Math.sin(i * 0.35));
  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const white = Array.from({ length: 200 }, () => rand());

  const hRamp = computePermutationEntropy(ramp);
  const hSine = computePermutationEntropy(sine);
  const hWhite = computePermutationEntropy(white);
  const hShort = computePermutationEntropy([1, 2, 3]);

  assert.equal(hRamp, 0);
  assert.equal(hShort, 0);
  assert.ok(hSine > 0.3 && hSine < 0.8, `expected sine PE in (0.3, 0.8), got ${hSine}`);
  assert.ok(hWhite > 0.9, `expected white noise PE > 0.9, got ${hWhite}`);
});

test("extractFeatures exposes finite v0.12 math lens fields across edge cases", () => {
  const sr = 24000;
  const silence = new Float32Array(sr);
  const shortClip = new Float32Array(240);
  const voice = new Float32Array(sr);
  for (let i = 0; i < sr; i++) {
    const t = i / sr;
    const f0 = 210 + 18 * Math.sin(2 * Math.PI * 3.5 * t);
    const env = 0.5 + 0.4 * Math.sin(2 * Math.PI * 5 * t);
    voice[i] = env * (0.5 * Math.sin(2 * Math.PI * f0 * t) + 0.3 * Math.sin(2 * Math.PI * 2 * f0 * t));
  }

  const keys = [
    "bicoherenceMean",
    "bicoherenceStd",
    "scatteringSilkRatio",
    "scatteringCoMod",
    "f0PermEntropy",
    "rmsPermEntropy",
  ];

  for (const sig of [silence, shortClip, voice]) {
    const f = extractFeatures(sig, sr);
    for (const k of keys) {
      assert.equal(typeof f[k], "number", `expected number for ${k}`);
      assert.ok(Number.isFinite(f[k]), `expected finite number for ${k}, got ${f[k]}`);
      assert.ok(f[k] >= 0 && f[k] <= 1, `expected ${k} in [0, 1], got ${f[k]}`);
    }
  }
});
