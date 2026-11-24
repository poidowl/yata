import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ORIGINAL_6_FALSIFIERS,
  DEFAULT_FALSIFIERS,
  createFalsifiers,
} from "../src/falsifiers/index.mjs";
import {
  analyzeSamples,
  compareReports,
  formatForLLM,
  formatCompareForLLM,
} from "../src/report.mjs";

const SR = 24000;

function mulberry32(seed = 2026) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothEnv(t, dur, atk = 0.07, rel = 0.16) {
  let e = 1;
  if (t < atk && atk > 0) e *= 0.5 - 0.5 * Math.cos((Math.PI * t) / atk);
  const rem = dur - t;
  if (rem < rel && rel > 0) e *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, rem)) / rel);
  return e;
}

/**
 * Clean pleasant warm voice-like tone (organic pitch arc, warm harmonics, gentle breath, soft tail).
 */
function genWarmVoice(dur = 0.65, seed = 101) {
  const n = Math.round(SR * dur);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  let phase = 0;
  let breath = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const u = t / dur;
    const env = smoothEnv(t, dur, 0.08, 0.17);
    const f0 = 325 + 38 * Math.sin(Math.PI * u) - 16 * u + 1.8 * Math.sin(2 * Math.PI * 1.9 * t);
    phase += (2 * Math.PI * f0) / SR;
    // Slight harmonic evolution coupled with env so timbre breathes naturally
    const h2 = 0.28 + 0.08 * env;
    const h3 = 0.11 + 0.04 * env;
    const h4 = 0.045 * env;
    const sig =
      0.62 * Math.sin(phase) +
      h2 * Math.sin(2 * phase + 0.1) +
      h3 * Math.sin(3 * phase + 0.2) +
      h4 * Math.sin(4 * phase + 0.3);
    breath = 0.9 * breath + 0.1 * (rand() * 2 - 1);
    out[i] = 0.42 * env * (sig + 0.018 * breath);
  }
  return out;
}

/**
 * Gentle sasayaki (breathy whisper-like) positive control: soft voiced core + warm breathy air.
 */
function genSasayakiWhisper(dur = 0.65, seed = 202) {
  const n = Math.round(SR * dur);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  let phase = 0;
  let lp1 = 0;
  let lp2 = 0;
  let bp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const u = t / dur;
    const env = smoothEnv(t, dur, 0.1, 0.18);
    const f0 = 310 + 30 * Math.sin(Math.PI * u) - 15 * u;
    phase += (2 * Math.PI * f0) / SR;
    // Gentle fundamental + warm 2nd harmonic
    const voice = 0.58 * Math.sin(phase) + 0.22 * Math.sin(2 * phase + 0.2) + 0.08 * Math.sin(3 * phase);
    // Soft band-shaped breathiness (mid-high broadband noise, NOT harmonic strain)
    const w = rand() * 2 - 1;
    lp1 = 0.72 * lp1 + 0.28 * w;
    lp2 = 0.94 * lp2 + 0.06 * w;
    bp = lp1 - lp2;
    out[i] = 0.36 * env * (0.75 * voice + 0.35 * bp);
  }
  return out;
}

/**
 * Clean warm UI chime / celesta bell (decays smoothly, gentle harmonic rolloff).
 */
function genWarmChime(dur = 0.7, seed = 303) {
  const n = Math.round(SR * dur);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const u = t / dur;
    const atk = t < 0.04 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.04) : 1;
    const decay = Math.exp(-3.2 * t);
    const env = atk * decay * (t > dur - 0.08 ? (dur - t) / 0.08 : 1);
    const f0 = 523.25 * (1 + 0.015 * Math.exp(-6 * t) - 0.01 * u);
    phase += (2 * Math.PI * f0) / SR;
    const h2 = 0.32 * Math.exp(-5 * t);
    const h3 = 0.14 * Math.exp(-8 * t);
    const h4 = 0.06 * Math.exp(-11 * t);
    const micro = 0.005 * (rand() * 2 - 1);
    out[i] =
      0.45 *
      env *
      (0.65 * Math.sin(phase) + h2 * Math.sin(2 * phase) + h3 * Math.sin(3 * phase) + h4 * Math.sin(4 * phase) + micro);
  }
  return out;
}

function getFalsifierResult(report, id) {
  const found = report.falsifiers.find((f) => f.id === id);
  assert.ok(found, `Missing falsifier result for ${id}`);
  return found;
}

describe("M2: 32-Axis Falsifier Registry & Report Engine", () => {
  it("exports ORIGINAL_6_FALSIFIERS (6) and DEFAULT_FALSIFIERS (32) in exact F1..F32 order with unique IDs", () => {
    assert.equal(ORIGINAL_6_FALSIFIERS.length, 6);
    assert.equal(DEFAULT_FALSIFIERS.length, 32);

    const expectedCoreIds = [
      "F1_HARSH_EDGE",
      "F2_PURE_ROBOT",
      "F3_PURE_NOISE",
      "F4_NO_COMMON_CAUSE",
      "F5_ABRUPT_TAIL",
      "F6_PHYSICAL_GLITCH",
    ];
    assert.deepEqual(
      ORIGINAL_6_FALSIFIERS.map((f) => f.id),
      expectedCoreIds
    );

    const seen = new Set();
    for (let i = 0; i < 32; i++) {
      const f = DEFAULT_FALSIFIERS[i];
      assert.ok(f.id.startsWith(`F${i + 1}_`), `Index ${i} expected F${i + 1}_*, got ${f.id}`);
      assert.equal(typeof f.domain, "string");
      assert.equal(typeof f.name, "string");
      assert.equal(typeof f.detect, "function");
      assert.ok(!seen.has(f.id), `Duplicate falsifier ID: ${f.id}`);
      seen.add(f.id);
    }
  });

  it("clean pleasant positive controls survive 0/32 (warm voice, sasayaki whisper, warm chime, clean stereo)", () => {
    const positives = [
      { label: "warm_voice", samples: genWarmVoice(0.65, 101) },
      { label: "sasayaki_whisper", samples: genSasayakiWhisper(0.65, 202) },
      { label: "warm_chime", samples: genWarmChime(0.7, 303) },
    ];

    for (const item of positives) {
      const rep = analyzeSamples(item.samples, SR, { label: item.label });
      const triggered = rep.falsifiers.filter((f) => f.triggered);
      assert.equal(
        rep.verdict,
        "SURVIVED_KAWAII_CANDIDATE",
        `${item.label} should survive 0/32, but triggered: ${triggered
          .map((t) => `${t.id}(score=${t.score}, ${t.evidence})`)
          .join("; ")}`
      );
      assert.equal(rep.triggeredCount, 0);
      assert.equal(rep.totalFalsifiers, 32);
      for (const f of rep.falsifiers) {
        assert.ok(Number.isFinite(f.score) && f.score >= 0 && f.score <= 1, `${f.id} score invalid`);
      }
    }

    // Clean stereo (correlated L/R with slight natural width)
    const left = genWarmVoice(0.65, 101);
    const right = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      right[i] = 0.94 * left[Math.max(0, i - 3)];
    }
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) mono[i] = 0.5 * (left[i] + right[i]);
    const stereoRep = analyzeSamples(mono, SR, { label: "clean_stereo", channels: [left, right] });
    assert.equal(stereoRep.verdict, "SURVIVED_KAWAII_CANDIDATE");
    assert.equal(getFalsifierResult(stereoRep, "F30_STEREO_PHASE_DISCOMFORT").triggered, false);
  });

  it("triggers Core F1..F6 on targeted synthetic signals", () => {
    // F1_HARSH_EDGE: instant sharp attack + high-freq buzz
    {
      const n = Math.round(SR * 0.5);
      const s = new Float32Array(n);
      for (let i = 2400; i < n; i++) {
        const t = i / SR;
        const env = i > n - 2400 ? (n - i) / 2400 : 1;
        s[i] = 0.5 * env * (Math.sin(2 * Math.PI * 300 * t) + 0.8 * Math.sin(2 * Math.PI * 4500 * t));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F1" });
      assert.equal(getFalsifierResult(rep, "F1_HARSH_EDGE").triggered, true);
    }

    // F2_PURE_ROBOT: perfectly rigid constant F0 and amplitude (zero jitter/shimmer)
    {
      const n = Math.round(SR * 0.6);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        s[i] = 0.4 * (Math.sin(2 * Math.PI * 300 * t) + 0.3 * Math.sin(2 * Math.PI * 600 * t));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F2" });
      assert.equal(getFalsifierResult(rep, "F2_PURE_ROBOT").triggered, true);
    }

    // F3_PURE_NOISE: pure unstructured white noise
    {
      const rand = mulberry32(3);
      const n = Math.round(SR * 0.5);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = 0.4 * (rand() * 2 - 1);
      const rep = analyzeSamples(s, SR, { label: "ce_F3" });
      assert.equal(getFalsifierResult(rep, "F3_PURE_NOISE").triggered, true);
    }

    // F4_NO_COMMON_CAUSE: uncoupled amplitude vs frequency/HF (orthogonal modulations)
    {
      const n = Math.round(SR * 0.8);
      const s = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = 0.5 + 0.45 * Math.sin(2 * Math.PI * 1.25 * t);
        const f0 = 320 + 40 * Math.cos(2 * Math.PI * 2.5 * t);
        phase += (2 * Math.PI * f0) / SR;
        s[i] = 0.4 * env * (Math.sin(phase) + 0.25 * Math.sin(2 * phase));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F4" });
      assert.equal(getFalsifierResult(rep, "F4_NO_COMMON_CAUSE").triggered, true);
    }

    // F5_ABRUPT_TAIL: hard cut-off at end (zero release)
    {
      const n = Math.round(SR * 0.6);
      const s = new Float32Array(n);
      const cut = Math.round(SR * 0.45);
      for (let i = 0; i < cut; i++) {
        const t = i / SR;
        const atk = t < 0.08 ? t / 0.08 : 1;
        s[i] = 0.4 * atk * Math.sin(2 * Math.PI * 330 * t);
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F5" });
      assert.equal(getFalsifierResult(rep, "F5_ABRUPT_TAIL").triggered, true);
    }

    // F6_PHYSICAL_GLITCH: full-scale clipping >= 0.995
    {
      const n = Math.round(SR * 0.5);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        s[i] = Math.max(-1, Math.min(1, 3.0 * Math.sin(2 * Math.PI * 300 * t)));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F6" });
      assert.equal(getFalsifierResult(rep, "F6_PHYSICAL_GLITCH").triggered, true);
    }
  });

  it("triggers Waveform & Dynamics F7..F11 on targeted synthetic signals", () => {
    // F7_FLAT_TOP_CLIPPING: sub-full-scale hard clip scaled to 0.7 (slips past F6!)
    {
      const base = genWarmVoice(0.6, 7);
      const s = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) {
        s[i] = 0.7 * Math.max(-0.22, Math.min(0.22, base[i])) / 0.22;
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F7" });
      assert.equal(getFalsifierResult(rep, "F7_FLAT_TOP_CLIPPING").triggered, true);
    }

    // F8_DC_OFFSET_BIAS: steady +0.30 DC bias
    {
      const base = genWarmVoice(0.6, 8);
      const s = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) s[i] = base[i] * 0.5 + 0.3;
      const rep = analyzeSamples(s, SR, { label: "ce_F8" });
      assert.equal(getFalsifierResult(rep, "F8_DC_OFFSET_BIAS").triggered, true);
    }

    // F9_MICRO_CLICK_DROPOUT: localized sample click + 15ms buffer dropout
    {
      const sClick = genWarmVoice(0.6, 9);
      const idx = Math.round(SR * 0.3);
      sClick[idx] = 0.8;
      sClick[idx + 1] = -0.75;
      const repClick = analyzeSamples(sClick, SR, { label: "ce_F9_click" });
      assert.equal(getFalsifierResult(repClick, "F9_MICRO_CLICK_DROPOUT").triggered, true);

      const sDrop = genWarmVoice(0.6, 99);
      const dStart = Math.round(SR * 0.28);
      const dEnd = Math.round(SR * 0.30); // 20ms zero dropout
      for (let i = dStart; i < dEnd; i++) sDrop[i] = 0;
      const repDrop = analyzeSamples(sDrop, SR, { label: "ce_F9_drop" });
      assert.equal(getFalsifierResult(repDrop, "F9_MICRO_CLICK_DROPOUT").triggered, true);
    }

    // F10_BRICKWALL_SUFFOCATION: hyper-compressed tanh loudness wall (low crest + flat active RMS)
    {
      const n = Math.round(SR * 0.7);
      const s = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const f0 = 320 + 25 * Math.sin(Math.PI * (t / 0.7));
        phase += (2 * Math.PI * f0) / SR;
        const raw = 6.0 * (Math.sin(phase) + 0.3 * Math.sin(2 * phase));
        s[i] = 0.65 * Math.tanh(raw);
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F10" });
      assert.equal(getFalsifierResult(rep, "F10_BRICKWALL_SUFFOCATION").triggered, true);
    }

    // F11_PUMPING_TREMOLO: strong 7 Hz sinusoidal AM pumping
    {
      const base = genWarmVoice(0.8, 11);
      const s = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) {
        const t = i / SR;
        s[i] = base[i] * (0.55 + 0.45 * Math.sin(2 * Math.PI * 7 * t));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F11" });
      assert.equal(getFalsifierResult(rep, "F11_PUMPING_TREMOLO").triggered, true);
    }
  });

  it("triggers Spectral F12..F20, F31, F32 on targeted synthetic signals", () => {
    // F12_MENACING_LOW_REGISTER: deep 95 Hz booming register
    {
      const n = Math.round(SR * 0.65);
      const s = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.08, 0.16);
        const f0 = 92 + 8 * Math.sin(Math.PI * (t / 0.65));
        phase += (2 * Math.PI * f0) / SR;
        s[i] = 0.5 * env * (0.7 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F12" });
      assert.equal(getFalsifierResult(rep, "F12_MENACING_LOW_REGISTER").triggered, true);
    }

    // F13_SUBBASS_RUMBLE: heavy 45 Hz sub-bass rumble added to warm tone
    {
      const base = genWarmVoice(0.65, 13);
      const s = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.08, 0.16);
        s[i] = 0.5 * base[i] + 0.42 * env * Math.sin(2 * Math.PI * 45 * t);
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F13" });
      assert.equal(getFalsifierResult(rep, "F13_SUBBASS_RUMBLE").triggered, true);
    }

    // F14_HELMHOLTZ_ROUGHNESS: closely-spaced beating partial cluster (35 Hz spacing)
    {
      const n = Math.round(SR * 0.65);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.08, 0.16);
        const sig =
          Math.sin(2 * Math.PI * 500 * t) +
          Math.sin(2 * Math.PI * 535 * t) +
          Math.sin(2 * Math.PI * 570 * t) +
          Math.sin(2 * Math.PI * 605 * t) +
          0.7 * Math.sin(2 * Math.PI * 1000 * t) +
          0.7 * Math.sin(2 * Math.PI * 1055 * t);
        s[i] = 0.14 * env * sig;
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F14" });
      assert.equal(getFalsifierResult(rep, "F14_HELMHOLTZ_ROUGHNESS").triggered, true);
    }

    // F15_PIERCING_WHISTLE: persistent narrowband 3900 Hz whistle
    {
      const base = genWarmVoice(0.65, 15);
      const s = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.07, 0.15);
        s[i] = 0.5 * base[i] + 0.35 * env * Math.sin(2 * Math.PI * 3900 * t);
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F15" });
      assert.equal(getFalsifierResult(rep, "F15_PIERCING_WHISTLE").triggered, true);
    }

    // F16_HARSH_SIBILANCE_FIZZ: strong 6-8 kHz sibilant hiss
    {
      const base = genWarmVoice(0.65, 16);
      const rand = mulberry32(1616);
      const s = new Float32Array(base.length);
      let prev = 0;
      for (let i = 0; i < base.length; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.07, 0.15);
        const w = rand() * 2 - 1;
        const hp = w - prev; // high-pass
        prev = w;
        const sib = hp * Math.sin(2 * Math.PI * 6800 * t);
        s[i] = 0.45 * base[i] + 0.55 * env * sib;
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F16" });
      assert.equal(getFalsifierResult(rep, "F16_HARSH_SIBILANCE_FIZZ").triggered, true);
    }

    // F17_HOLLOW_METALLIC_COMB: 4.5ms delay comb filter applied to broadband/rich signal
    {
      const rand = mulberry32(17);
      const n = Math.round(SR * 0.7);
      const src = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.7, 0.07, 0.16);
        phase += (2 * Math.PI * (310 + 25 * Math.sin(Math.PI * (t / 0.7)))) / SR;
        let saw = 0;
        for (let h = 1; h <= 12; h++) saw += Math.sin(h * phase) / h;
        src[i] = 0.25 * env * (saw + 0.4 * (rand() * 2 - 1));
      }
      const delay = Math.round(SR * 0.0045);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        s[i] = 0.6 * (src[i] + 0.85 * (i >= delay ? src[i - delay] : 0));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F17" });
      assert.equal(getFalsifierResult(rep, "F17_HOLLOW_METALLIC_COMB").triggered, true);
    }

    // F18_MUDDY_BOXINESS: congested multi-partial energy trapped in 280-600 Hz, zero presence
    {
      const n = Math.round(SR * 0.65);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.08, 0.16);
        // Fundamental at 180 Hz, heavy muddy 2nd (360) and 3rd (540) harmonics
        const sig =
          0.25 * Math.sin(2 * Math.PI * 180 * t) +
          0.55 * Math.sin(2 * Math.PI * 360 * t) +
          0.50 * Math.sin(2 * Math.PI * 540 * t);
        s[i] = 0.35 * env * sig;
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F18" });
      assert.equal(getFalsifierResult(rep, "F18_MUDDY_BOXINESS").triggered, true);
    }

    // F19_TELEPHONE_BANDLIMIT: all energy strictly inside 500-2800 Hz (no <300 Hz warmth, no >3.4 kHz air)
    {
      const n = Math.round(SR * 0.65);
      const s = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.08, 0.16);
        const f0 = 260 + 25 * Math.sin(Math.PI * (t / 0.65));
        phase += (2 * Math.PI * f0) / SR;
        // Missing fundamental (cut by 300 Hz HPF) and missing >3.4 kHz (cut by LPF)
        const sig =
          0.45 * Math.sin(2 * phase) +
          0.45 * Math.sin(3 * phase) +
          0.38 * Math.sin(4 * phase) +
          0.32 * Math.sin(5 * phase) +
          0.25 * Math.sin(7 * phase);
        s[i] = 0.25 * env * sig;
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F19" });
      assert.equal(getFalsifierResult(rep, "F19_TELEPHONE_BANDLIMIT").triggered, true);
    }

    // F20_STERILE_PURE_TONE: single pure sine wave beep
    {
      const n = Math.round(SR * 0.65);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.08, 0.16);
        s[i] = 0.45 * env * Math.sin(2 * Math.PI * 660 * t);
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F20" });
      assert.equal(getFalsifierResult(rep, "F20_STERILE_PURE_TONE").triggered, true);
    }

    // F31_PRESSED_STRAIN: voiced harmonic signal with strong 1.2-3 kHz strain overpowering <600 Hz
    {
      const n = Math.round(SR * 0.65);
      const s = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.08, 0.16);
        const f0 = 280 + 20 * Math.sin(Math.PI * (t / 0.65));
        phase += (2 * Math.PI * f0) / SR;
        // Weak fundamental, strong upper harmonics in 1.1-2.8 kHz
        const sig =
          0.2 * Math.sin(phase) +
          0.55 * Math.sin(5 * phase) +
          0.55 * Math.sin(6 * phase) +
          0.45 * Math.sin(7 * phase) +
          0.35 * Math.sin(8 * phase);
        s[i] = 0.24 * env * sig;
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F31" });
      assert.equal(getFalsifierResult(rep, "F31_PRESSED_STRAIN").triggered, true);
    }

    // F32_SPECTRAL_STASIS: frozen constant static spectrum across 0.7s
    {
      const n = Math.round(SR * 0.7);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.7, 0.08, 0.16);
        s[i] =
          0.4 *
          env *
          (0.6 * Math.sin(2 * Math.PI * 330 * t) +
            0.3 * Math.sin(2 * Math.PI * 660 * t) +
            0.15 * Math.sin(2 * Math.PI * 990 * t));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F32" });
      assert.equal(getFalsifierResult(rep, "F32_SPECTRAL_STASIS").triggered, true);
    }
  });

  it("triggers Prosody & Timing F21..F27 on targeted synthetic signals", () => {
    // F21_NOISY_HNR_SWAMP: voiced tone heavily swamped in broadband static
    {
      const base = genWarmVoice(0.65, 21);
      const rand = mulberry32(2121);
      const s = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.65, 0.08, 0.16);
        s[i] = 0.55 * base[i] + 0.22 * env * (rand() * 2 - 1);
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F21" });
      assert.equal(getFalsifierResult(rep, "F21_NOISY_HNR_SWAMP").triggered, true);
    }

    // F22_MONOTONE_FLAT_PROSODY: >0.55s sustained flat monotone F0
    {
      const n = Math.round(SR * 0.75);
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.75, 0.06, 0.12);
        s[i] = 0.45 * env * (0.65 * Math.sin(2 * Math.PI * 330 * t) + 0.25 * Math.sin(2 * Math.PI * 660 * t));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F22" });
      assert.equal(getFalsifierResult(rep, "F22_MONOTONE_FLAT_PROSODY").triggered, true);
    }

    // F23_ERRATIC_PITCH_WARBLE: random chaotic frame-to-frame pitch jumps
    {
      const n = Math.round(SR * 0.7);
      const s = new Float32Array(n);
      const rand = mulberry32(23);
      let phase = 0;
      let curF0 = 330;
      const stepSamples = Math.round(SR * 0.015);
      for (let i = 0; i < n; i++) {
        if (i % stepSamples === 0) {
          curF0 = 260 + rand() * 190;
        }
        const t = i / SR;
        const env = smoothEnv(t, 0.7, 0.06, 0.14);
        phase += (2 * Math.PI * curF0) / SR;
        s[i] = 0.42 * env * (0.65 * Math.sin(phase) + 0.25 * Math.sin(2 * phase));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F23" });
      assert.equal(getFalsifierResult(rep, "F23_ERRATIC_PITCH_WARBLE").triggered, true);
    }

    // F24_CALCULATED_PITCH_LFO: mechanical 6.5 Hz sinusoidal pitch LFO (±1.2 semitones)
    {
      const n = Math.round(SR * 0.8);
      const s = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.8, 0.07, 0.15);
        const f0 = 340 * Math.pow(2, (1.2 * Math.sin(2 * Math.PI * 6.5 * t)) / 12);
        phase += (2 * Math.PI * f0) / SR;
        s[i] = 0.42 * env * (0.65 * Math.sin(phase) + 0.25 * Math.sin(2 * phase));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F24" });
      assert.equal(getFalsifierResult(rep, "F24_CALCULATED_PITCH_LFO").triggered, true);
    }

    // F25_AUTOTUNE_STAIRCASE: flat quantized plateaus snapping instantaneously by 2-3 semitones
    {
      const n = Math.round(SR * 0.8);
      const s = new Float32Array(n);
      const notes = [300, 356.76, 400.45, 336.74]; // 0, +3, +5, +2 semitones
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = smoothEnv(t, 0.8, 0.06, 0.14);
        const noteIdx = Math.min(notes.length - 1, Math.floor((t / 0.8) * notes.length));
        phase += (2 * Math.PI * notes[noteIdx]) / SR;
        s[i] = 0.42 * env * (0.65 * Math.sin(phase) + 0.25 * Math.sin(2 * phase));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F25" });
      assert.equal(getFalsifierResult(rep, "F25_AUTOTUNE_STAIRCASE").triggered, true);
    }

    // F26_INTERNAL_REBOUND_SHOCK: deep mid-phrase valley followed by sudden harsh glottal hit
    {
      const n = Math.round(SR * 0.7);
      const s = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        let env = smoothEnv(t, 0.7, 0.06, 0.14);
        let hf = 0.1;
        if (t >= 0.22 && t < 0.32) {
          env *= 0.15; // internal valley
        } else if (t >= 0.32 && t < 0.38) {
          env *= 1.0; // instant shock rebound
          hf = 0.7;
        }
        phase += (2 * Math.PI * 330) / SR;
        s[i] = 0.42 * env * (0.6 * Math.sin(phase) + hf * Math.sin(8 * phase));
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F26" });
      assert.equal(getFalsifierResult(rep, "F26_INTERNAL_REBOUND_SHOCK").triggered, true);
    }

    // F27_METRONOMIC_CADENCE: 6 perfectly evenly spaced pulses (150ms IOI)
    {
      const n = Math.round(SR * 1.1);
      const s = new Float32Array(n);
      for (let p = 0; p < 6; p++) {
        const startSec = 0.08 + p * 0.15;
        const startIdx = Math.round(startSec * SR);
        const pulseLen = Math.round(0.09 * SR);
        for (let j = 0; j < pulseLen && startIdx + j < n; j++) {
          const lt = j / SR;
          const env = smoothEnv(lt, 0.09, 0.015, 0.05);
          s[startIdx + j] += 0.42 * env * (Math.sin(2 * Math.PI * 350 * lt) + 0.3 * Math.sin(2 * Math.PI * 700 * lt));
        }
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F27" });
      assert.equal(getFalsifierResult(rep, "F27_METRONOMIC_CADENCE").triggered, true);
    }
  });

  it("triggers Environment, Digital & Spatial F28..F30 and enforces mono no-op on F30", () => {
    // F28_MAINS_HUM_DRONE: persistent 60/120/180 Hz electrical hum
    {
      const base = genWarmVoice(0.8, 28);
      const s = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) {
        const t = i / SR;
        const hum =
          0.22 * Math.sin(2 * Math.PI * 60 * t) +
          0.1 * Math.sin(2 * Math.PI * 120 * t) +
          0.06 * Math.sin(2 * Math.PI * 180 * t);
        s[i] = 0.55 * base[i] + hum;
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F28" });
      assert.equal(getFalsifierResult(rep, "F28_MAINS_HUM_DRONE").triggered, true);
    }

    // F29_BITCRUSH_ALIASING: 4-bit quantization (16 discrete levels)
    {
      const base = genWarmVoice(0.65, 29);
      const s = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) {
        s[i] = Math.round(base[i] * 12) / 12;
      }
      const rep = analyzeSamples(s, SR, { label: "ce_F29" });
      assert.equal(getFalsifierResult(rep, "F29_BITCRUSH_ALIASING").triggered, true);
    }

    // F30_STEREO_PHASE_DISCOMFORT: mono no-op vs stereo phase inversion (R = -L) vs extreme imbalance
    {
      const left = genWarmVoice(0.6, 30);
      const monoRep = analyzeSamples(left, SR, { label: "mono_check" });
      const f30Mono = getFalsifierResult(monoRep, "F30_STEREO_PHASE_DISCOMFORT");
      assert.equal(f30Mono.triggered, false);
      assert.equal(f30Mono.score, 0);

      // Phase-inverted stereo (R = -L -> mono downmix is zero!)
      const rightInv = new Float32Array(left.length);
      const zeroMono = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) rightInv[i] = -left[i];
      const invRep = analyzeSamples(zeroMono, SR, { label: "stereo_inv", channels: [left, rightInv] });
      assert.equal(getFalsifierResult(invRep, "F30_STEREO_PHASE_DISCOMFORT").triggered, true);

      // Extreme L-R imbalance (L = full, R = 0.05*L)
      const rightQuiet = new Float32Array(left.length);
      const imbMono = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        rightQuiet[i] = 0.05 * left[i];
        imbMono[i] = 0.5 * (left[i] + rightQuiet[i]);
      }
      const imbRep = analyzeSamples(imbMono, SR, { label: "stereo_imb", channels: [left, rightQuiet] });
      assert.equal(getFalsifierResult(imbRep, "F30_STEREO_PHASE_DISCOMFORT").triggered, true);
    }
  });

  it("handles silence and ultra-short clips with finite scores in [0, 1]", () => {
    const silence = new Float32Array(Math.round(SR * 0.4));
    const shortClip = new Float32Array(Math.round(SR * 0.015));
    for (let i = 0; i < shortClip.length; i++) {
      shortClip[i] = 0.3 * Math.sin(2 * Math.PI * 440 * (i / SR));
    }

    for (const [label, buf] of [
      ["silence", silence],
      ["short15ms", shortClip],
    ]) {
      const rep = analyzeSamples(buf, SR, { label });
      assert.equal(rep.totalFalsifiers, 32);
      for (const f of rep.falsifiers) {
        assert.ok(
          Number.isFinite(f.score) && f.score >= 0 && f.score <= 1,
          `${label}/${f.id} score invalid: ${f.score}`
        );
      }
    }
  });

  it("createFalsifiers applies numeric and object overrides without mutating DEFAULT_FALSIFIERS", () => {
    const base = genWarmVoice(0.6, 88);
    const dc = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) dc[i] = base[i] * 0.5 + 0.35;

    const before = analyzeSamples(dc, SR, { label: "before" });
    const f8Before = getFalsifierResult(before, "F8_DC_OFFSET_BIAS");
    assert.equal(f8Before.triggered, true);

    // Numeric threshold override
    const relaxedNum = createFalsifiers({ F8_DC_OFFSET_BIAS: 100 });
    assert.notEqual(relaxedNum, DEFAULT_FALSIFIERS);
    const repNum = analyzeSamples(dc, SR, { label: "relaxed_num", falsifiers: relaxedNum });
    const f8Num = getFalsifierResult(repNum, "F8_DC_OFFSET_BIAS");
    assert.equal(f8Num.triggered, false);
    assert.equal(f8Num.threshold, 100);

    // Object parameter override
    const relaxedObj = createFalsifiers({ F8_DC_OFFSET_BIAS: { dcOffset: 0.9, dcToRmsRatio: 50 } });
    const repObj = analyzeSamples(dc, SR, { label: "relaxed_obj", falsifiers: relaxedObj });
    assert.equal(getFalsifierResult(repObj, "F8_DC_OFFSET_BIAS").triggered, false);

    // Verify DEFAULT_FALSIFIERS untouched
    const after = analyzeSamples(dc, SR, { label: "after" });
    const f8After = getFalsifierResult(after, "F8_DC_OFFSET_BIAS");
    assert.equal(f8After.triggered, true);
    assert.equal(f8After.threshold, f8Before.threshold);
  });

  it("compareReports performs ID-safe lookup across reordered or mismatched falsifier sets", () => {
    const warm = genWarmVoice(0.6, 55);
    const dc = new Float32Array(warm.length);
    for (let i = 0; i < warm.length; i++) dc[i] = warm[i] * 0.5 + 0.35;

    const repCore = analyzeSamples(warm, SR, { label: "core6", falsifiers: ORIGINAL_6_FALSIFIERS });
    const repAll = analyzeSamples(dc, SR, {
      label: "all32_reversed",
      falsifiers: [...DEFAULT_FALSIFIERS].reverse(),
    });

    const cmp = compareReports(repCore, repAll);
    assert.equal(cmp.deltas.length, 32);

    const d1 = cmp.deltas.find((d) => d.id === "F1_HARSH_EDGE");
    assert.ok(d1 && d1.aScore !== null && d1.bScore !== null && d1.deltaBMinusA !== null);

    const d8 = cmp.deltas.find((d) => d.id === "F8_DC_OFFSET_BIAS");
    assert.ok(d8);
    assert.equal(d8.aScore, null);
    assert.equal(d8.bTriggered, true);
    assert.equal(d8.deltaBMinusA, null);
  });

  it("formatForLLM and formatCompareForLLM are token-efficient by default and support verbose mode", () => {
    const warm = genWarmVoice(0.6, 77);
    const dc = new Float32Array(warm.length);
    for (let i = 0; i < warm.length; i++) dc[i] = warm[i] * 0.5 + 0.35;

    const repClean = analyzeSamples(warm, SR, { label: "clean", includeProfile: true });
    assert.ok(repClean.profile && Array.isArray(repClean.profile.frames));

    const compactClean = formatForLLM(repClean);
    const verboseClean = formatForLLM(repClean, { verbose: true });
    assert.ok(compactClean.split("\n").length <= 10, `Compact clean too long: ${compactClean.split("\n").length}`);
    assert.ok(verboseClean.split("\n").length > 32, "Verbose dump should include all 32 falsifiers");

    const repBad = analyzeSamples(dc, SR, { label: "dc_bad" });
    const compactBad = formatForLLM(repBad);
    const verboseBad = formatForLLM(repBad, { verbose: true });
    assert.match(compactBad, /F8_DC_OFFSET_BIAS/);
    assert.ok(compactBad.split("\n").length < verboseBad.split("\n").length);

    const cmp = compareReports(repClean, repBad);
    const compactCmp = formatCompareForLLM(cmp);
    const verboseCmp = formatCompareForLLM(cmp, { verbose: true });
    assert.match(compactCmp, /F8_DC_OFFSET_BIAS/);
    assert.ok(compactCmp.split("\n").length < verboseCmp.split("\n").length);
  });
});
