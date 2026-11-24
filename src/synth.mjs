/**
 * src/synth.mjs — Deterministic Pure-JS Synthetic Audio Corpus
 *
 * Generates a reproducible corpus across the 2×2 matrix (human-like voice / non-vocal
 * × pleasant / unkawaii) using a seeded Mulberry32 PRNG:
 *   - positives:       >= 8 diverse pleasant/kawaii sounds (ALL survive 0/32)
 *   - counterexamples: 26 targeted counterexamples ce_F7..ce_F32 (each triggers its targetFalsifier)
 *   - legacyNegatives: 2 legacy katakana controls (ナル, ナッタ) + F1–F6 examples
 *
 * Zero external dependencies. Pure ES Module.
 */

export function mulberry32(seed = 2026) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothEnv(t, dur, atkSec = 0.08, relSec = 0.16) {
  if (t < 0 || t > dur) return 0;
  let a = 1;
  if (atkSec > 0 && t < atkSec) {
    a = 0.5 - 0.5 * Math.cos((Math.PI * t) / atkSec);
  }
  let r = 1;
  if (relSec > 0 && t > dur - relSec) {
    const u = Math.max(0, (dur - t) / relSec);
    r = 0.5 - 0.5 * Math.cos(Math.PI * u);
  }
  return a * r;
}

function makeDriftNoise(n, rand, alpha = 0.992) {
  const out = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    y = alpha * y + (1 - alpha) * (rand() * 2 - 1);
    out[i] = y;
  }
  // Normalize RMS to ~1
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += out[i] * out[i];
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  if (rms > 1e-9) {
    const inv = 1 / rms;
    for (let i = 0; i < n; i++) out[i] *= inv;
  }
  return out;
}

/**
 * Generate a warm, organic vocal-like tone with coupled pitch/amplitude/timbre
 * and gentle 1/f micro-fluctuations. Designed to survive 0/32 cleanly.
 */
function genWarmVoice(sr, durSec = 0.65, seed = 101, opts = {}) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const drift = makeDriftNoise(n, rand, 0.994);
  const breathDrift = makeDriftNoise(n, rand, 0.985);

  const baseF0 = opts.baseF0 ?? 295;
  const arcHz = opts.arcHz ?? 55;
  const atkSec = opts.atkSec ?? 0.09;
  const relSec = opts.relSec ?? 0.18;
  const ampScale = opts.amp ?? 0.44;
  const breathMix = opts.breathMix ?? 0.015;

  let phase = 0;
  let bLp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = t / durSec;
    const env = smoothEnv(t, durSec, atkSec, relSec);
    // Coupled organic pitch arc + subtle 1/f micro-drift
    const f0 = baseF0 + arcHz * Math.sin(Math.PI * u) * env + 2.8 * drift[i];
    phase += (2 * Math.PI * f0) / sr;

    // Timbre brightness gently coupled to amplitude envelope
    const bright = 0.25 + 0.75 * env;
    const h1 = 0.66 * Math.sin(phase);
    const h2 = 0.27 * bright * Math.sin(2 * phase + 0.15);
    const h3 = 0.11 * bright * Math.sin(3 * phase + 0.35);
    const h4 = 0.045 * bright * Math.sin(4 * phase + 0.55);
    const h5 = 0.018 * bright * Math.sin(5 * phase + 0.8);

    // Subtle soft airiness
    const wn = rand() * 2 - 1;
    bLp = 0.78 * bLp + 0.22 * wn;
    const breath = breathMix * (0.4 + 0.6 * env) * (1 + 0.25 * breathDrift[i]) * (wn - bLp);

    out[i] = ampScale * env * (1 + 0.03 * drift[i]) * (h1 + h2 + h3 + h4 + h5) + breath * env;
  }
  return out;
}

/**
 * Sasayaki (soft breathy whisper / sigh) — warm low-frequency presence with
 * gentle breathy air. Survives F3, F21, F31 (whisper guard).
 */
function genSasayaki(sr, durSec = 0.7, seed = 202) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const drift = makeDriftNoise(n, rand, 0.993);

  let phase = 0;
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = t / durSec;
    const env = smoothEnv(t, durSec, 0.12, 0.22);
    const f0 = 265 + 32 * Math.sin(Math.PI * u) * env + 2.6 * drift[i];
    phase += (2 * Math.PI * f0) / sr;

    // Gentle voiced undertone + warm shaped breath
    const voiced =
      0.58 * Math.sin(phase) +
      0.20 * env * Math.sin(2 * phase + 0.2) +
      0.07 * env * Math.sin(3 * phase + 0.5);

    const wn = rand() * 2 - 1;
    lp1 = 0.72 * lp1 + 0.28 * wn;
    lp2 = 0.88 * lp2 + 0.12 * lp1;
    const shapedBreath = (lp1 - lp2) * 0.22;

    out[i] = 0.42 * env * (voiced + shapedBreath);
  }
  return out;
}

/**
 * Pleasant small bird chirp (gentle organic ascending-descending trill with soft tail).
 */
function genBirdChirp(sr, durSec = 0.72, seed = 303) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const drift = makeDriftNoise(n, rand, 0.992);

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = t / durSec;
    const env = smoothEnv(t, durSec, 0.08, 0.22);
    // Single graceful rising-then-falling chirp arc (440 -> 630 -> 470 Hz)
    const arch = Math.sin(Math.PI * Math.pow(u, 0.85));
    const f0 = 440 + 185 * arch + 3.2 * drift[i];
    phase += (2 * Math.PI * f0) / sr;
    const bright = 0.28 + 0.72 * env;
    const body =
      0.64 * Math.sin(phase) +
      0.26 * bright * Math.sin(2 * phase + 0.12) +
      0.11 * bright * Math.sin(3 * phase + 0.32) +
      0.04 * bright * Math.sin(4 * phase + 0.55);
    out[i] = 0.42 * env * body;
  }
  return out;
}

/**
 * Warm wooden marimba gentle arpeggio (non-vocal acoustic instrument, organic rubato).
 */
function genMarimba(sr, durSec = 0.85, seed = 404) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const drift = makeDriftNoise(n, rand, 0.993);

  // Warm resonant wooden bar glide with coupled amplitude-brightness
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = t / durSec;
    const atk = t < 0.055 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.055) : 1;
    const decay = Math.exp(-Math.max(0, t - 0.055) * 2.5);
    const rel = t > durSec - 0.14 ? 0.5 - 0.5 * Math.cos((Math.PI * (durSec - t)) / 0.14) : 1;
    const env = atk * decay * rel;
    // Gentle pitch bloom from mallet impact settling into D4 (293.66 Hz)
    const f0 = 294 + 48 * env + 2.8 * drift[i];
    phase += (2 * Math.PI * f0) / sr;
    const warmOver = 0.25 + 0.75 * env;
    const sig =
      0.62 * Math.sin(phase) +
      0.28 * warmOver * Math.sin(2 * phase + 0.2) +
      0.13 * warmOver * Math.sin(3 * phase + 0.45) +
      0.06 * warmOver * Math.sin(4 * phase + 0.7);
    out[i] = 0.44 * env * sig;
  }
  return out;
}

/**
 * Gentle celesta / UI notification chime (warm harmonic bloom, non-vocal UI sound).
 */
function genCelestaChime(sr, durSec = 0.82, seed = 505) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const drift = makeDriftNoise(n, rand, 0.994);

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const atk = t < 0.065 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.065) : 1;
    const decay = Math.exp(-Math.max(0, t - 0.065) * 2.2);
    const rel = t > durSec - 0.16 ? 0.5 - 0.5 * Math.cos((Math.PI * (durSec - t)) / 0.16) : 1;
    const env = atk * decay * rel;
    // Soft celesta bloom centered around F4 (349 Hz)
    const f0 = 345 + 36 * env + 2.6 * drift[i];
    phase += (2 * Math.PI * f0) / sr;
    const shimmer = 0.45 + 0.55 * env;
    const sig =
      0.60 * Math.sin(phase) +
      0.30 * shimmer * Math.sin(2 * phase + 0.15) +
      0.13 * shimmer * Math.sin(3 * phase + 0.38) +
      0.04 * shimmer * Math.sin(4 * phase + 0.65);
    out[i] = 0.42 * env * sig;
  }
  return out;
}

/**
 * Soft lullaby hum (two-phrase warm melody with gentle breath release).
 */
function genLullaby(sr, durSec = 0.9, seed = 606) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const drift = makeDriftNoise(n, rand, 0.995);

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = t / durSec;
    const env = smoothEnv(t, durSec, 0.11, 0.22) * (0.78 + 0.22 * Math.sin(Math.PI * u * 2.0));
    // Gentle descending lullaby contour (330 -> 392 -> 310 -> 285 Hz)
    const f0 = 315 + 52 * Math.sin(Math.PI * u) + 18 * Math.sin(2 * Math.PI * u) + 2.4 * drift[i];
    phase += (2 * Math.PI * f0) / sr;
    const bright = 0.3 + 0.7 * env;
    const sig =
      0.68 * Math.sin(phase) +
      0.24 * bright * Math.sin(2 * phase + 0.1) +
      0.09 * bright * Math.sin(3 * phase + 0.3) +
      0.03 * bright * Math.sin(4 * phase + 0.6);
    out[i] = 0.44 * env * sig;
  }
  return out;
}

/**
 * 「鳴る」 (naru): softly opening vocal contour that melts into a gradual breathy tail.
 */
function genNaru(sr, durSec = 0.72, seed = 707) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const drift = makeDriftNoise(n, rand, 0.994);

  let phase = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = t / durSec;
    // Soft /n/ murmur -> blooming /a/ -> gentle /r u/ release
    const env = smoothEnv(t, durSec, 0.10, 0.24);
    const f0 = 285 + 65 * Math.sin(Math.PI * Math.pow(u, 0.85)) + 2.5 * drift[i];
    phase += (2 * Math.PI * f0) / sr;

    const openness = Math.sin(Math.PI * u);
    const sig =
      0.65 * Math.sin(phase) +
      (0.18 + 0.14 * openness) * Math.sin(2 * phase + 0.15) +
      (0.06 + 0.08 * openness) * Math.sin(3 * phase + 0.4) +
      0.03 * openness * Math.sin(4 * phase + 0.7);

    const wn = rand() * 2 - 1;
    lp = 0.80 * lp + 0.20 * wn;
    const tailBreath = 0.02 * Math.pow(u, 1.5) * (wn - lp);

    out[i] = 0.44 * env * (sig + tailBreath);
  }
  return out;
}

/**
 * 「鳴った」 (natta): rounded, cushioned sokuon pause + soft landing + melting tail.
 */
function genNatta(sr, durSec = 0.76, seed = 808) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const drift = makeDriftNoise(n, rand, 0.993);

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = t / durSec;
    // Gentle asymmetric cushioned sokuon dip around t=0.25s (avoids periodic tremolo signature)
    const dip = 1 - 0.18 * Math.exp(-Math.pow((t - 0.25) / 0.06, 2));
    const env = smoothEnv(t, durSec, 0.09, 0.24) * dip;
    const f0 = 305 + 58 * Math.sin(Math.PI * u) - 16 * Math.exp(-Math.pow((t - 0.26) / 0.07, 2)) + 2.5 * drift[i];
    phase += (2 * Math.PI * f0) / sr;

    const bright = 0.3 + 0.7 * env;
    const sig =
      0.66 * Math.sin(phase) +
      0.26 * bright * Math.sin(2 * phase + 0.12) +
      0.10 * bright * Math.sin(3 * phase + 0.35) +
      0.035 * bright * Math.sin(4 * phase + 0.6);

    out[i] = 0.44 * env * sig;
  }
  return out;
}

// ============================================================================
// Targeted Counterexamples ce_F7..ce_F32 (designed to trigger targetFalsifier
// while slipping past ORIGINAL_6_FALSIFIERS wherever physically possible)
// ============================================================================

function buildCounterexamples(sr, seed) {
  const items = [];

  // F7_FLAT_TOP_CLIPPING: sub-full-scale flat-top clip at ±0.42 (slips past F6 clipRatio>=0.995!)
  {
    const base = genWarmVoice(sr, 0.65, seed + 7, { amp: 0.75 });
    const s = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) {
      s[i] = Math.max(-0.42, Math.min(0.42, base[i]));
    }
    items.push({
      id: "ce_F7",
      kind: "counterexample",
      targetFalsifier: "F7_FLAT_TOP_CLIPPING",
      description: "Sub-full-scale flat-top clipped warm voice (clipped at ±0.42, invisible to full-scale F6)",
      samples: s,
      sampleRate: sr,
    });
  }

  // F8_DC_OFFSET_BIAS: clean warm voice shifted by +0.26 DC offset (gradual tail so F5 clears)
  {
    const base = genWarmVoice(sr, 0.72, seed + 8, { amp: 0.38, relSec: 0.22 });
    const s = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) {
      const t = i / sr;
      const dcEnv = smoothEnv(t, 0.72, 0.08, 0.22);
      s[i] = base[i] + 0.26 * dcEnv;
    }
    items.push({
      id: "ce_F8",
      kind: "counterexample",
      targetFalsifier: "F8_DC_OFFSET_BIAS",
      description: "Warm voice with +0.26 DC offset bias",
      samples: s,
      sampleRate: sr,
    });
  }

  // F9_MICRO_CLICK_DROPOUT: warm voice with localized micro-click + 8ms zero dropout (below F6 0.85 jump)
  {
    const s = genWarmVoice(sr, 0.68, seed + 9);
    const clickIdx = Math.round(sr * 0.30);
    s[clickIdx] += 0.42;
    s[clickIdx + 1] -= 0.38;
    const dropStart = Math.round(sr * 0.46);
    const dropLen = Math.round(sr * 0.008);
    for (let i = dropStart; i < dropStart + dropLen && i < s.length; i++) {
      s[i] = 0;
    }
    items.push({
      id: "ce_F9",
      kind: "counterexample",
      targetFalsifier: "F9_MICRO_CLICK_DROPOUT",
      description: "Warm voice with a mid-phrase micro-click (@0.30s) and 8ms buffer dropout (@0.46s)",
      samples: s,
      sampleRate: sr,
    });
  }

  // F10_BRICKWALL_SUFFOCATION: heavily brickwall-compressed breathless voice (low crest factor & low RMS CV)
  {
    const dur = 1.6;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 10);
    const drift = makeDriftNoise(n, rand, 0.992);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const u = t / dur;
      // Brickwall limiter squashes attack/release dynamics into a flat breathless wall
      const env = smoothEnv(t, dur, 0.02, 0.035);
      const f0 = 285 + 32 * Math.sin(Math.PI * u) + 3.0 * drift[i];
      phase += (2 * Math.PI * f0) / sr;
      const raw = Math.sin(phase) + 0.3 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase);
      const crushed = Math.tanh(4.8 * raw);
      s[i] = 0.46 * env * crushed;
    }
    items.push({
      id: "ce_F10",
      kind: "counterexample",
      targetFalsifier: "F10_BRICKWALL_SUFFOCATION",
      description: "Brickwall-compressed breathless tone with suffocated dynamic range",
      samples: s,
      sampleRate: sr,
    });
  }

  // F11_PUMPING_TREMOLO: warm voice with 5.5 Hz mechanical sinusoidal tremolo
  {
    const dur = 1.15;
    const base = genWarmVoice(sr, dur, seed + 11, { atkSec: 0.07, relSec: 0.15 });
    const s = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) {
      const t = i / sr;
      const lfo = 1 + 0.68 * Math.sin(2 * Math.PI * 5.5 * t);
      s[i] = 0.56 * base[i] * lfo;
    }
    items.push({
      id: "ce_F11",
      kind: "counterexample",
      targetFalsifier: "F11_PUMPING_TREMOLO",
      description: "Warm voice modulated by 5.5 Hz mechanical pumping tremolo",
      samples: s,
      sampleRate: sr,
    });
  }

  // F12_MENACING_LOW_REGISTER: deep booming low register (F0 ~92 Hz)
  {
    const s = genWarmVoice(sr, 0.72, seed + 12, { baseF0: 92, arcHz: 14, amp: 0.48 });
    items.push({
      id: "ce_F12",
      kind: "counterexample",
      targetFalsifier: "F12_MENACING_LOW_REGISTER",
      description: "Menacing deep low-register vocal drone (F0 ~92 Hz)",
      samples: s,
      sampleRate: sr,
    });
  }

  // F13_SUBBASS_RUMBLE: warm voice polluted with heavy 35–45 Hz sub-bass handling rumble
  {
    const base = genWarmVoice(sr, 0.7, seed + 13, { amp: 0.36 });
    const s = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) {
      const t = i / sr;
      const env = smoothEnv(t, 0.7, 0.08, 0.16);
      const rumble = 0.36 * env * (Math.sin(2 * Math.PI * 36 * t) + 0.6 * Math.sin(2 * Math.PI * 44 * t));
      s[i] = base[i] + rumble;
    }
    items.push({
      id: "ce_F13",
      kind: "counterexample",
      targetFalsifier: "F13_SUBBASS_RUMBLE",
      description: "Warm voice with heavy 36-44 Hz sub-bass handling rumble",
      samples: s,
      sampleRate: sr,
    });
  }

  // F14_HELMHOLTZ_ROUGHNESS: beating dissonant partial cluster (35 Hz spacing across mid-band)
  {
    const dur = 0.7;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 14);
    const drift = makeDriftNoise(n, rand, 0.992);
    const base = genWarmVoice(sr, dur, seed + 140, { amp: 0.28 });
    const freqs = [500, 535, 572, 820, 858, 895, 1140, 1182];
    const phases = new Float64Array(freqs.length);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      let rough = 0;
      for (let k = 0; k < freqs.length; k++) {
        phases[k] += (2 * Math.PI * (freqs[k] + 1.5 * drift[i])) / sr;
        rough += Math.sin(phases[k]);
      }
      s[i] = base[i] + 0.09 * env * rough;
    }
    items.push({
      id: "ce_F14",
      kind: "counterexample",
      targetFalsifier: "F14_HELMHOLTZ_ROUGHNESS",
      description: "Dissonant beating partial cluster (35-42 Hz roughness intervals)",
      samples: s,
      sampleRate: sr,
    });
  }

  // F15_PIERCING_WHISTLE: warm voice with persistent piercing 3800 Hz narrowband feedback whine
  {
    const base = genWarmVoice(sr, 0.7, seed + 15, { amp: 0.36 });
    const s = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) {
      const t = i / sr;
      const env = smoothEnv(t, 0.7, 0.08, 0.16);
      s[i] = base[i] + 0.24 * env * Math.sin(2 * Math.PI * 3800 * t);
    }
    items.push({
      id: "ce_F15",
      kind: "counterexample",
      targetFalsifier: "F15_PIERCING_WHISTLE",
      description: "Warm voice with piercing 3800 Hz narrowband feedback whistle",
      samples: s,
      sampleRate: sr,
    });
  }

  // F16_HARSH_SIBILANCE_FIZZ: warm voice with harsh 5-9 kHz sibilant fizz
  {
    const base = genWarmVoice(sr, 0.7, seed + 16, { amp: 0.36 });
    const rand = mulberry32(seed + 160);
    const s = new Float32Array(base.length);
    let prev1 = 0;
    let prev2 = 0;
    for (let i = 0; i < base.length; i++) {
      const t = i / sr;
      const env = smoothEnv(t, 0.7, 0.08, 0.16);
      // 2nd-order high-pass noise -> concentrated in 5-10 kHz
      const wn = rand() * 2 - 1;
      const hp = wn - 1.5 * prev1 + 0.55 * prev2;
      prev2 = prev1;
      prev1 = wn;
      s[i] = base[i] + 0.22 * env * hp;
    }
    items.push({
      id: "ce_F16",
      kind: "counterexample",
      targetFalsifier: "F16_HARSH_SIBILANCE_FIZZ",
      description: "Warm voice overlaid with harsh 5-9 kHz sibilant fizz",
      samples: s,
      sampleRate: sr,
    });
  }

  // F17_HOLLOW_METALLIC_COMB: 4.5 ms delay comb filter applied to broadband-rich harmonic source
  {
    const dur = 0.72;
    const n = Math.round(sr * dur);
    const rand = mulberry32(seed + 170);
    const src = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      phase += (2 * Math.PI * (310 + 28 * Math.sin(Math.PI * (t / dur)))) / sr;
      let saw = 0;
      for (let h = 1; h <= 12; h++) saw += Math.sin(h * phase) / h;
      src[i] = 0.25 * env * (saw + 0.35 * (rand() * 2 - 1));
    }
    const delay = Math.round(sr * 0.0045); // 4.5 ms comb (well separated from 3.2 ms pitch period)
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const delayed = i >= delay ? src[i - delay] : 0;
      s[i] = 0.58 * (src[i] + 0.88 * delayed);
    }
    items.push({
      id: "ce_F17",
      kind: "counterexample",
      targetFalsifier: "F17_HOLLOW_METALLIC_COMB",
      description: "Hollow metallic 4.5 ms comb-filtered reflection resonance",
      samples: s,
      sampleRate: sr,
    });
  }

  // F18_MUDDY_BOXINESS: congested 250-650 Hz muddy room resonance with missing upper-mid presence
  {
    const dur = 0.7;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 18);
    const drift = makeDriftNoise(n, rand, 0.992);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const u = t / dur;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      const f0 = 175 + 22 * Math.sin(Math.PI * u) + 2.2 * drift[i];
      phase += (2 * Math.PI * f0) / sr;
      // Heavy 2nd (350 Hz) & 3rd (525 Hz) congestion inside 250-650 Hz, almost zero > 1 kHz
      s[i] =
        0.45 *
        env *
        (0.22 * Math.sin(phase) +
          0.55 * Math.sin(2 * phase + 0.2) +
          0.50 * Math.sin(3 * phase + 0.4));
    }
    items.push({
      id: "ce_F18",
      kind: "counterexample",
      targetFalsifier: "F18_MUDDY_BOXINESS",
      description: "Muddy congested 250-650 Hz boxy tone lacking upper-mid clarity",
      samples: s,
      sampleRate: sr,
    });
  }

  // F19_TELEPHONE_BANDLIMIT: narrowband 300-3400 Hz telephone voice (no <300 Hz warmth, no >3.4 kHz air)
  {
    const dur = 0.72;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 19);
    const drift = makeDriftNoise(n, rand, 0.992);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const u = t / dur;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      const f0 = 360 + 45 * Math.sin(Math.PI * u) + 2.8 * drift[i];
      phase += (2 * Math.PI * f0) / sr;
      // Harmonics strictly in 720..2520 Hz (centroid > 1200 Hz, top1Share < 0.4, zero <300 Hz & >3400 Hz)
      s[i] =
        0.42 *
        env *
        (0.32 * Math.sin(2 * phase) +
          0.38 * Math.sin(3 * phase + 0.2) +
          0.35 * Math.sin(4 * phase + 0.5) +
          0.28 * Math.sin(5 * phase + 0.9) +
          0.22 * Math.sin(6 * phase + 1.2));
    }
    items.push({
      id: "ce_F19",
      kind: "counterexample",
      targetFalsifier: "F19_TELEPHONE_BANDLIMIT",
      description: "Telephone band-limited narrowband sound (300-3400 Hz only)",
      samples: s,
      sampleRate: sr,
    });
  }

  // F20_STERILE_PURE_TONE: sterile single-sine electronic beep with slight pitch drift (so F2/F4 may clear)
  {
    const dur = 0.7;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 20);
    const drift = makeDriftNoise(n, rand, 0.99);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const u = t / dur;
      const env = smoothEnv(t, dur, 0.08, 0.18);
      const f0 = 440 + 40 * Math.sin(Math.PI * u) + 3.0 * drift[i];
      phase += (2 * Math.PI * f0) / sr;
      s[i] = 0.45 * env * Math.sin(phase);
    }
    items.push({
      id: "ce_F20",
      kind: "counterexample",
      targetFalsifier: "F20_STERILE_PURE_TONE",
      description: "Sterile pure sine electronic beep with zero harmonic richness",
      samples: s,
      sampleRate: sr,
    });
  }

  // F21_NOISY_HNR_SWAMP: voiced tone swamped in broadband static (slips past F3, caught by F21)
  {
    const base = genWarmVoice(sr, 0.7, seed + 21, { amp: 0.42 });
    const rand = mulberry32(seed + 210);
    const s = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) {
      const t = i / sr;
      const env = smoothEnv(t, 0.7, 0.08, 0.16);
      s[i] = 0.78 * base[i] + 0.19 * env * (rand() * 2 - 1);
    }
    items.push({
      id: "ce_F21",
      kind: "counterexample",
      targetFalsifier: "F21_NOISY_HNR_SWAMP",
      description: "Voiced tone buried in muddy broadband noise swamp (low HNR)",
      samples: s,
      sampleRate: sr,
    });
  }

  // F22_MONOTONE_FLAT_PROSODY: >0.7s sustained flat monotone F0 (with slight breath/shimmer so F2 clears)
  {
    const dur = 0.85;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 22);
    const drift = makeDriftNoise(n, rand, 0.99);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      const f0 = 310 + 0.4 * drift[i]; // < 0.1 semitone total range
      phase += (2 * Math.PI * f0) / sr;
      const bright = 0.35 + 0.65 * env;
      s[i] =
        0.44 *
        env *
        (1 + 0.05 * drift[i]) *
        (0.65 * Math.sin(phase) + 0.25 * bright * Math.sin(2 * phase) + 0.1 * bright * Math.sin(3 * phase));
    }
    items.push({
      id: "ce_F22",
      kind: "counterexample",
      targetFalsifier: "F22_MONOTONE_FLAT_PROSODY",
      description: "Flat monotone pitch contour held across 0.85s with zero inflection",
      samples: s,
      sampleRate: sr,
    });
  }

  // F23_ERRATIC_PITCH_WARBLE: unstable chaotic frame-to-frame pitch jumps
  {
    const dur = 0.75;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 23);
    const stepSamples = Math.round(sr * 0.022); // change pitch wildly every 22 ms
    let curF0 = 300;
    let phase = 0;
    for (let i = 0; i < n; i++) {
      if (i % stepSamples === 0) {
        curF0 = 235 + rand() * 195;
      }
      const t = i / sr;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      phase += (2 * Math.PI * curF0) / sr;
      s[i] = 0.44 * env * (0.66 * Math.sin(phase) + 0.25 * env * Math.sin(2 * phase) + 0.09 * env * Math.sin(3 * phase));
    }
    items.push({
      id: "ce_F23",
      kind: "counterexample",
      targetFalsifier: "F23_ERRATIC_PITCH_WARBLE",
      description: "Erratic unstable pitch warble jumping chaotically every 22 ms",
      samples: s,
      sampleRate: sr,
    });
  }

  // F24_CALCULATED_PITCH_LFO: artificial 6 Hz sinusoidal pitch LFO vibrato (±1.4 semitones)
  {
    const dur = 0.85;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      const semi = 1.4 * Math.sin(2 * Math.PI * 6.0 * t);
      const f0 = 310 * Math.pow(2, semi / 12);
      phase += (2 * Math.PI * f0) / sr;
      s[i] = 0.44 * env * (0.65 * Math.sin(phase) + 0.25 * env * Math.sin(2 * phase) + 0.10 * env * Math.sin(3 * phase));
    }
    items.push({
      id: "ce_F24",
      kind: "counterexample",
      targetFalsifier: "F24_CALCULATED_PITCH_LFO",
      description: "Calculated 6 Hz sinusoidal pitch LFO vibrato (±1.4 semitones)",
      samples: s,
      sampleRate: sr,
    });
  }

  // F25_AUTOTUNE_STAIRCASE: hard-quantized pitch snapping between discrete flat note steps
  {
    const dur = 0.9;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const notes = [261.63, 329.63, 392.0, 293.66, 349.23]; // discrete jumps
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      const idx = Math.min(notes.length - 1, Math.floor((t / dur) * notes.length));
      const f0 = notes[idx];
      phase += (2 * Math.PI * f0) / sr;
      s[i] = 0.44 * env * (0.66 * Math.sin(phase) + 0.24 * env * Math.sin(2 * phase) + 0.10 * env * Math.sin(3 * phase));
    }
    items.push({
      id: "ce_F25",
      kind: "counterexample",
      targetFalsifier: "F25_AUTOTUNE_STAIRCASE",
      description: "Hard-quantized Auto-Tune pitch staircase snapping between discrete notes",
      samples: s,
      sampleRate: sr,
    });
  }

  // F26_INTERNAL_REBOUND_SHOCK: smooth opening, deep mid-phrase valley, then sudden jarring rebound hit
  {
    const dur = 0.85;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 26);
    const drift = makeDriftNoise(n, rand, 0.992);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let env;
      let burst = 0;
      if (t < 0.26) {
        env = smoothEnv(t, 0.26, 0.08, 0.06) * 0.55;
      } else if (t < 0.36) {
        env = 0.02; // deep internal valley
      } else if (t < 0.372) {
        // Sudden jarring 12 ms internal rebound spike + high-frequency glottal snap
        env = 1.0;
        burst = 1.1 * Math.sin(2 * Math.PI * 5500 * t);
      } else if (t < 0.41) {
        env = 0.30;
      } else {
        env = 0.38 * smoothEnv(t - 0.41, dur - 0.41, 0.01, 0.20);
      }
      const f0 = 295 + 45 * env + 2.5 * drift[i];
      phase += (2 * Math.PI * f0) / sr;
      s[i] =
        0.38 * env * (0.64 * Math.sin(phase) + 0.25 * env * Math.sin(2 * phase) + 0.11 * env * Math.sin(3 * phase)) +
        0.52 * burst;
    }
    items.push({
      id: "ce_F26",
      kind: "counterexample",
      targetFalsifier: "F26_INTERNAL_REBOUND_SHOCK",
      description: "Mid-phrase valley followed by a jarring internal rebound glottal shock (@0.36s)",
      samples: s,
      sampleRate: sr,
    });
  }

  // F27_METRONOMIC_CADENCE: 6 identically spaced robotic pulses every 0.160s (ioiCv ≈ 0)
  {
    const dur = 1.25;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 27);
    const drift = makeDriftNoise(n, rand, 0.99);
    const pulseStarts = [0.05, 0.21, 0.37, 0.53, 0.69, 0.85];
    for (let p = 0; p < pulseStarts.length; p++) {
      const start = pulseStarts[p];
      const pulseDur = p === pulseStarts.length - 1 ? 0.28 : 0.11;
      const relSec = p === pulseStarts.length - 1 ? 0.18 : 0.065;
      const i0 = Math.round(start * sr);
      const len = Math.round(pulseDur * sr);
      let phase = 0;
      for (let k = 0; k < len && i0 + k < n; k++) {
        const t = k / sr;
        const env = smoothEnv(t, pulseDur, 0.025, relSec);
        const f0 = 320 + 25 * env + 2.5 * drift[i0 + k];
        phase += (2 * Math.PI * f0) / sr;
        s[i0 + k] += 0.42 * env * (0.66 * Math.sin(phase) + 0.24 * env * Math.sin(2 * phase) + 0.10 * env * Math.sin(3 * phase));
      }
    }
    items.push({
      id: "ce_F27",
      kind: "counterexample",
      targetFalsifier: "F27_METRONOMIC_CADENCE",
      description: "Robotic metronomic cadence with exact 160 ms inter-onset intervals",
      samples: s,
      sampleRate: sr,
    });
  }

  // F28_MAINS_HUM_DRONE: warm voice contaminated with persistent 60 Hz + 120 Hz + 180 Hz AC mains hum
  {
    const base = genWarmVoice(sr, 0.78, seed + 28, { amp: 0.34, relSec: 0.22 });
    const s = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) {
      const t = i / sr;
      const env = smoothEnv(t, 0.78, 0.08, 0.22);
      const hum =
        0.22 *
        env *
        (Math.sin(2 * Math.PI * 60 * t) +
          0.55 * Math.sin(2 * Math.PI * 120 * t) +
          0.25 * Math.sin(2 * Math.PI * 180 * t));
      s[i] = base[i] + hum;
    }
    items.push({
      id: "ce_F28",
      kind: "counterexample",
      targetFalsifier: "F28_MAINS_HUM_DRONE",
      description: "Warm voice contaminated with 60/120/180 Hz AC mains hum drone",
      samples: s,
      sampleRate: sr,
    });
  }

  // F29_BITCRUSH_ALIASING: warm voice quantized to 4-bit staircase levels
  {
    const base = genWarmVoice(sr, 0.7, seed + 29, { amp: 0.45 });
    const s = new Float32Array(base.length);
    const levels = 8; // harsh 4-bit quantization
    for (let i = 0; i < base.length; i++) {
      s[i] = Math.round(base[i] * levels) / levels;
    }
    items.push({
      id: "ce_F29",
      kind: "counterexample",
      targetFalsifier: "F29_BITCRUSH_ALIASING",
      description: "4-bit quantized bitcrushed warm voice with staircase aliasing",
      samples: s,
      sampleRate: sr,
    });
  }

  // F30_STEREO_PHASE_DISCOMFORT: inverted stereo polarity (R = -0.85 * L) so mono downmix stays warm & clean
  {
    const left = genWarmVoice(sr, 0.68, seed + 30, { amp: 0.44 });
    const right = new Float32Array(left.length);
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      right[i] = -0.85 * left[i];
      mono[i] = 0.5 * (left[i] + right[i]);
    }
    items.push({
      id: "ce_F30",
      kind: "counterexample",
      targetFalsifier: "F30_STEREO_PHASE_DISCOMFORT",
      description: "Phase-inverted stereo warm voice (R = -0.85*L, invisible to mono F1-F6)",
      samples: mono,
      channels: [left, right],
      sampleRate: sr,
    });
  }

  // F31_PRESSED_STRAIN: pressed glottal tension (1-3.5 kHz harmonics overpowering fundamental)
  {
    const dur = 0.7;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 31);
    const drift = makeDriftNoise(n, rand, 0.992);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const u = t / dur;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      const f0 = 310 + 40 * Math.sin(Math.PI * u) + 2.5 * drift[i];
      phase += (2 * Math.PI * f0) / sr;
      // Weak fundamental (0.14), strong strained 5th/6th/7th harmonics (1550-2170 Hz)
      s[i] =
        0.42 *
        env *
        (0.14 * Math.sin(phase) +
          0.16 * Math.sin(2 * phase) +
          0.42 * Math.sin(5 * phase + 0.2) +
          0.48 * Math.sin(6 * phase + 0.5) +
          0.38 * Math.sin(7 * phase + 0.9));
    }
    items.push({
      id: "ce_F31",
      kind: "counterexample",
      targetFalsifier: "F31_PRESSED_STRAIN",
      description: "Pressed/strained glottal vocalization with harsh 1.5-2.5 kHz dominance",
      samples: s,
      sampleRate: sr,
    });
  }

  // F32_SPECTRAL_STASIS: frozen unchanging spectrum over 0.9s
  {
    const dur = 0.9;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = smoothEnv(t, dur, 0.08, 0.16);
      s[i] =
        0.44 *
        env *
        (0.62 * Math.sin(2 * Math.PI * 330 * t) +
          0.28 * Math.sin(2 * Math.PI * 660 * t) +
          0.14 * Math.sin(2 * Math.PI * 990 * t));
    }
    items.push({
      id: "ce_F32",
      kind: "counterexample",
      targetFalsifier: "F32_SPECTRAL_STASIS",
      description: "Frozen static-timbre tone with zero spectral evolution over 0.9s",
      samples: s,
      sampleRate: sr,
    });
  }

  return items;
}

// ============================================================================
// Legacy Katakana Controls & Core F1-F6 Counterexamples
// ============================================================================

function buildLegacyNegatives(sr, seed) {
  const items = [];

  // ナル (symbolic katakana: dry, abrupt cut-off tail -> triggers F5_ABRUPT_TAIL)
  {
    const dur = 0.55;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const cut = Math.round(sr * 0.42);
    let phase = 0;
    for (let i = 0; i < cut; i++) {
      const t = i / sr;
      const atk = t < 0.06 ? t / 0.06 : 1;
      const f0 = 310 + 15 * (t / 0.42);
      phase += (2 * Math.PI * f0) / sr;
      s[i] = 0.44 * atk * (0.62 * Math.sin(phase) + 0.28 * Math.sin(2 * phase) + 0.14 * Math.sin(3 * phase));
    }
    items.push({
      id: "neg_naru_kata",
      kind: "legacy_negative",
      targetFalsifier: "F5_ABRUPT_TAIL",
      description: "ナル (dry symbolic katakana control with abrupt cut-off tail)",
      samples: s,
      sampleRate: sr,
    });
  }

  // ナッタ (hard katakana: sharp attack edge + hard sokuon + abrupt tail -> triggers F1 & F5)
  {
    const dur = 0.58;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const cut = Math.round(sr * 0.46);
    for (let i = Math.round(sr * 0.04); i < cut; i++) {
      const t = i / sr;
      // Hard silent gap (0.20..0.28s) followed by instant sharp attack
      if (t >= 0.20 && t < 0.28) continue;
      const env = t < 0.045 ? (t - 0.04) / 0.005 : 1;
      s[i] =
        0.46 *
        env *
        (0.55 * Math.sin(2 * Math.PI * 330 * t) +
          0.35 * Math.sin(2 * Math.PI * 1650 * t) +
          0.42 * Math.sin(2 * Math.PI * 4600 * t));
    }
    items.push({
      id: "neg_natta_kata",
      kind: "legacy_negative",
      targetFalsifier: "F1_HARSH_EDGE",
      description: "ナッタ (hard katakana control with sharp glottal edge & abrupt release)",
      samples: s,
      sampleRate: sr,
    });
  }

  // Core F1-F6 examples for complete 32-axis coverage in demos & benches
  // ce_F1: Sharp edge / high-freq aggression
  {
    const n = Math.round(sr * 0.52);
    const s = new Float32Array(n);
    for (let i = Math.round(sr * 0.08); i < n; i++) {
      const t = i / sr;
      const env = i > n - Math.round(sr * 0.12) ? (n - i) / Math.round(sr * 0.12) : 1;
      s[i] = 0.48 * env * (Math.sin(2 * Math.PI * 310 * t) + 0.78 * Math.sin(2 * Math.PI * 4400 * t));
    }
    items.push({
      id: "ce_F1",
      kind: "legacy_negative",
      targetFalsifier: "F1_HARSH_EDGE",
      description: "Instant sharp attack with aggressive high-frequency edge",
      samples: s,
      sampleRate: sr,
    });
  }

  // ce_F2: Mechanical rigidity (zero jitter/shimmer)
  {
    const n = Math.round(sr * 0.6);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      s[i] = 0.42 * (Math.sin(2 * Math.PI * 300 * t) + 0.3 * Math.sin(2 * Math.PI * 600 * t));
    }
    items.push({
      id: "ce_F2",
      kind: "legacy_negative",
      targetFalsifier: "F2_PURE_ROBOT",
      description: "Perfectly rigid mechanical tone with zero micro-variation",
      samples: s,
      sampleRate: sr,
    });
  }

  // ce_F3: Pure unstructured white noise
  {
    const rand = mulberry32(seed + 3);
    const n = Math.round(sr * 0.55);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      s[i] = 0.38 * smoothEnv(t, 0.55, 0.05, 0.08) * (rand() * 2 - 1);
    }
    items.push({
      id: "ce_F3",
      kind: "legacy_negative",
      targetFalsifier: "F3_PURE_NOISE",
      description: "Unstructured broadband white noise static",
      samples: s,
      sampleRate: sr,
    });
  }

  // ce_F4: Uncoupled channels (hollow / stitched)
  {
    const dur = 0.8;
    const n = Math.round(sr * dur);
    const s = new Float32Array(n);
    const rand = mulberry32(seed + 4);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const u = t / dur;
      // Symmetric amplitude envelope around u=0.5
      const env = smoothEnv(t, dur, 0.16, 0.16) * (0.6 + 0.4 * Math.cos(2 * Math.PI * (u - 0.5)));
      // Strictly anti-symmetric pitch and HF mix around u=0.5 -> zero Pearson correlation with env
      const f0 = 300 + 90 * Math.sin(2 * Math.PI * u);
      const hfMix = 0.35 + 0.32 * Math.sin(2 * Math.PI * u);
      phase += (2 * Math.PI * f0) / sr;
      s[i] = 0.38 * env * (Math.sin(phase) + 0.25 * Math.sin(2 * phase) + hfMix * Math.sin(5 * phase) + 0.015 * (rand() * 2 - 1));
    }
    items.push({
      id: "ce_F4",
      kind: "legacy_negative",
      targetFalsifier: "F4_NO_COMMON_CAUSE",
      description: "Stitched uncoupled amplitude vs pitch/timbre channels",
      samples: s,
      sampleRate: sr,
    });
  }

  // ce_F5: Abrupt cut-off tail
  {
    const n = Math.round(sr * 0.6);
    const s = new Float32Array(n);
    const cut = Math.round(sr * 0.44);
    for (let i = 0; i < cut; i++) {
      const t = i / sr;
      const atk = t < 0.08 ? t / 0.08 : 1;
      s[i] = 0.42 * atk * (0.65 * Math.sin(2 * Math.PI * 320 * t) + 0.25 * Math.sin(2 * Math.PI * 640 * t));
    }
    items.push({
      id: "ce_F5",
      kind: "legacy_negative",
      targetFalsifier: "F5_ABRUPT_TAIL",
      description: "Abrupt hard cut-off tail with zero breath release",
      samples: s,
      sampleRate: sr,
    });
  }

  // ce_F6: Full-scale digital clipping & discontinuity
  {
    const base = genWarmVoice(sr, 0.6, seed + 6, { amp: 0.45 });
    const s = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) {
      s[i] = Math.max(-1, Math.min(1, base[i] * 3.8));
    }
    items.push({
      id: "ce_F6",
      kind: "legacy_negative",
      targetFalsifier: "F6_PHYSICAL_GLITCH",
      description: "Full-scale hard digital clipping exceeding ±0.995",
      samples: s,
      sampleRate: sr,
    });
  }

  return items;
}

/**
 * Build the complete deterministic synthetic corpus.
 *
 * @param {{ sampleRate?: number, seed?: number }} [opts={ sampleRate: 24000, seed: 2026 }]
 * @returns {{ positives: Array<object>, counterexamples: Array<object>, legacyNegatives: Array<object> }}
 */
export function buildCorpus(opts = {}) {
  const sampleRate = opts?.sampleRate ?? 24000;
  const seed = opts?.seed ?? 2026;

  // Clean stereo positive (correlated L/R with gentle natural room width)
  const stereoL = genWarmVoice(sampleRate, 0.68, seed + 901);
  const stereoR = new Float32Array(stereoL.length);
  const stereoMono = new Float32Array(stereoL.length);
  for (let i = 0; i < stereoL.length; i++) {
    stereoR[i] = 0.94 * stereoL[Math.max(0, i - 3)];
    stereoMono[i] = 0.5 * (stereoL[i] + stereoR[i]);
  }

  const positives = [
    {
      id: "pos_warm_voice",
      kind: "positive",
      description: "Warm organic human-like vocal phrase with coupled pitch/timbre and soft release",
      samples: genWarmVoice(sampleRate, 0.68, seed + 101),
      sampleRate,
    },
    {
      id: "pos_sasayaki",
      kind: "positive",
      description: "Sasayaki (soft breathy whisper / sigh) — verifies whisper guard on F31/F21",
      samples: genSasayaki(sampleRate, 0.7, seed + 202),
      sampleRate,
    },
    {
      id: "pos_bird_chirp",
      kind: "positive",
      description: "Gentle two-syllable bird chirp (non-vocal pleasant natural sound)",
      samples: genBirdChirp(sampleRate, 0.7, seed + 303),
      sampleRate,
    },
    {
      id: "pos_marimba",
      kind: "positive",
      description: "Warm wooden marimba 3-note rubato phrase (non-vocal acoustic instrument)",
      samples: genMarimba(sampleRate, 0.95, seed + 404),
      sampleRate,
    },
    {
      id: "pos_celesta_chime",
      kind: "positive",
      description: "Gentle celesta / UI notification chime (non-vocal pleasant UI sound)",
      samples: genCelestaChime(sampleRate, 0.85, seed + 505),
      sampleRate,
    },
    {
      id: "pos_lullaby",
      kind: "positive",
      description: "Soft lullaby hum with warm descending melodic contour",
      samples: genLullaby(sampleRate, 0.9, seed + 606),
      sampleRate,
    },
    {
      id: "pos_naru",
      kind: "positive",
      description: "鳴る — softly opening vocalization melting into a gradual breathy tail",
      samples: genNaru(sampleRate, 0.72, seed + 707),
      sampleRate,
    },
    {
      id: "pos_natta",
      kind: "positive",
      description: "鳴った — rounded cushioned sokuon landing with gentle release",
      samples: genNatta(sampleRate, 0.76, seed + 808),
      sampleRate,
    },
    {
      id: "pos_clean_stereo",
      kind: "positive",
      description: "Warm correlated stereo vocalization (gentle natural stereo width)",
      samples: stereoMono,
      channels: [stereoL, stereoR],
      sampleRate,
    },
  ];

  const counterexamples = buildCounterexamples(sampleRate, seed);
  const legacyNegatives = buildLegacyNegatives(sampleRate, seed);

  return { positives, counterexamples, legacyNegatives };
}
