/**
 * The fields an `ask_person` form is built from — the one structured
 * shape a run asks a person for. Shared by the engine (which snapshots the
 * form onto the question card), the card UI, and the answer checks
 * (question-answers.ts), so all three read a field the same way.
 */

/**
 * What one QUESTION control collects — used by the agent-level
 * `ask_person` tool's dynamic form (packages/agents/src/question-form.ts),
 * never by a `needsApproval` gate: a gate is a plain approve/deny/comment
 * decision, nothing about its shape is knowable at authoring time the way
 * a pre-planned form's fields are, so it has no fields of its own.
 *
 * 'text' and 'longtext' differ only in the control's height — both bind a
 * string. The other four exist because the answer's SHAPE is knowable when
 * the model builds the form and it should not have to parse for it: a
 * number arrives as digits, a choice arrives as one of the options given,
 * a date arrives as YYYY-MM-DD. What cannot be checked at the card is still
 * the agent's job — "CIO-12" is a well-formed string and a wrong issue
 * either way.
 */
export type QuestionFieldType = 'text' | 'longtext' | 'number' | 'choice' | 'multi' | 'date';

export interface QuestionField {
  /**
   * The variable this field binds. Two fields in the same form cannot
   * share a name, and neither can a field and a saved result.
   *
   * It is also the KEY an answer comes back under. A form is a key/value
   * reply and this is the key — there is deliberately no id beside it. An
   * id would survive renaming a field while a card waits behind it, which
   * sounds worth having until you notice that renaming a binding already
   * breaks every chip referencing it. Paying for that everywhere — uuids
   * in hand-built JSON, a name→id map at every boundary — buys consistency
   * in one rare window and costs legibility in all of them.
   */
  name: string;
  /** What the person is asked for, rendered above the control. */
  label: string;
  /**
   * What the DESTINATION calls this, when the answer is headed somewhere
   * that has its own identifier: `customfield_10016` for Story Points,
   * a column name, a form id. Optional, opaque, and never interpreted
   * here — it rides along so the step that writes the answer has the key
   * and the value together ("Story Points [customfield_10016]: 8")
   * instead of resolving a display name at run time and hoping.
   */
  key?: string;
  type: QuestionFieldType;
  /** Nothing sends until it has a value. */
  required: boolean;
  /** choice/multi: what the card offers, and the only values it accepts. */
  options?: string[];
  /** number: inclusive bounds, enforced at the card and on submit. */
  min?: number;
  max?: number;
  /** A line under the control — units, format, where to look it up. */
  help?: string;
  /**
   * What the person needs to answer — the evidence behind the question —
   * shown between the question and its control (ask-questions.ts).
   */
  context?: string;
  /**
   * choice/multi: a free-text choice beside the options, labelled this
   * ("Something else"). Picking it opens a box; the answer is stored as
   * `${other}: what they wrote` (otherAnswer), so a reply that fits none
   * of the options is never forced into one.
   */
  other?: string;
}

/** A choice field's free-text answer, as stored: "Something else: …". */
export function otherAnswer(other: string, text: string): string {
  return `${other}: ${text}`;
}

/** The text of a free-text answer, or null when `value` is one of the options. */
export function otherAnswerText(field: Pick<QuestionField, 'other'>, value: string): string | null {
  if (!field.other) return null;
  const prefix = `${field.other}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length).trimStart() : null;
}

/** How many controls one form may carry. A form, not a questionnaire. */
export const MAX_QUESTION_FIELDS = 10;
export const MAX_QUESTION_FIELD_OPTIONS = 25;
export const MAX_QUESTION_FIELD_LABEL_CHARS = 200;
export const MAX_QUESTION_FIELD_OPTION_CHARS = 200;
export const MAX_QUESTION_FIELD_HELP_CHARS = 500;
export const MAX_QUESTION_FIELD_KEY_CHARS = 200;

const QUESTION_FIELD_TYPES = new Set<string>([
  'text',
  'longtext',
  'number',
  'choice',
  'multi',
  'date',
]);

/** One form field, structurally. Business rules are the validator's. */
export function isQuestionField(value: unknown): value is QuestionField {
  if (typeof value !== 'object' || value === null) return false;
  const field: {
    name?: unknown;
    label?: unknown;
    key?: unknown;
    type?: unknown;
    required?: unknown;
    options?: unknown;
    min?: unknown;
    max?: unknown;
    help?: unknown;
    context?: unknown;
    other?: unknown;
  } = value;
  if (typeof field.name !== 'string') return false;
  if (typeof field.label !== 'string') return false;
  if (field.key !== undefined && typeof field.key !== 'string') return false;
  if (typeof field.type !== 'string' || !QUESTION_FIELD_TYPES.has(field.type)) return false;
  if (typeof field.required !== 'boolean') return false;
  if (
    field.options !== undefined &&
    (!Array.isArray(field.options) || !field.options.every((option) => typeof option === 'string'))
  ) {
    return false;
  }
  if (field.min !== undefined && typeof field.min !== 'number') return false;
  if (field.max !== undefined && typeof field.max !== 'number') return false;
  if (field.help !== undefined && typeof field.help !== 'string') return false;
  if (field.context !== undefined && typeof field.context !== 'string') return false;
  if (field.other !== undefined && typeof field.other !== 'string') return false;
  return true;
}

/**
 * Form fields out of untrusted JSON — a `'question'` card stores a
 * SNAPSHOT of the run-time form the model built so the feed can render
 * controls without re-reading the run, and this reads one field list back
 * out of it (question-form.ts's `parseFormNodes` reads the whole tree,
 * groups and paragraphs included; this is the flat-list half other
 * consumers — answer checking, the old single-list card — still want).
 * Anything malformed is dropped rather than thrown on: a card whose spec
 * cannot be read still has to render as something a person can answer.
 */
export function parseQuestionFields(value: unknown): QuestionField[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isQuestionField).slice(0, MAX_QUESTION_FIELDS);
}
