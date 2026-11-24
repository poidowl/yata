/**
 * clipset.mjs — load PD/CC0 clip manifests into 24 kHz mono samples (shared by run_heldout & real_voice_gate).
 * curl + ffmpeg only when --fetch; SHA-256 of the trimmed WAV is always checked. Zero npm deps.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { decodeWavBuffer } from "../../unkawaii_detector.mjs";

export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const readManifest = (name) => JSON.parse(fs.readFileSync(path.join(HERE, name), "utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** PD/CC0 only: rejects any BY / BY-SA / NC wording and VOICEVOX-like sources. */
export function isPdCc0(license = "", source = "") {
  return /^(public domain|cc0)/i.test(license.trim()) && !/\bBY\b|\bSA\b|\bNC\b|voicevox/i.test(`${license} ${source}`);
}

export function argDirs(argv) {
  const dirs = [];
  argv.forEach((a, i) => (a === "--cache-dir" && argv[i + 1] ? dirs.push(path.resolve(argv[i + 1])) : 0));
  return dirs;
}

/** Returns [{clip, samples, sampleRate, shaOk}] ; missing clips are reported, not silently dropped. */
export function loadClips(clips, { dirs = [], fetch = false, file = (c) => `${c.formerId || c.id}.wav` } = {}) {
  const out = [], missing = [];
  for (const c of clips) {
    let p = dirs.map((d) => path.join(d, c.wavFilename || file(c))).find((x) => fs.existsSync(x));
    if (!p && fetch && /^https?:/.test(c.sourceUrl) && dirs[0]) {
      p = path.join(dirs[0], c.wavFilename || file(c));
      fs.mkdirSync(dirs[0], { recursive: true });
      execFileSync("curl", ["-fsSL", "-A", "yata-heldout/0.11", "-o", `${p}.raw`, c.sourceUrl]);
      execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(c.trimStartSec ?? 0),
        "-t", String(c.trimDurationSec ?? 3), "-i", `${p}.raw`, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", p]);
    }
    if (!p) { missing.push(c.id); continue; }
    const buf = fs.readFileSync(p), d = decodeWavBuffer(buf), want = c.wavSha256 || c.sha256;
    out.push({ clip: c, samples: d.samples, sampleRate: d.sampleRate, shaOk: want ? sha(buf) === want : null });
  }
  if (missing.length) console.error(`[clipset] missing (pass --fetch --cache-dir DIR): ${missing.join(", ")}`);
  return out;
}
