/**
 * Writing fields that a project may not accept, without losing the value.
 *
 * A field existing on a site does not mean it can be written on this issue.
 * Jira refuses a field that is not on the project's create or edit screen, one
 * the caller cannot edit, or timetracking when time tracking is switched off —
 * and it refuses the whole request, so one unavailable field takes the summary
 * and the assignee down with it. That is the wrong trade for the case this
 * exists to serve: a planning session's decisions are worth more than the
 * guarantee that they all land in the right column.
 *
 * So a write degrades. Jira names the fields it refused, those are dropped, and
 * the request goes again, until what remains is accepted or nothing droppable
 * is left. What could not be written is recorded as a comment on the issue, so
 * the value survives in a form a person can act on even when the field will not
 * take it.
 *
 * The mandatory fields — a project, a type, a summary — are never dropped. An
 * issue that cannot be identified is not worth creating.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface FieldWritePlan {
  /** Sent on every attempt. A failure here is a real failure. */
  required: Record<string, unknown>;
  /** Dropped if Jira names them, keyed by field id. */
  optional: Record<string, unknown>;
  /** Field id -> `Story Points → 5`, for the reply and the comment. */
  labels: Record<string, string>;
  /**
   * Field id -> "Valid options: …", appended to a refusal's reason so the
   * caller's retry knows what the field would have accepted.
   */
  hints?: Record<string, string>;
}

/** A value that never reached a request, and why. */
export interface UnwrittenField {
  label: string;
  reason: string;
}

export interface FieldWriteOutcome<T> {
  /** Null when nothing was sent, because everything sendable was refused. */
  result: T | null;
  sent: boolean;
  /** Fields Jira refused, in the order they were dropped. */
  dropped: UnwrittenField[];
  /** How many requests were made. One means nothing was refused. */
  attempts: number;
}

/**
 * Read Jira's per-field complaints off an error.
 *
 * Structural rather than an instanceof check, so this works on a JiraApiError
 * without importing it — that import would be circular — and on anything else
 * carrying the same shape.
 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!isRecord(error) || !isRecord(error.fieldErrors)) return {};

  const errors: Record<string, string> = {};
  for (const [field, message] of Object.entries(error.fieldErrors)) {
    errors[field] = String(message);
  }
  return errors;
}

/**
 * Which of the droppable fields this error blames.
 *
 * Falls back to looking for the field id in the message, because Jira sometimes
 * reports a rejected field only in `errorMessages` prose — "Field
 * 'customfield_10016' cannot be set" — with no `errors` map to read.
 */
export function refusedFields(error: unknown, optional: Record<string, unknown>): string[] {
  const keys = Object.keys(optional);
  if (keys.length === 0) return [];

  const named = fieldErrorsOf(error);
  const blamed = keys.filter((key) => key in named);
  if (blamed.length > 0) return blamed;

  const message = isRecord(error) && typeof error.message === 'string' ? error.message : '';
  if (message === '') return [];
  return keys.filter((key) => blamedInMessage(message, key));
}

/**
 * Whether the message blames this field, without reading a coincidence as blame.
 *
 * A bare substring test is not safe here: the built-in ids are ordinary words,
 * so "you do not have permission to edit the summary" would look like a refusal
 * of `summary` and drop it. Jira quotes the field when it names one — Field
 * 'customfield_10016' cannot be set — so a quoted hit counts, and otherwise only
 * a customfield id, which cannot appear in prose by accident.
 */
function blamedInMessage(message: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`['"\`\\[]${escaped}['"\`\\]]`).test(message)) return true;
  return key.startsWith('customfield_') && message.includes(key);
}

/**
 * Send `plan`, dropping whatever Jira refuses, until it is accepted.
 *
 * Terminates because every retry removes at least one field from `optional`: an
 * error that blames nothing droppable is rethrown rather than retried, so a
 * request that fails on a required field fails once.
 */
export async function writeWithFieldFallback<T>(
  plan: FieldWritePlan,
  send: (fields: Record<string, unknown>) => Promise<T>
): Promise<FieldWriteOutcome<T>> {
  const optional = { ...plan.optional };
  const dropped: UnwrittenField[] = [];
  let attempts = 0;

  for (;;) {
    // Everything sendable has been refused. An update with no fields left is a
    // request Jira would reject anyway, so it is not worth making.
    if (Object.keys(plan.required).length === 0 && Object.keys(optional).length === 0) {
      return { result: null, sent: false, dropped, attempts };
    }

    attempts += 1;
    try {
      const result = await send({ ...plan.required, ...optional });
      return { result, sent: true, dropped, attempts };
    } catch (error) {
      const refused = refusedFields(error, optional);
      if (refused.length === 0) throw error;

      const named = fieldErrorsOf(error);
      for (const field of refused) {
        const hint = plan.hints?.[field];
        const reason = named[field] ?? 'refused by Jira';
        dropped.push({
          label: plan.labels[field] ?? field,
          reason: hint ? `${reason} — ${hint}` : reason,
        });
        delete optional[field];
      }
    }
  }
}

/**
 * The comment left behind for values that could not be written.
 *
 * Phrased for whoever opens the issue next, not for the tool that gave up: it
 * says what the value was and why it is not in its field, which is what someone
 * needs in order to set it by hand or fix the screen configuration.
 */
export function unwrittenFieldsComment(unwritten: readonly UnwrittenField[]): string {
  return [
    'These values were agreed but could not be written to their fields:',
    '',
    ...unwritten.map((field) => `- **${field.label}** — ${field.reason}`),
    '',
    '_Recorded here so the value is not lost. Set them by hand, or add the field to this' +
      " project's screen and try again._",
  ].join('\n');
}
