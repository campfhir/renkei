/**
 * The timing of the detector, pinned: how long a pause must be before an
 * utterance is sent (a breath mid-sentence must not be), what a manual
 * take does and does not do on its own, and the ten-second silence that
 * closes one unasked. Frames are fed straight into the detector — there
 * is no microphone here — at the rate it judges, 50 ms each.
 */

import { UtteranceRecorder, type RecorderOptions, type SpeechEndReason } from './recorder';

const FRAME = 800; // 50 ms at 16 kHz
const SECOND = 20; // frames
const HELD = 16; // loud frames before an utterance counts as words

/** The detector without a microphone: fed frames by hand. */
function harness(over: Partial<RecorderOptions> = {}) {
  const starts: number[] = [];
  const held: number[] = [];
  const pauses: number[] = [];
  const ends: SpeechEndReason[] = [];
  const utterances: number[] = [];
  const sameAsPause: boolean[] = [];
  const recorder = new UtteranceRecorder({
    onSpeechStart: () => starts.push(1),
    onSpeechHeld: (wav) => held.push(wav.byteLength),
    onSpeechPause: (wav) => pauses.push(wav.byteLength),
    onSpeechEnd: (reason) => ends.push(reason),
    onUtterance: (_wav, durationMs, same) => {
      utterances.push(durationMs);
      sameAsPause.push(same);
    },
    onError: () => undefined,
    ...over,
  });
  const feed = (frames: number, loud: boolean) => {
    for (let index = 0; index < frames; index += 1) {
      const frame = new Float32Array(FRAME);
      if (loud) for (let at = 0; at < FRAME; at += 1) frame[at] = at % 2 === 0 ? 0.3 : -0.3;
      recorder.ingest(frame, 16_000);
    }
  };
  return { recorder, feed, starts, held, pauses, ends, utterances, sameAsPause };
}

describe('UtteranceRecorder (auto)', () => {
  it('starts on a few loud frames and keeps recording through a short pause', () => {
    const { feed, starts, ends, utterances } = harness();
    feed(SECOND, false);
    feed(3, true);
    expect(starts).toHaveLength(1);
    feed(SECOND, true);
    // An 800 ms pause used to end the utterance; now it is a breath.
    feed(16, false);
    expect(ends).toHaveLength(0);
    expect(utterances).toHaveLength(0);
    feed(SECOND, true);
    // 1.2 s of quiet is the end.
    feed(23, false);
    expect(ends).toHaveLength(0);
    feed(1, false);
    expect(ends).toEqual(['pause']);
    expect(utterances).toHaveLength(1);
    // Pre-roll, the speech and the closing silence are all in the take.
    expect(utterances[0]).toBeGreaterThan(3_000);
  });

  it('holds only once a few words’ worth of voice has been heard, once per utterance', () => {
    const { feed, starts, held, ends } = harness();
    feed(SECOND, false);
    // Speech starts on the third loud frame; a short sound never holds.
    feed(10, true);
    expect(starts).toHaveLength(1);
    expect(held).toHaveLength(0);
    // A pause inside the utterance counts for nothing: only voice does.
    feed(8, false);
    expect(held).toHaveLength(0);
    // Sixteen loud frames in all — 0.8 s of sound — and it is handed
    // over to be judged, the whole utterance so far as WAV (a 44-byte
    // header, two bytes a sample): the six pre-roll frames (three quiet,
    // the three loud ones that started it), the seven loud after those,
    // the eight-frame pause, and these six.
    feed(6, true);
    expect(held).toHaveLength(1);
    expect(held[0]).toBe(44 + 2 * FRAME * (6 + 7 + 8 + 6));
    feed(SECOND, true);
    expect(held).toHaveLength(1);
    feed(32, false);
    expect(ends).toEqual(['pause']);
    // The next utterance holds again on its own.
    feed(HELD, true);
    expect(starts).toHaveLength(2);
    expect(held).toHaveLength(2);
  });

  it('hands the sound over at a pause, and the close says it is the same sound', () => {
    const { feed, pauses, ends, utterances, sameAsPause } = harness();
    feed(SECOND, false);
    feed(SECOND, true);
    // Eleven quiet frames are a breath; the twelfth is a pause, and
    // everything so far goes out for an early recognition: the six
    // pre-roll frames (three quiet, the three loud that started it),
    // the seventeen loud after those, and the twelve quiet.
    feed(11, false);
    expect(pauses).toHaveLength(0);
    feed(1, false);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toBe(44 + 2 * FRAME * (6 + 17 + 12));
    // The quiet goes on to the close, which sends the utterance and says
    // its words are the ones already handed over.
    feed(12, false);
    expect(pauses).toHaveLength(1);
    expect(ends).toEqual(['pause']);
    expect(utterances).toHaveLength(1);
    expect(sameAsPause).toEqual([true]);
  });

  it('speech after the pause makes the hand-off stale, and a later pause hands over again', () => {
    const { feed, pauses, ends, utterances, sameAsPause } = harness();
    feed(SECOND, false);
    feed(SECOND, true);
    feed(12, false);
    expect(pauses).toHaveLength(1);
    // More words: what was handed over is no longer the whole.
    feed(SECOND, true);
    feed(12, false);
    expect(pauses).toHaveLength(2);
    feed(SECOND, true);
    feed(24, false);
    expect(ends).toEqual(['pause']);
    expect(utterances).toHaveLength(1);
    // The close came 1.2 s after the last words: the pause fired at 0.6 s
    // of that same quiet, so the hand-off is current.
    expect(pauses).toHaveLength(3);
    expect(sameAsPause).toEqual([true]);
  });

  it('a click too short to send is never handed over either', () => {
    const { feed, pauses, utterances } = harness();
    feed(SECOND, false);
    feed(4, true);
    feed(32, false);
    expect(pauses).toHaveLength(0);
    expect(utterances).toHaveLength(0);
  });

  it('a cough: long enough to send, never long enough to hold', () => {
    const { feed, held, ends, utterances } = harness();
    feed(SECOND, false);
    feed(8, true);
    feed(32, false);
    expect(ends).toEqual(['pause']);
    expect(utterances).toHaveLength(1);
    expect(held).toHaveLength(0);
  });

  it('drops a click: a start too short to be a sentence', () => {
    const { feed, ends, utterances } = harness();
    feed(SECOND, false);
    feed(4, true);
    feed(32, false);
    expect(ends).toEqual(['pause']);
    expect(utterances).toHaveLength(0);
  });
});

describe('UtteranceRecorder (manual)', () => {
  it('never starts on its own; Talk starts and Done sends', () => {
    const { recorder, feed, starts, held, pauses, ends, utterances } = harness({ mode: 'manual' });
    feed(SECOND, false);
    feed(2 * SECOND, true);
    expect(starts).toHaveLength(0);
    expect(recorder.taking).toBe(false);
    recorder.beginTake();
    expect(starts).toHaveLength(1);
    expect(recorder.taking).toBe(true);
    feed(SECOND, true);
    // A take is words by definition; the button already interrupted.
    expect(held).toHaveLength(0);
    // A long pause to think is not the end of the take — and nothing is
    // handed over early: the button decides when the take is whole.
    feed(5 * SECOND, false);
    expect(ends).toHaveLength(0);
    expect(pauses).toHaveLength(0);
    feed(SECOND, true);
    recorder.endTake();
    expect(recorder.taking).toBe(false);
    expect(ends).toEqual(['ended']);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]).toBeGreaterThanOrEqual(7_000);
  });

  it('ten seconds of silence closes a take unasked', () => {
    const { recorder, feed, ends, utterances } = harness({ mode: 'manual' });
    recorder.beginTake();
    feed(SECOND, true);
    feed(10 * SECOND - 1, false);
    expect(ends).toHaveLength(0);
    feed(1, false);
    expect(ends).toEqual(['silence']);
    expect(utterances).toHaveLength(1);
    expect(recorder.taking).toBe(false);
  });

  it('Talk then Done at once sends nothing: there was nothing said', () => {
    const { recorder, feed, ends, utterances } = harness({ mode: 'manual' });
    feed(SECOND, false);
    recorder.beginTake();
    feed(2, true);
    recorder.endTake();
    expect(ends).toEqual(['ended']);
    expect(utterances).toHaveLength(0);
  });

  it('a take dropped by muting is over, and nothing is sent', () => {
    const { recorder, feed, ends, utterances } = harness({ mode: 'manual' });
    recorder.beginTake();
    feed(SECOND, true);
    recorder.setMuted(true);
    expect(ends).toEqual(['ended']);
    expect(utterances).toHaveLength(0);
    expect(recorder.taking).toBe(false);
  });
});
