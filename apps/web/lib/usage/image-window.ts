/**
 * The DB-free side of image usage: how a byte count reads, and who ranks
 * where. Shared by the two usage pages' viewers (client components), so
 * nothing here touches a database. The twin of voice-window.ts.
 */

export interface ImageUserRow {
  subject: string;
  label: string;
  /** Pictures drawn for them. */
  images: number;
  /** The files as kept — the measure the board ranks by. */
  bytes: number;
  /** Tokens the provider billed, where it reports any. */
  inputTokens: number;
  outputTokens: number;
}

export interface RankedImageUserRow extends ImageUserRow {
  /** 1-based position among everyone with any images in the window. */
  rank: number;
}

/**
 * The leaderboard: everyone with any images, biggest total first (name
 * breaks a tie), the top few kept, plus the selected person's own row and
 * rank whether or not it made the top — the shape `rankVoiceUsers` gives
 * the voice boards.
 */
export function rankImageUsers(
  rows: readonly ImageUserRow[],
  subject: string | null,
  top = 5
): { top: RankedImageUserRow[]; selected: RankedImageUserRow | null } {
  const ranked = rows
    .filter((row) => row.images > 0)
    .sort((left, right) => right.bytes - left.bytes || left.label.localeCompare(right.label))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return {
    top: ranked.slice(0, top),
    selected: subject === null ? null : (ranked.find((row) => row.subject === subject) ?? null),
  };
}

/**
 * One hour (or one day) of pictures as the database cuts it: `day` is the
 * key in the viewer's zone, `YYYY-MM-DD` or `YYYY-MM-DDTHH` for an hourly
 * series — the same keys the token series uses.
 */
export interface ImageDay {
  day: string;
  images: number;
  bytes: number;
  inputTokens: number;
  outputTokens: number;
}

/** One bar of the chart: an hour, a day, a week or a month, sized for the period. */
export interface ImageBucket {
  /** Bucket start — the x-axis key. */
  bucket: string;
  /** "Aug 12", "Aug 2026" for a monthly bucket, or "1 PM" for an hourly one. */
  label: string;
  images: number;
  bytes: number;
  inputTokens: number;
  outputTokens: number;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Bytes as a person reads them, 1024 to the step like the file chips:
 * `812 B`, `48 KB`, `3.4 MB`, `1.20 GB`. Whole numbers where the number is
 * already large, so a column of them lines up; a figure that would round
 * up to the next unit's 1024 moves to that unit instead.
 */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (unit < UNITS.length - 1 && Math.round(value) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const digits = unit >= 3 ? 2 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/**
 * The rows the board shows: the top, and the selected person appended
 * when they rank below it. `gapAtRank` is the rank before which an
 * ellipsis says ranks were skipped, or null. The same rule voice-window's
 * `boardRows` applies to the voice boards.
 */
export function boardRows(
  top: RankedImageUserRow[],
  selected: RankedImageUserRow | null
): { rows: RankedImageUserRow[]; gapAtRank: number | null } {
  if (selected === null || top.some((row) => row.subject === selected.subject)) {
    return { rows: top, gapAtRank: null };
  }
  return {
    rows: [...top, selected],
    gapAtRank: selected.rank > top.length + 1 ? selected.rank : null,
  };
}
