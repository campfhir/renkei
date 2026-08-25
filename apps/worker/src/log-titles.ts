/**
 * Naming what a sweep actually indexed.
 *
 * "indexed 1 doc(s) from EpicForNEMS / Documents" tells you a number and a
 * container. It does not tell you WHICH document, which is the one thing you
 * want when you are asking whether the thing you just edited made it in —
 * and the handlers already hold every title, they simply were not saying.
 *
 * Two boundaries this holds deliberately:
 *
 *   - Titles only. A document's name is what makes the line actionable; its
 *     contents are what the admin-facing surfaces are carefully kept free of,
 *     and a log line is not the place to relax that.
 *   - Bounded. A round can enqueue hundreds of documents. A log line that
 *     grows with the library is a log line nobody reads and a row nobody
 *     wants to store, so it lists a few and counts the rest.
 */

/** How many titles a line names before it starts counting instead. */
export const MAX_LOGGED_TITLES = 5;

/** Longest single title kept, so one pathological filename cannot dominate. */
const MAX_TITLE_LENGTH = 120;

function tidy(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

/**
 * The phrase a message uses for a set of titles, given the ones kept and how
 * many there were altogether.
 *
 * Never empty: a template that names this must not be able to degrade into a
 * stray `{placeholder}` (see the log-template-fields lint rule for why that
 * is not hypothetical).
 */
export function summariseTitles(kept: readonly string[], total: number): string {
  if (kept.length === 0) return 'no titles recorded';
  const remaining = Math.max(0, total - kept.length);
  return remaining > 0 ? `${kept.join(', ')} and ${remaining} more` : kept.join(', ');
}

/**
 * Collect titles as a round goes, keeping only as many as will be printed.
 *
 * The total is counted separately from the kept list precisely so "and 40
 * more" stays truthful when the list is full.
 */
export class TitleList {
  private readonly kept: string[] = [];
  private total = 0;

  add(title: string | null | undefined): void {
    const value = typeof title === 'string' ? tidy(title) : '';
    if (!value) return;
    this.total += 1;
    if (this.kept.length < MAX_LOGGED_TITLES) this.kept.push(value);
  }

  /** The titles kept, for the structured metadata. */
  titles(): string[] {
    return [...this.kept];
  }

  /** The phrase for the message. */
  summary(): string {
    return summariseTitles(this.kept, this.total);
  }
}
