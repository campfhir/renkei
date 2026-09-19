/**
 * The cuts and the clock behind gapless speech, pinned: a vendor's
 * padding is trimmed to the sound plus a margin, a silent piece is left
 * whole, and a late piece starts now rather than in the past.
 */

import { LEAD_MARGIN_S, PIECE_GAP_S, TAIL_MARGIN_S, nextStart, soundBounds } from './gapless';

const RATE = 24_000;

/** `seconds` of silence, then `seconds` of tone, then `seconds` of silence. */
function padded(silence: number, tone: number, trailing = silence): Float32Array {
  const out = new Float32Array(Math.round((silence + tone + trailing) * RATE));
  const from = Math.round(silence * RATE);
  const to = from + Math.round(tone * RATE);
  for (let index = from; index < to; index += 1) out[index] = 0.3 * Math.sin(index / 10);
  return out;
}

describe('soundBounds', () => {
  it('cuts the padding to the sound plus its margins', () => {
    const bounds = soundBounds(padded(0.5, 1), RATE);
    expect(bounds.offset).toBeCloseTo(0.5 - LEAD_MARGIN_S, 3);
    expect(bounds.duration).toBeCloseTo(1 + LEAD_MARGIN_S + TAIL_MARGIN_S, 2);
  });

  it('never cuts before the start or past the end', () => {
    const bounds = soundBounds(padded(0.01, 1, 0.02), RATE);
    expect(bounds.offset).toBe(0);
    expect(bounds.offset + bounds.duration).toBeCloseTo(1.03, 3);
  });

  it('plays a silent piece whole', () => {
    const bounds = soundBounds(new Float32Array(RATE), RATE);
    expect(bounds).toEqual({ offset: 0, duration: 1 });
  });

  it('ignores the hiss under −40 dB', () => {
    const samples = padded(0.5, 1);
    for (let index = 0; index < samples.length; index += 7) samples[index] += 0.005;
    expect(soundBounds(samples, RATE).offset).toBeCloseTo(0.5 - LEAD_MARGIN_S, 3);
  });
});

describe('nextStart', () => {
  it('follows the previous piece by the gap when it is ready in time', () => {
    expect(nextStart(10, 8, 0.02)).toBeCloseTo(10 + PIECE_GAP_S);
  });

  it('starts a late piece now, never in the past', () => {
    expect(nextStart(10, 12, 0.02)).toBeCloseTo(12.02);
  });
});
