/**
 * The DB-free side of voice usage: how a duration reads, and who ranks
 * where. Shared by the two usage pages' viewers (client components), so
 * nothing here touches a database.
 */

export interface VoiceUserRow {
  subject: string;
  label: string;
  /** Characters of replies read to them. */
  speechCharacters: number;
  speechCalls: number;
  /** Milliseconds of their own voice recognised. */
  transcriptionMs: number;
  transcriptionCalls: number;
}

export interface RankedVoiceUserRow extends VoiceUserRow {
  /** 1-based position among everyone with any of that measure in the window. */
  rank: number;
}

/** Which way the sound went: `speech` is listening (replies read), `transcription` is speaking. */
export type VoiceMeasure = 'speech' | 'transcription';

export function voiceMeasureOf(row: VoiceUserRow, by: VoiceMeasure): number {
  return by === 'speech' ? row.speechCharacters : row.transcriptionMs;
}

/**
 * The leaderboard for one measure: everyone with any of it, ranked, the
 * top few kept, plus the selected person's own row and rank whether or
 * not it made the top — the shape `rankUsers` gives the token board.
 */
export function rankVoiceUsers(
  rows: readonly VoiceUserRow[],
  by: VoiceMeasure,
  subject: string | null,
  top = 5
): { top: RankedVoiceUserRow[]; selected: RankedVoiceUserRow | null } {
  const ranked = rows
    .filter((row) => voiceMeasureOf(row, by) > 0)
    .sort(
      (left, right) =>
        voiceMeasureOf(right, by) - voiceMeasureOf(left, by) ||
        left.label.localeCompare(right.label)
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return {
    top: ranked.slice(0, top),
    selected: subject === null ? null : (ranked.find((row) => row.subject === subject) ?? null),
  };
}

/**
 * The rows a board shows: the top, and the selected person appended when
 * they rank below it. `gapAtRank` is the rank before which an ellipsis
 * says ranks were skipped, or null.
 */
export function boardRows(
  top: RankedVoiceUserRow[],
  selected: RankedVoiceUserRow | null
): { rows: RankedVoiceUserRow[]; gapAtRank: number | null } {
  if (selected === null || top.some((row) => row.subject === selected.subject)) {
    return { rows: top, gapAtRank: null };
  }
  return {
    rows: [...top, selected],
    gapAtRank: selected.rank > top.length + 1 ? selected.rank : null,
  };
}

/** Milliseconds as a person reads them: `42s`, `3m 12s`, `1h 04m`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours === 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}
