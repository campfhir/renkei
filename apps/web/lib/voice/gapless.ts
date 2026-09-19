/**
 * The arithmetic of joining synthesised pieces so they sound like one
 * voice: where the sound in a piece actually starts and ends, and how the
 * pieces are placed on the clock. Pure, so speech-queue.ts can be the
 * only place that touches Web Audio and this can be tested without it.
 *
 * A vendor pads each piece with silence — an MP3 encoder's priming frames
 * at the front, a breath's worth at the back — and joined as they come,
 * two sentences have half a second of nothing between them, a very
 * different thing from the pause the same voice makes inside one request.
 * So each piece is cut to its sound with a small margin, and a fixed,
 * natural gap is put between pieces instead.
 */

/** Below this a sample is silence: −40 dBFS. */
const SILENCE = 0.01;
/** Kept before the first sound, so a soft consonant is not clipped. */
export const LEAD_MARGIN_S = 0.03;
/** Kept after the last sound: the tail of the voice, not the vendor's padding. */
export const TAIL_MARGIN_S = 0.06;
/** Silence placed between two pieces: a sentence break, as the voice itself would make one. */
export const PIECE_GAP_S = 0.18;
/** The ramps at each end of a piece, so a cut never clicks. */
export const FADE_S = 0.008;

export interface SoundBounds {
  /** Seconds into the piece where playback starts. */
  offset: number;
  /** Seconds of it to play. */
  duration: number;
}

/**
 * Where the sound is in `samples` (one channel at `sampleRate`), with the
 * margins. A piece with no sound at all is played whole: something the
 * vendor sent is better than nothing, and a silent piece is rare enough
 * not to be worth a special case.
 */
export function soundBounds(samples: Float32Array, sampleRate: number): SoundBounds {
  const whole = { offset: 0, duration: samples.length / sampleRate };
  let first = -1;
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]) > SILENCE) {
      first = index;
      break;
    }
  }
  if (first < 0) return whole;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) <= SILENCE) last -= 1;
  const start = Math.max(0, first / sampleRate - LEAD_MARGIN_S);
  const end = Math.min(whole.duration, (last + 1) / sampleRate + TAIL_MARGIN_S);
  return { offset: start, duration: end - start };
}

/**
 * When the next piece should start: right after the previous one plus the
 * gap, unless that moment has passed — a piece that arrived late (the
 * vendor was slow) starts as soon as the clock allows, and the gap after
 * it is measured from its own end, not from a schedule it missed.
 */
export function nextStart(previousEnd: number, now: number, lead: number): number {
  return Math.max(previousEnd + PIECE_GAP_S, now + lead);
}
