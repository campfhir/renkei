/**
 * The image board's arithmetic, pinned: bytes read in KB/MB/GB the way the
 * file chips do, the board ranks by size and drops people with no images,
 * and the selected person appears below the top with the ellipsis only
 * when ranks were actually skipped.
 */

import { boardRows, formatBytes, rankImageUsers, type ImageUserRow } from './image-window';

const row = (subject: string, bytes: number, images = bytes > 0 ? 1 : 0): ImageUserRow => ({
  subject,
  label: subject,
  images,
  bytes,
  inputTokens: 0,
  outputTokens: 0,
});

describe('formatBytes', () => {
  it('reads in B, KB, MB, GB and TB, 1024 to the step', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(48 * 1024)).toBe('48.0 KB');
    expect(formatBytes(Math.round(3.4 * 1024 * 1024))).toBe('3.4 MB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
    expect(formatBytes(Math.round(1.2 * 1024 ** 3))).toBe('1.20 GB');
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.00 TB');
  });

  it('moves up a unit rather than print 1024 of the one below', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('is zero for a negative count', () => {
    expect(formatBytes(-5)).toBe('0 B');
  });
});

describe('rankImageUsers', () => {
  it('ranks by bytes, biggest first, and leaves out people with no images', () => {
    const board = rankImageUsers([row('ann', 500), row('bo', 9_000), row('cy', 0)], null);
    expect(board.top.map((r) => [r.subject, r.rank])).toEqual([
      ['bo', 1],
      ['ann', 2],
    ]);
    expect(board.selected).toBeNull();
  });

  it('breaks a tie by name', () => {
    const board = rankImageUsers([row('zed', 100), row('amy', 100)], null);
    expect(board.top.map((r) => r.subject)).toEqual(['amy', 'zed']);
  });

  it('finds the selected person below the top, with the ellipsis only past a gap', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s, i) => row(s, 700 - i * 100));
    const far = rankImageUsers(many, 'g', 5);
    expect(far.top).toHaveLength(5);
    expect(far.selected?.rank).toBe(7);
    expect(boardRows(far.top, far.selected).gapAtRank).toBe(7);

    const near = rankImageUsers(many, 'f', 5);
    expect(near.selected?.rank).toBe(6);
    expect(boardRows(near.top, near.selected).gapAtRank).toBeNull();

    const inTop = rankImageUsers(many, 'b', 5);
    expect(boardRows(inTop.top, inTop.selected)).toEqual({ rows: inTop.top, gapAtRank: null });
  });

  it('has no selected row for someone with no images', () => {
    expect(rankImageUsers([row('ann', 500)], 'nobody').selected).toBeNull();
  });
});
