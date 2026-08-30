/**
 * What a form card accepts back.
 *
 * ONE rule set, three callers: the card validates as you type, the decision
 * paths (the web route and the MCP tool) validate what arrives, and the
 * engine binds what was stored. Three copies of "is this a number" would
 * differ within a month, and the one that matters — the server's — is the
 * one nobody would be looking at when they did.
 *
 * Answers are keyed by FIELD ID, never by name. A form can be edited while
 * a run waits behind it; ids survive a rename, so an answer given against
 * the old label still binds to the field the author is looking at now.
 *
 * The checks stop where authoring stops: a number is a number, a choice is
 * one of the choices, a date is a real calendar date. Whether "CIO-12" is
 * the RIGHT issue is not knowable here and stays the agent's job — the
 * point of the types is to spare it the parsing, not the judgement.
 */

import { isValidDateString } from './recurrence';
import { type ApprovalField } from './steps';

/** The longest a single text answer may be. */
export const MAX_APPROVAL_ANSWER_CHARS = 10_000;

/** One field's answer: a string, or the picks of a multi-select. */
export type ApprovalAnswerValue = string | string[];

export interface ApprovalAnswerIssue {
  fieldId: string;
  /** The field's label, so a caller can say which control is wrong. */
  label: string;
  message: string;
}

export interface ApprovalAnswersResult {
  ok: boolean;
  issues: ApprovalAnswerIssue[];
  /** fieldId → cleaned value. Only fields that answered appear. */
  values: Record<string, ApprovalAnswerValue>;
}

function asStrings(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  return typeof raw === 'string' && raw ? [raw] : [];
}

/**
 * Check a submitted answer set against the form that asked for it.
 *
 * Unknown keys are ignored rather than rejected: a card open in a browser
 * while its step was edited will post the fields it was rendered with, and
 * refusing the whole submission for a field that no longer exists loses a
 * person's typing over an author's edit.
 */
export function checkApprovalAnswers(fields: ApprovalField[], raw: unknown): ApprovalAnswersResult {
  const submitted: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : {};
  const issues: ApprovalAnswerIssue[] = [];
  const values: Record<string, ApprovalAnswerValue> = {};

  for (const field of fields) {
    const label = field.label.trim() || field.name.trim() || 'This field';
    const fail = (message: string): void => {
      issues.push({ fieldId: field.id, label, message });
    };
    const given = submitted[field.id];

    switch (field.type) {
      case 'text':
      case 'longtext': {
        const text = typeof given === 'string' ? given.trim() : '';
        if (!text) {
          if (field.required) fail('Needs an answer.');
          break;
        }
        if (text.length > MAX_APPROVAL_ANSWER_CHARS) {
          fail(`Must stay under ${MAX_APPROVAL_ANSWER_CHARS} characters.`);
          break;
        }
        values[field.id] = text;
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
        values[field.id] = String(parsed);
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
        values[field.id] = text;
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
        values[field.id] = text;
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
        values[field.id] = picks;
        break;
      }
      default: {
        const unhandled: never = field.type;
        throw new Error(`unknown approval field type: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return { ok: issues.length === 0, issues, values };
}

/**
 * How one stored answer reads as a variable.
 *
 * Multi-select joins with newlines, matching what a loop's collected list
 * binds as its string form — a var chip for either renders the same way,
 * so nothing has to know which produced it.
 */
export function approvalAnswerText(value: ApprovalAnswerValue): string {
  return Array.isArray(value) ? value.join('\n') : value;
}
