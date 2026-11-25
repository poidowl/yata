import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractFeatures,
  extractAudioProfile,
  computeSoundKind,
  computePeacockProfile,
  analyzeSamples,
  renderTextVision,
} from "../unkawaii_detector.mjs";

function makeSustainedMusic(sr = 24000, sec = 2.0) {
  const n = Math.floor(sr * sec);
  const out = new Float32Array(n);
  // 4 sustained cello-like musical notes (C3 -> G3 -> E3 -> C3) with stable plateaus
  const notes = [130.81, 196.0, 164.81, 130.81];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = notes[Math.min(notes.length - 1, Math.floor((t / sec) * notes.length))];
    const env = Math.min(1, t / 0.05) * Math.min(1, (sec - t) / 0.12);
    ph += (2 * Math.PI * f0) / sr;
    out[i] =
      env *
      (0.42 * Math.sin(ph) + 0.24 * Math.sin(2 * ph + 0.3) + 0.12 * Math.sin(3 * ph + 0.7) + 0.05 * Math.sin(4 * ph));
  }
  return out;
}

function makeSoftWhisper(sr = 24000, sec = 1.6) {
  const n = Math.floor(sr * sec);
  const out = new Float32Array(n);
  let s = 42;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const mod = 0.5 + 0.5 * Math.sin(2 * Math.PI * 5.0 * t);
    const env = Math.min(1, t / 0.08) * Math.min(1, (sec - t) / 0.15) * (0.25 + 0.75 * mod);
    const x = rand();
    lp = 0.35 * lp + 0.65 * x;
    out[i] = env * (x - 0.5 * lp) * 0.28;
  }
  return out;
}

describe("v0.12: Sound Kind & Peacock 5-Feather Non-Veto Lens", () => {
  it("handles silence gracefully with finite zero scores and soundKind='silent'", () => {
    const sr = 24000;
    const silence = new Float32Array(sr);
    const f = extractFeatures(silence, sr);
    const prof = extractAudioProfile(silence, sr);
    const kind = computeSoundKind(prof.frames, f);
    const pp = computePeacockProfile(f, kind);

    assert.equal(kind.soundKind, "silent");
    assert.equal(kind.musicalityScore, 0);
    assert.equal(pp.dominantFeather, "silent");
    for (const k of ["silk", "intimacy", "dandy", "fragile", "alive"]) {
      assert.equal(pp[k], 0);
    }
  });

  it("distinguishes sustained musical notes ('music') from soft whisper ('whisper')", () => {
    const sr = 24000;
    const music = makeSustainedMusic(sr, 2.0);
    const fM = extractFeatures(music, sr);
    const pM = extractAudioProfile(music, sr);
    const kM = computeSoundKind(pM.frames, fM);
    assert.equal(kM.soundKind, "music", `Expected music, got ${JSON.stringify(kM)}`);
    assert.ok(kM.musicalityScore >= 0.55);

    const whisper = makeSoftWhisper(sr, 1.6);
    const fW = extractFeatures(whisper, sr);
    const pW = extractAudioProfile(whisper, sr);
    const kW = computeSoundKind(pW.frames, fW);
    assert.equal(kW.soundKind, "whisper", `Expected whisper, got ${JSON.stringify(kW)}`);
  });

  it("maps orthogonal vocal charms onto distinct Peacock feathers without vetoing", () => {
    const silkVoice = computePeacockProfile({
      activeFrameCount: 120,
      peak: 0.5,
      mpsRoughToSpeechRatio: 0.11,
      meanTop1PeakShare: 0.78,
      hfBandWaveKurt: 3.05,
      proximityBoomRatio: 0.82,
      pauseDurCv: 1.5,
      mpsRoughness30_150: 0.013,
      medianF0: 218,
      bodyBand80_200Db: -38,
      highAirRatio: 0.03,
      voicedRatio: 0.85,
      activeRmsCv: 0.4,
      respiratoryScore: 0.8,
      directnessScore: 0.75,
      sanitizationScore: 0.0,
    });
    assert.ok(silkVoice.silk >= 0.85, `Expected high silk, got ${silkVoice.silk}`);
    assert.ok(silkVoice.intimacy >= 0.8, `Expected high intimacy, got ${silkVoice.intimacy}`);

    const dandyVoice = computePeacockProfile({
      activeFrameCount: 120,
      peak: 0.5,
      mpsRoughToSpeechRatio: 1.1,
      meanTop1PeakShare: 0.65,
      hfBandWaveKurt: 3.1,
      proximityBoomRatio: 0.55,
      pauseDurCv: 0.8,
      mpsRoughness30_150: 0.09,
      medianF0: 115,
      bodyBand80_200Db: -26,
      highAirRatio: 0.01,
      voicedRatio: 0.88,
      activeRmsCv: 0.35,
      respiratoryScore: 0.85,
      directnessScore: 0.55,
      sanitizationScore: 0.0,
    });
    assert.ok(dandyVoice.dandy >= 0.9, `Expected high dandy, got ${dandyVoice.dandy}`);
    assert.ok(dandyVoice.dandy > silkVoice.dandy);

    const fragileVoice = computePeacockProfile({
      activeFrameCount: 120,
      peak: 0.3,
      mpsRoughToSpeechRatio: 0.6,
      meanTop1PeakShare: 0.55,
      hfBandWaveKurt: 3.0,
      proximityBoomRatio: 0.5,
      pauseDurCv: 0.6,
      mpsRoughness30_150: 0.05,
      medianF0: 240,
      bodyBand80_200Db: -52,
      highAirRatio: 0.25,
      voicedRatio: 0.15,
      activeRmsCv: 0.7,
      respiratoryScore: 0.9,
      directnessScore: 0.6,
      sanitizationScore: 0.0,
    });
    assert.ok(fragileVoice.fragile >= 0.85, `Expected high fragile, got ${fragileVoice.fragile}`);
  });

  it("surfaces KIND and PEACOCK in compact/full text vision within line budgets", () => {
    const sr = 24000;
    const sig = makeSustainedMusic(sr, 1.5);
    const prof = extractAudioProfile(sig, sr);
    const rep = analyzeSamples(sig, sr, { label: "cello_smoke" });
    const compact = renderTextVision(prof, rep, { mode: "compact" });
    const full = renderTextVision(prof, rep, { mode: "full" });

    assert.ok(compact.split("\n").length <= 32, "Compact mode must remain <= 32 lines");
    assert.match(compact, /KIND=music/);
    assert.match(compact, /PEACOCK:/);
    assert.match(full, /PEACOCK:/);
  });
});
