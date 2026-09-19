/**
 * The voice boards' arithmetic, pinned: a duration reads the way a
 * person says it, a board ranks by one measure and drops the people with
 * none of it, and the selected person appears below the top with the
 * ellipsis only when ranks were actually skipped.
 */

import { boardRows, formatDuration, rankVoiceUsers, type VoiceUserRow } from './voice-window';

const row = (subject: string, speech: number, transcription: number): VoiceUserRow => ({
  subject,
  label: subject,
  speechCharacters: speech,
  speechCalls: speech > 0 ? 1 : 0,
  transcriptionMs: transcription,
  transcriptionCalls: transcription > 0 ? 1 : 0,
});

describe('formatDuration', () => {
  it('reads as seconds, then minutes and seconds, then hours and minutes', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(41_600)).toBe('42s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
  });
});

describe('rankVoiceUsers', () => {
  const people = [row('ann', 500, 0), row('bo', 900, 30_000), row('cy', 0, 90_000)];

  it('ranks by the chosen measure and leaves out people with none of it', () => {
    const listeners = rankVoiceUsers(people, 'speech', null);
    expect(listeners.top.map((r) => [r.subject, r.rank])).toEqual([
      ['bo', 1],
      ['ann', 2],
    ]);
    const speakers = rankVoiceUsers(people, 'transcription', null);
    expect(speakers.top.map((r) => r.subject)).toEqual(['cy', 'bo']);
  });

  it('finds the selected person below the top, and the ellipsis only past a gap', () => {
    const many = [
      row('a', 90, 0),
      row('b', 80, 0),
      row('c', 70, 0),
      row('d', 60, 0),
      row('e', 50, 0),
      row('f', 40, 0),
      row('g', 30, 0),
    ];
    const sixth = rankVoiceUsers(many, 'speech', 'f', 5);
    expect(sixth.selected?.rank).toBe(6);
    expect(boardRows(sixth.top, sixth.selected)).toMatchObject({ gapAtRank: null });
    expect(boardRows(sixth.top, sixth.selected).rows).toHaveLength(6);
    const seventh = rankVoiceUsers(many, 'speech', 'g', 5);
    expect(boardRows(seventh.top, seventh.selected).gapAtRank).toBe(7);
    const inTop = rankVoiceUsers(many, 'speech', 'b', 5);
    expect(boardRows(inTop.top, inTop.selected).rows).toHaveLength(5);
    const nothing = rankVoiceUsers(many, 'transcription', 'a', 5);
    expect(nothing.selected).toBeNull();
  });
});
