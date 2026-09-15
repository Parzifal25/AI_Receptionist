/**
 * HALO Phase 3 — audio primitives for the media loop.
 *
 * Pure, allocation-conscious helpers: ITU-T G.711 μ-law ↔ linear PCM16,
 * frame energy, duration accounting and a bounded byte queue. No I/O.
 *
 * Internal working format is PCM16 little-endian mono at the call's sample
 * rate (8 kHz on the PSTN). μ-law is only a wire format.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** Encode one linear 16-bit sample to a G.711 μ-law byte. */
export function linearToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.trunc(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode one G.711 μ-law byte to a linear 16-bit sample. */
export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

const DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) table[i] = mulawToLinear(i);
  return table;
})();

/** μ-law bytes → PCM16LE bytes (2× length). */
export function mulawToPcm16(mulaw: Uint8Array): Uint8Array {
  const out = new Uint8Array(mulaw.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < mulaw.length; i++) view.setInt16(i * 2, DECODE_TABLE[mulaw[i]], true);
  return out;
}

/** PCM16LE bytes → μ-law bytes (½ length; a trailing odd byte is dropped). */
export function pcm16ToMulaw(pcm: Uint8Array): Uint8Array {
  const samples = Math.floor(pcm.length / 2);
  const out = new Uint8Array(samples);
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  for (let i = 0; i < samples; i++) out[i] = linearToMulaw(view.getInt16(i * 2, true));
  return out;
}

/** Root-mean-square level of a PCM16LE frame, normalized to 0..1. */
export function pcm16Rms(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

export function bytesPerSecond(encoding: "pcm16le" | "mulaw", sampleRate: number): number {
  return encoding === "pcm16le" ? sampleRate * 2 : sampleRate;
}

export function audioDurationMs(byteLength: number, encoding: "pcm16le" | "mulaw", sampleRate: number): number {
  return (byteLength / bytesPerSecond(encoding, sampleRate)) * 1000;
}

/**
 * A FIFO of byte chunks with a hard byte ceiling. When full, the OLDEST
 * chunks are dropped (live audio: stale audio is worthless) and counted, so
 * a slow consumer can never grow memory without bound.
 */
export class BoundedAudioQueue {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private dropped = 0;

  constructor(private readonly maxBytes: number) {
    if (!(maxBytes > 0)) throw new Error("BoundedAudioQueue requires a positive byte ceiling");
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (chunk.length > this.maxBytes) {
      // Keep only the newest tail of an oversized chunk.
      this.dropped += chunk.length - this.maxBytes;
      chunk = chunk.subarray(chunk.length - this.maxBytes);
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes) {
      const head = this.chunks.shift()!;
      this.bytes -= head.length;
      this.dropped += head.length;
    }
  }

  drain(): Uint8Array[] {
    const out = this.chunks;
    this.chunks = [];
    this.bytes = 0;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }

  get size(): number {
    return this.bytes;
  }

  get droppedBytes(): number {
    return this.dropped;
  }
}
