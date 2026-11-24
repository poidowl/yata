/**
 * src/wav.mjs — Zero-dependency pure-JS WAV decoder & encoder.
 *
 * Supports:
 *   - PCM 8-bit unsigned (format=1, bits=8)
 *   - PCM 16-bit signed LE (format=1, bits=16)
 *   - PCM 24-bit signed LE (format=1, bits=24)
 *   - IEEE Float 32-bit LE (format=3, bits=32)
 *   - WAVE_FORMAT_EXTENSIBLE (format=0xFFFE) delegating to SubFormat GUID
 *   - Arbitrary chunk ordering (including `fmt ` appearing after `data`)
 *   - Even-byte RIFF chunk alignment & safe dataSize clamping on truncated files
 *   - Multi-channel preservation (`channels: Float32Array[]`) + mono downmix (`samples`)
 */

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new Error("Invalid WAV input: expected Buffer or Uint8Array");
}

function readAscii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

/**
 * Decode a RIFF/WAVE Buffer or Uint8Array into mono downmix + per-channel Float32Arrays.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer
 * @returns {{
 *   samples: Float32Array,
 *   sampleRate: number,
 *   durationSec: number,
 *   numChannels: number,
 *   bitsPerSample: number,
 *   channels: Float32Array[]
 * }}
 */
export function decodeWavBuffer(buffer) {
  const bytes = toUint8Array(buffer);
  if (bytes.byteLength < 12) {
    throw new Error(`Invalid WAV buffer: too short (${bytes.byteLength} bytes, minimum 12)`);
  }

  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Invalid WAV header: expected RIFF/WAVE");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 12;
  let hasFmt = false;
  let hasData = false;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;

    if (id === "fmt ") {
      if (payloadOffset + 16 > bytes.byteLength || size < 16) {
        throw new Error("Invalid WAV fmt chunk: truncated");
      }
      hasFmt = true;
      audioFormat = view.getUint16(payloadOffset, true);
      numChannels = view.getUint16(payloadOffset + 2, true);
      sampleRate = view.getUint32(payloadOffset + 4, true);
      bitsPerSample = view.getUint16(payloadOffset + 14, true);

      // Handle WAVE_FORMAT_EXTENSIBLE (0xFFFE) by inspecting the first 2 bytes of SubFormat GUID
      if (audioFormat === 0xfffe && size >= 40 && payloadOffset + 26 <= bytes.byteLength) {
        audioFormat = view.getUint16(payloadOffset + 24, true);
      }
    } else if (id === "data") {
      hasData = true;
      dataOffset = payloadOffset;
      dataSize = size;
    }

    const paddedSize = size + (size % 2);
    const nextOffset = payloadOffset + paddedSize;
    if (nextOffset <= offset) break; // overflow guard
    offset = nextOffset;
  }

  if (!hasFmt) {
    throw new Error("WAV fmt chunk not found");
  }
  if (!hasData || dataOffset < 0) {
    throw new Error("WAV data chunk not found");
  }
  if (numChannels < 1) {
    throw new Error(`Invalid WAV numChannels: ${numChannels}`);
  }
  if (sampleRate <= 0) {
    throw new Error(`Invalid WAV sampleRate: ${sampleRate}`);
  }

  const isPcm8 = audioFormat === 1 && bitsPerSample === 8;
  const isPcm16 = audioFormat === 1 && bitsPerSample === 16;
  const isPcm24 = audioFormat === 1 && bitsPerSample === 24;
  const isFloat32 = audioFormat === 3 && bitsPerSample === 32;

  if (!isPcm8 && !isPcm16 && !isPcm24 && !isFloat32) {
    throw new Error(`Unsupported WAV format=${audioFormat}, bitsPerSample=${bitsPerSample}`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameStride = bytesPerSample * numChannels;
  const availableBytes = Math.max(0, bytes.byteLength - dataOffset);
  const clampedDataSize = Math.min(dataSize, availableBytes);
  const frameCount = Math.floor(clampedDataSize / frameStride);

  const channels = Array.from({ length: numChannels }, () => new Float32Array(frameCount));
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    const frameBase = dataOffset + i * frameStride;
    for (let ch = 0; ch < numChannels; ch++) {
      const pos = frameBase + ch * bytesPerSample;
      let val = 0;
      if (isPcm16) {
        val = view.getInt16(pos, true) / 32768;
      } else if (isFloat32) {
        val = view.getFloat32(pos, true);
      } else if (isPcm24) {
        let s24 = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16);
        if (s24 & 0x800000) s24 |= ~0xffffff;
        val = s24 / 8388608;
      } else if (isPcm8) {
        val = (view.getUint8(pos) - 128) / 128;
      }
      if (!Number.isFinite(val)) val = 0;
      channels[ch][i] = val;
      sum += val;
    }
    samples[i] = sum / numChannels;
  }

  return {
    samples,
    sampleRate,
    durationSec: frameCount / sampleRate,
    numChannels,
    bitsPerSample,
    channels,
  };
}

/**
 * Encode mono Float32Array (or ArrayLike<number>) or multi-channel Float32Array[]
 * into a standard RIFF/WAVE Buffer (PCM16 LE by default).
 *
 * @param {Float32Array|ArrayLike<number>|Float32Array[]} samplesOrChannels
 * @param {number} sampleRate
 * @param {{ bitsPerSample?: number, float?: boolean }} [opts]
 * @returns {Buffer}
 */
export function encodeWavBuffer(samplesOrChannels, sampleRate, opts = { bitsPerSample: 16 }) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`);
  }

  const isMultiChannel =
    Array.isArray(samplesOrChannels) &&
    samplesOrChannels.length > 0 &&
    (ArrayBuffer.isView(samplesOrChannels[0]) || Array.isArray(samplesOrChannels[0]));

  const channels = isMultiChannel ? samplesOrChannels : [samplesOrChannels ?? new Float32Array(0)];
  const numChannels = channels.length;
  if (numChannels < 1) {
    throw new Error("encodeWavBuffer requires at least one channel");
  }

  let frameCount = 0;
  for (let ch = 0; ch < numChannels; ch++) {
    if (channels[ch].length > frameCount) frameCount = channels[ch].length;
  }

  const bitsPerSample = opts?.bitsPerSample ?? 16;
  const isFloat32 = (bitsPerSample === 32 && opts?.float !== false);
  if (bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 24 && !isFloat32) {
    throw new Error(`Unsupported encode bitsPerSample=${bitsPerSample}`);
  }

  const audioFormat = isFloat32 ? 3 : 1;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = Math.round(sampleRate) * blockAlign;
  const dataSize = frameCount * blockAlign;
  const paddedDataSize = dataSize + (dataSize % 2);
  const totalSize = 44 + paddedDataSize;

  const buf = Buffer.alloc(totalSize);
  buf.write("RIFF", 0, 4, "ascii");
  buf.writeUInt32LE(totalSize - 8, 4);
  buf.write("WAVE", 8, 4, "ascii");

  // fmt chunk
  buf.write("fmt ", 12, 4, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(audioFormat, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(Math.round(sampleRate), 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buf.write("data", 36, 4, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  let pos = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const raw = i < channels[ch].length ? channels[ch][i] : 0;
      const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;

      if (bitsPerSample === 16) {
        const s16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, s16)), pos);
      } else if (isFloat32) {
        buf.writeFloatLE(clamped, pos);
      } else if (bitsPerSample === 24) {
        const s24 = clamped < 0 ? Math.round(clamped * 8388608) : Math.round(clamped * 8388607);
        const c24 = Math.max(-8388608, Math.min(8388607, s24));
        buf[pos] = c24 & 0xff;
        buf[pos + 1] = (c24 >> 8) & 0xff;
        buf[pos + 2] = (c24 >> 16) & 0xff;
      } else if (bitsPerSample === 8) {
        const u8 = Math.max(0, Math.min(255, Math.round(clamped * 128 + 128)));
        buf.writeUInt8(u8, pos);
      }
      pos += bytesPerSample;
    }
  }

  return buf;
}
