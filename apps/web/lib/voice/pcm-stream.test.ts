/**
 * The streamed samples come out exactly as they went in, whatever the
 * chunking: a sample split across two chunks, chunks too small for a
 * segment of their own, and the remainder at the end.
 */

import { PcmSegmenter, pcm16ToFloat } from './pcm-stream';

/** `values` as little-endian 16-bit PCM bytes. */
function bytesOf(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return out;
}

describe('pcm16ToFloat', () => {
  it('scales full-scale samples to ±1 and ignores a trailing odd byte', () => {
    const bytes = new Uint8Array([...bytesOf([-32768, 32767, 0]), 0x7f]);
    expect([...pcm16ToFloat(bytes)]).toEqual([-1, 32767 / 32768, 0]);
  });
});

describe('PcmSegmenter', () => {
  it('holds bytes until a segment is long enough, then hands them over in order', () => {
    const segmenter = new PcmSegmenter(4);
    expect(segmenter.push(bytesOf([1, 2]))).toBeNull();
    const segment = segmenter.push(bytesOf([3, 4, 5]));
    expect(segment).not.toBeNull();
    expect([...segment!].map((value) => Math.round(value * 32768))).toEqual([1, 2, 3, 4, 5]);
    expect(segmenter.flush()).toBeNull();
  });

  it('carries a sample split across two chunks', () => {
    const segmenter = new PcmSegmenter(1);
    const whole = bytesOf([1000, -1000]);
    expect(segmenter.push(whole.subarray(0, 3))).toEqual(pcm16ToFloat(whole.subarray(0, 2)));
    expect(segmenter.push(whole.subarray(3))).toEqual(pcm16ToFloat(whole.subarray(2, 4)));
  });

  it('flushes the remainder at the end of the stream', () => {
    const segmenter = new PcmSegmenter(100);
    expect(segmenter.push(bytesOf([7, 8, 9]))).toBeNull();
    const rest = segmenter.flush();
    expect([...rest!].map((value) => Math.round(value * 32768))).toEqual([7, 8, 9]);
    expect(segmenter.flush()).toBeNull();
  });
});
