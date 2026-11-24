import test from "node:test";
import assert from "node:assert/strict";
import { decodeWavBuffer, encodeWavBuffer } from "../src/wav.mjs";

function buildCustomWav({
  audioFormat = 1,
  numChannels = 1,
  sampleRate = 24000,
  bitsPerSample = 16,
  dataBytes = Buffer.alloc(0),
  fmtAfterData = false,
  oddJunkChunk = false,
  declaredDataSize = null,
}) {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const fmtChunk = Buffer.alloc(24);
  fmtChunk.write("fmt ", 0, 4, "ascii");
  fmtChunk.writeUInt32LE(16, 4);
  fmtChunk.writeUInt16LE(audioFormat, 8);
  fmtChunk.writeUInt16LE(numChannels, 10);
  fmtChunk.writeUInt32LE(sampleRate, 12);
  fmtChunk.writeUInt32LE(byteRate, 16);
  fmtChunk.writeUInt16LE(blockAlign, 20);
  fmtChunk.writeUInt16LE(bitsPerSample, 22);

  const paddedDataLen = dataBytes.length + (dataBytes.length % 2);
  const dataChunk = Buffer.alloc(8 + paddedDataLen);
  dataChunk.write("data", 0, 4, "ascii");
  dataChunk.writeUInt32LE(declaredDataSize ?? dataBytes.length, 4);
  dataBytes.copy(dataChunk, 8);

  const chunks = [];
  if (oddJunkChunk) {
    // 5-byte odd-sized JUNK chunk + 1 pad byte -> tests even-byte word alignment
    const junk = Buffer.alloc(8 + 5 + 1);
    junk.write("JUNK", 0, 4, "ascii");
    junk.writeUInt32LE(5, 4);
    junk.write("hello", 8, 5, "ascii");
    chunks.push(junk);
  }
  if (fmtAfterData) {
    chunks.push(dataChunk, fmtChunk);
  } else {
    chunks.push(fmtChunk, dataChunk);
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WAVE", 8, 4, "ascii");
  return Buffer.concat([header, body]);
}

test("encodeWavBuffer & decodeWavBuffer: PCM16 mono round-trip", () => {
  const sr = 24000;
  const n = 480;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    src[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / sr);
  }

  const wav = encodeWavBuffer(src, sr);
  assert.ok(Buffer.isBuffer(wav));
  const dec = decodeWavBuffer(wav);

  assert.equal(dec.sampleRate, sr);
  assert.equal(dec.numChannels, 1);
  assert.equal(dec.bitsPerSample, 16);
  assert.equal(dec.samples.length, n);
  assert.equal(dec.channels.length, 1);
  assert.ok(Math.abs(dec.durationSec - n / sr) < 1e-6);

  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(dec.samples[i] - src[i]));
    assert.equal(dec.channels[0][i], dec.samples[i]);
  }
  assert.ok(maxErr < 1e-4, `PCM16 round-trip error too large: ${maxErr}`);
});

test("encodeWavBuffer & decodeWavBuffer: stereo channels preserved and mono downmixed", () => {
  const sr = 22050;
  const n = 256;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = 0.8 * Math.sin((2 * Math.PI * 300 * i) / sr);
    right[i] = -0.4 * Math.sin((2 * Math.PI * 300 * i) / sr);
  }

  const wav = encodeWavBuffer([left, right], sr, { bitsPerSample: 16 });
  const dec = decodeWavBuffer(new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength));

  assert.equal(dec.numChannels, 2);
  assert.equal(dec.channels.length, 2);
  assert.equal(dec.samples.length, n);

  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(dec.channels[0][i] - left[i]) < 1e-4);
    assert.ok(Math.abs(dec.channels[1][i] - right[i]) < 1e-4);
    const expectedMono = 0.5 * (dec.channels[0][i] + dec.channels[1][i]);
    assert.ok(Math.abs(dec.samples[i] - expectedMono) < 1e-6);
  }
});

test("decodeWavBuffer supports PCM 8-bit unsigned, PCM 24-bit signed LE, and IEEE Float32 LE", () => {
  const sr = 16000;
  const src = new Float32Array([-0.75, -0.25, 0, 0.25, 0.75]);

  // 8-bit unsigned
  const wav8 = encodeWavBuffer(src, sr, { bitsPerSample: 8 });
  const dec8 = decodeWavBuffer(wav8);
  assert.equal(dec8.bitsPerSample, 8);
  for (let i = 0; i < src.length; i++) {
    assert.ok(Math.abs(dec8.samples[i] - src[i]) < 0.02);
  }

  // 24-bit signed LE
  const wav24 = encodeWavBuffer(src, sr, { bitsPerSample: 24 });
  const dec24 = decodeWavBuffer(wav24);
  assert.equal(dec24.bitsPerSample, 24);
  for (let i = 0; i < src.length; i++) {
    assert.ok(Math.abs(dec24.samples[i] - src[i]) < 1e-6);
  }

  // IEEE Float 32-bit LE
  const wav32 = encodeWavBuffer(src, sr, { bitsPerSample: 32, float: true });
  const dec32 = decodeWavBuffer(wav32);
  assert.equal(dec32.bitsPerSample, 32);
  for (let i = 0; i < src.length; i++) {
    assert.ok(Math.abs(dec32.samples[i] - src[i]) < 1e-6);
  }
});

test("decodeWavBuffer handles fmt-after-data and odd-sized chunks with word alignment", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(16384, 0);
  pcm.writeInt16LE(-16384, 2);
  pcm.writeInt16LE(8192, 4);
  pcm.writeInt16LE(0, 6);

  const wav = buildCustomWav({
    audioFormat: 1,
    numChannels: 1,
    sampleRate: 24000,
    bitsPerSample: 16,
    dataBytes: pcm,
    fmtAfterData: true,
    oddJunkChunk: true,
  });

  const dec = decodeWavBuffer(wav);
  assert.equal(dec.samples.length, 4);
  assert.ok(Math.abs(dec.samples[0] - 0.5) < 1e-5);
  assert.ok(Math.abs(dec.samples[1] - -0.5) < 1e-5);
  assert.ok(Math.abs(dec.samples[2] - 0.25) < 1e-5);
  assert.equal(dec.samples[3], 0);
});

test("decodeWavBuffer safely clamps truncated dataSize without throwing RangeError", () => {
  const pcm = Buffer.alloc(10); // 5 samples of PCM16
  pcm.writeInt16LE(16384, 0);
  pcm.writeInt16LE(-16384, 2);
  pcm.writeInt16LE(8192, 4);
  pcm.writeInt16LE(-8192, 6);
  pcm.writeInt16LE(4096, 8);

  const wav = buildCustomWav({
    audioFormat: 1,
    numChannels: 1,
    sampleRate: 24000,
    bitsPerSample: 16,
    dataBytes: pcm,
    declaredDataSize: 999999, // wildly overstated header size
  });

  const dec = decodeWavBuffer(wav);
  assert.equal(dec.samples.length, 5);
  assert.ok(Math.abs(dec.samples[0] - 0.5) < 1e-5);
});

test("encodeWavBuffer clamps out-of-range values and replaces non-finite values with 0", () => {
  const wav = encodeWavBuffer(new Float32Array([2.5, -3.0, NaN, Infinity, -Infinity]), 16000);
  const dec = decodeWavBuffer(wav);
  assert.equal(dec.samples.length, 5);
  assert.ok(dec.samples[0] > 0.99 && dec.samples[0] <= 1);
  assert.ok(dec.samples[1] >= -1 && dec.samples[1] < -0.99);
  assert.equal(dec.samples[2], 0);
  assert.equal(dec.samples[3], 0);
  assert.equal(dec.samples[4], 0);
});

test("decodeWavBuffer rejects invalid, incomplete, or unsupported WAV headers", () => {
  assert.throws(() => decodeWavBuffer(Buffer.alloc(4)), /too short/i);
  assert.throws(() => decodeWavBuffer(Buffer.from("NOT_A_WAV_FILE_HEADER")), /RIFF\/WAVE/i);

  // Missing fmt
  const noFmt = Buffer.alloc(20);
  noFmt.write("RIFF", 0);
  noFmt.writeUInt32LE(12, 4);
  noFmt.write("WAVE", 8);
  noFmt.write("data", 12);
  noFmt.writeUInt32LE(0, 16);
  assert.throws(() => decodeWavBuffer(noFmt), /fmt/i);

  // Missing data
  const noData = Buffer.alloc(36);
  noData.write("RIFF", 0);
  noData.writeUInt32LE(28, 4);
  noData.write("WAVE", 8);
  noData.write("fmt ", 12);
  noData.writeUInt32LE(16, 16);
  noData.writeUInt16LE(1, 20);
  noData.writeUInt16LE(1, 22);
  noData.writeUInt32LE(24000, 24);
  noData.writeUInt16LE(16, 34);
  assert.throws(() => decodeWavBuffer(noData), /data/i);

  // Unsupported format (A-law = 6)
  const alaw = buildCustomWav({ audioFormat: 6, bitsPerSample: 8, dataBytes: Buffer.alloc(8) });
  assert.throws(() => decodeWavBuffer(alaw), /Unsupported WAV/i);

  // Invalid channels / sampleRate
  const zeroCh = buildCustomWav({ numChannels: 0, dataBytes: Buffer.alloc(8) });
  assert.throws(() => decodeWavBuffer(zeroCh), /numChannels/i);
  const zeroSr = buildCustomWav({ sampleRate: 0, dataBytes: Buffer.alloc(8) });
  assert.throws(() => decodeWavBuffer(zeroSr), /sampleRate/i);
});
