/**
 * The time window the logs page looks at.
 *
 * The adapter applies its own default when a query names no bounds — yesterday
 * to the end of today — which is not visible anywhere in the UI. The date picker
 * rendered empty while the query was scoped to roughly 24 hours, so a tenant
 * whose activity was older than that read as having no logs at all.
 *
 * Two rules fix that, and both are about the page and the query agreeing:
 * the default range is explicit, so the picker shows what is being searched;
 * and clearing the range means everything, not a silent fall back to the
 * adapter's day.
 */

/** How far back the page looks before anyone touches the picker. */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * The levels a fresh page load searches.
 *
 * Debug and info are the overwhelming majority of rows and almost never what
 * someone opened this page to find — they came because something looked
 * wrong. Starting at warn-and-above puts the interesting rows on the first
 * screen instead of on page nine.
 *
 * It lives beside the window default for the same reason that one exists:
 * the server render and the picker must agree about what is being searched,
 * or the page shows a filtered result while claiming to show everything.
 * Both defaults are therefore explicit and both are reflected in the UI.
 */
export const DEFAULT_LOG_LEVELS = ['warn', 'error', 'critical'];

/**
 * A lower bound old enough to mean "no lower bound".
 *
 * Passed when the picker is cleared, so that state queries every record rather
 * than inheriting the adapter's default of yesterday. The row limit is what
 * keeps the result bounded, not the date.
 */
export const NO_LOWER_BOUND = new Date(0).toISOString();

export interface LogWindow {
  start: string | null;
  end: string | null;
}

/** The window a fresh page load starts with, computed once per load. */
export function defaultLogWindow(now: Date = new Date()): LogWindow {
  const start = new Date(now);
  start.setDate(start.getDate() - DEFAULT_WINDOW_DAYS);
  return { start: start.toISOString(), end: null };
}

/** How to describe the current window when there is nothing in it. */
export function describeWindow(window: LogWindow): string {
  if (!window.start && !window.end) return 'all time';
  if (window.start && !window.end) return `since ${window.start.slice(0, 10)}`;
  if (!window.start && window.end) return `up to ${window.end.slice(0, 10)}`;
  return `${window.start?.slice(0, 10)} to ${window.end?.slice(0, 10)}`;
}
