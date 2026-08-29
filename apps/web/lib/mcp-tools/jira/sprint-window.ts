/**
 * A sprint's dates, phrased the same way wherever they are shown.
 *
 * Jira returns `startDate`/`endDate` on every sprint it hands back, and
 * `jira_list_sprints` was dropping them: it rendered name, state and id, and
 * closed with a hint suggesting a table of "Sprint, State, Start, End" — two
 * columns of which it had never provided. A caller asked when the active
 * sprint ends could only answer "the tool did not say", having held the
 * answer in the response it was given.
 *
 * Shared with the daily summary rather than written twice, so "when does
 * this sprint end" reads identically in both.
 */

export interface SprintDates {
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
}

/** The date part of a Jira timestamp, which is what a window is read in. */
function day(value: string | null | undefined): string {
  return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : '';
}

/**
 * The sprint's span. A half-set sprint says which half it has rather than
 * falling back to "dates not set" — a future sprint with a start and no end
 * is a normal thing for a board to hold, and "starts Monday" is the answer
 * someone planning against it needs.
 */
export function sprintWindow(sprint: SprintDates): string {
  const start = day(sprint.startDate);
  const end = day(sprint.endDate);
  if (start && end) return `${start} → ${end}`;
  if (start) return `starts ${start}`;
  if (end) return `ends ${end}`;
  return 'dates not set';
}

/** How much of the sprint has elapsed, which is the number people actually want. */
export function sprintProgress(sprint: SprintDates, now: Date): string {
  if (!sprint.startDate || !sprint.endDate) return '';
  const start = new Date(sprint.startDate).getTime();
  const end = new Date(sprint.endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return '';
  const remainingMs = end - now.getTime();
  const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  if (days < 0) return `ended ${Math.abs(days)}d ago`;
  return `${days}d left`;
}
