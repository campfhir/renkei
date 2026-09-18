/**
 * The bytes a vendor receives for an utterance. A wrong header field is a
 * transcription that fails with a vendor message nobody can act on, so the
 * layout is pinned here byte by byte, along with the resampling that makes
 * a 48 kHz microphone into 16 kHz speech.
 */

import { concat, encodeWav, resample, rms } from './wav';

describe('encodeWav', () => {
  it('writes a canonical 44-byte PCM header for 16 kHz mono', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]));
    const view = new DataView(wav);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(wav, offset, length));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 10);
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(10);
    expect(wav.byteLength).toBe(54);
  });

  it('packs samples as little-endian 16-bit, clamped to the range', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]));
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(view.getInt16(48, true)).toBe(-0x4000);
    expect(view.getInt16(50, true)).toBe(0x7fff);
    expect(view.getInt16(52, true)).toBe(-0x8000);
    expect(view.getInt16(54, true)).toBe(0x7fff);
    expect(view.getInt16(56, true)).toBe(-0x8000);
  });
});

describe('resample', () => {
  it('keeps the length ratio and interpolates between neighbours', () => {
    const input = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]);
    const out = resample(input, 48_000, 16_000);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(resample(input, 16_000, 16_000)).toBe(input);
  });
});

describe('rms and concat', () => {
  it('measures loudness and joins frames in order', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array())).toBe(0);
    expect([...concat([new Float32Array([1, 2]), new Float32Array([3])])]).toEqual([1, 2, 3]);
  });
});
