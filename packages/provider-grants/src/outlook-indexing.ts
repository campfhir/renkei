/**
 * The per-user Outlook indexing opt-in, stored on the Microsoft grant's
 * metadata (`metadata.indexing`). Scopes alone are not consent: a user
 * grants Calendars.Read to use the calendar TOOLS, and that must not
 * silently put their calendar into the knowledge index — each category is
 * indexed only where scope AND this preference agree. Absent = off, which
 * makes off the default for every new (and every pre-existing) grant.
 *
 * Lives here so the web UI that writes the preference and the worker that
 * enforces it parse one shape — two parsers is how they would drift.
 */

export interface OutlookIndexingPrefs {
  mail: boolean;
  calendar: boolean;
  tasks: boolean;
}

export const OUTLOOK_INDEXING_CATEGORIES = ['mail', 'calendar', 'tasks'] as const;

export function outlookIndexingOf(metadata: Record<string, unknown>): OutlookIndexingPrefs {
  const raw =
    typeof metadata.indexing === 'object' &&
    metadata.indexing !== null &&
    !Array.isArray(metadata.indexing)
      ? metadata.indexing
      : {};
  const prefs: Record<string, unknown> = { ...raw };
  return {
    mail: prefs.mail === true,
    calendar: prefs.calendar === true,
    tasks: prefs.tasks === true,
  };
}
