/**
 * Raw 16-bit PCM as it streams from the speech route, turned into
 * segments of samples the queue can put on the clock one after another
 * (speech-queue.ts). Pure, so it can be tested without a network or Web
 * Audio.
 *
 * Two things a chunk boundary does not respect: a sample is two bytes and
 * a chunk may end after one of them (the odd byte is carried into the
 * next), and a chunk may be far shorter than is worth a source node of
 * its own (bytes accumulate until a segment is at least `minSamples`
 * long, and whatever is left goes out at the end).
 */

/** Little-endian signed 16-bit samples as floats in [-1, 1]. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength - (bytes.byteLength % 2)
  );
  const samples = new Float32Array(view.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
}

export class PcmSegmenter {
  private carry: Uint8Array | null = null;
  private pending: Float32Array<ArrayBuffer>[] = [];
  private pendingLength = 0;

  constructor(private readonly minSamples: number) {}

  /** More bytes; a segment when enough have arrived for one, else null. */
  push(bytes: Uint8Array): Float32Array<ArrayBuffer> | null {
    let whole = bytes;
    if (this.carry) {
      whole = new Uint8Array(this.carry.length + bytes.length);
      whole.set(this.carry, 0);
      whole.set(bytes, this.carry.length);
      this.carry = null;
    }
    if (whole.length % 2 === 1) {
      this.carry = whole.slice(whole.length - 1);
      whole = whole.subarray(0, whole.length - 1);
    }
    if (whole.length === 0) return null;
    const samples = pcm16ToFloat(whole);
    this.pending.push(samples);
    this.pendingLength += samples.length;
    if (this.pendingLength < this.minSamples) return null;
    return this.take();
  }

  /** Whatever is left, at the end of the stream; null when nothing is. */
  flush(): Float32Array<ArrayBuffer> | null {
    // A trailing odd byte is not a sample; it is dropped.
    this.carry = null;
    return this.pendingLength > 0 ? this.take() : null;
  }

  private take(): Float32Array<ArrayBuffer> {
    const out = new Float32Array(this.pendingLength);
    let at = 0;
    for (const part of this.pending) {
      out.set(part, at);
      at += part.length;
    }
    this.pending = [];
    this.pendingLength = 0;
    return out;
  }
}
