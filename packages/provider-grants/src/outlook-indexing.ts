/**
 * The per-user Outlook opt-ins, stored on the Microsoft grant's metadata
 * (`metadata.indexing`). Scopes alone are not consent: a user grants
 * Mail.Read to use the mail TOOLS, and that must not silently wire their
 * inbox to anything in the background — each category takes effect only
 * where scope AND this preference agree. Absent = off, which makes off the
 * default for every new (and every pre-existing) grant.
 *
 * The key is still called `indexing` for storage compatibility, but the two
 * categories mean different things now:
 *
 * - `mail`: new mail may WAKE the user's agents — the inbox subscription
 *   publishes the `mail.received` domain event behind the "An email
 *   arrives" trigger. Mail is personal and is never indexed into the org
 *   knowledge index; subscribers read a message live under this grant.
 * - `tasks`: Microsoft To Do items are indexed into knowledge search.
 *
 * Calendar used to be a third category. It is gone — calendar content is
 * personal and left out of the index (migration 135 dropped what had been
 * indexed) — and a `calendar` flag still stored on an older grant is
 * ignored rather than honoured.
 *
 * Lives here so the web UI that writes the preference and the worker that
 * enforces it parse one shape — two parsers is how they would drift.
 */

export interface OutlookIndexingPrefs {
  mail: boolean;
  tasks: boolean;
}

export const OUTLOOK_INDEXING_CATEGORIES = ['mail', 'tasks'] as const;

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
    tasks: prefs.tasks === true,
  };
}
