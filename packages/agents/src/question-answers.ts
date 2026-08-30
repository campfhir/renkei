/**
 * What a form (an `ask_person` call's `FormNode` fields) accepts back.
 *
 * ONE rule set, three callers: the card validates as you type, the answer
 * paths (the web route and the MCP tool) validate what arrives, and the
 * engine binds what was stored. Three copies of "is this a number" would
 * differ within a month, and the one that matters — the server's — is the
 * one nobody would be looking at when they did.
 *
 * A form is a key/value reply and the key is the field's NAME — the same
 * name the answer binds to as a variable, so `{"the issue key": "CIO-12"}`
 * reads the same in the browser's POST, in the stored result, in an MCP
 * call and in the audit trail. A field may also carry the DESTINATION's
 * own key (`customfield_10016`); that travels with the description of the
 * answer, not as the key of it, because what a later step needs is the
 * pair, and what everything else needs is legibility.
 *
 * The checks stop where authoring stops: a number is a number, a choice is
 * one of the choices, a date is a real calendar date. Whether "CIO-12" is
 * the RIGHT issue is not knowable here and stays the agent's job — the
 * point of the types is to spare it the parsing, not the judgement.
 */

import { isValidDateString } from './recurrence';
import { type QuestionField } from './steps';

/** The longest a single text answer may be. */
export const MAX_QUESTION_ANSWER_CHARS = 10_000;

/** One field's answer: a string, or the picks of a multi-select. */
export type QuestionAnswerValue = string | string[];

export interface QuestionAnswerIssue {
  /** The field's name — what the answer was keyed by. */
  name: string;
  /** The field's label, so a caller can say which control is wrong. */
  label: string;
  message: string;
}

export interface QuestionAnswersResult {
  ok: boolean;
  issues: QuestionAnswerIssue[];
  /** name → cleaned value. Only fields that answered appear. */
  values: Record<string, QuestionAnswerValue>;
}

function asStrings(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  return typeof raw === 'string' && raw ? [raw] : [];
}

/**
 * Check a submitted answer set against the form that asked for it.
 *
 * Unknown keys are ignored rather than rejected: a card open in a browser
 * while the run moved on will post the fields it was rendered with, and
 * refusing the whole submission for a field that no longer matters loses a
 * person's typing over a race that isn't their fault.
 */
export function checkQuestionAnswers(fields: QuestionField[], raw: unknown): QuestionAnswersResult {
  const submitted: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : {};
  const issues: QuestionAnswerIssue[] = [];
  const values: Record<string, QuestionAnswerValue> = {};

  for (const field of fields) {
    const label = field.label.trim() || field.name.trim() || 'This field';
    const fail = (message: string): void => {
      issues.push({ name: field.name, label, message });
    };
    const given = submitted[field.name];

    switch (field.type) {
      case 'text':
      case 'longtext': {
        const text = typeof given === 'string' ? given.trim() : '';
        if (!text) {
          if (field.required) fail('Needs an answer.');
          break;
        }
        if (text.length > MAX_QUESTION_ANSWER_CHARS) {
          fail(`Must stay under ${MAX_QUESTION_ANSWER_CHARS} characters.`);
          break;
        }
        values[field.name] = text;
        break;
      }
      case 'number': {
        const text = typeof given === 'number' ? String(given) : String(given ?? '').trim();
        if (!text) {
          if (field.required) fail('Needs a number.');
          break;
        }
        // Number('') is 0 and Number(' 12 ') is 12 — the empty case is
        // handled above, and the trim is why the second one is fine.
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) {
          fail('Must be a number.');
          break;
        }
        if (field.min !== undefined && parsed < field.min) {
          fail(`Must be ${field.min} or more.`);
          break;
        }
        if (field.max !== undefined && parsed > field.max) {
          fail(`Must be ${field.max} or less.`);
          break;
        }
        values[field.name] = String(parsed);
        break;
      }
      case 'date': {
        const text = typeof given === 'string' ? given.trim() : '';
        if (!text) {
          if (field.required) fail('Needs a date.');
          break;
        }
        if (!isValidDateString(text)) {
          fail('Must be a real date, as YYYY-MM-DD.');
          break;
        }
        values[field.name] = text;
        break;
      }
      case 'choice': {
        const options = field.options ?? [];
        const text = typeof given === 'string' ? given.trim() : '';
        if (!text) {
          if (field.required) fail('Pick one.');
          break;
        }
        if (!options.includes(text)) {
          fail('Pick one of the choices offered.');
          break;
        }
        values[field.name] = text;
        break;
      }
      case 'multi': {
        const options = field.options ?? [];
        const picks = [
          ...new Set(
            asStrings(given)
              .map((entry) => entry.trim())
              .filter(Boolean)
          ),
        ];
        if (picks.length === 0) {
          if (field.required) fail('Pick at least one.');
          break;
        }
        if (picks.some((pick) => !options.includes(pick))) {
          fail('Pick from the choices offered.');
          break;
        }
        values[field.name] = picks;
        break;
      }
      default: {
        const unhandled: never = field.type;
        throw new Error(`unknown question field type: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return { ok: issues.length === 0, issues, values };
}

/**
 * One answered field as a line a model can act on: what it was called
 * where the person read it, what the destination calls it, and the value.
 * The destination key is why this is not just "name: value" — a step
 * writing to Jira needs `customfield_10016` beside the 8, not a display
 * name it would have to resolve.
 */
export function describeQuestionAnswer(field: QuestionField, value: QuestionAnswerValue): string {
  const shown = Array.isArray(value) ? value.join(', ') : value;
  const named = field.label.trim() || field.name;
  return `${named}${field.key ? ` [${field.key}]` : ''}: ${shown}`;
}

/**
 * How one stored answer reads as a variable.
 *
 * Multi-select joins with newlines, matching what a loop's collected list
 * binds as its string form — a var chip for either renders the same way,
 * so nothing has to know which produced it.
 */
export function questionAnswerText(value: QuestionAnswerValue): string {
  return Array.isArray(value) ? value.join('\n') : value;
}
