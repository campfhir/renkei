/**
 * A question card's answering state (question-actions.tsx): what the
 * person has answered, what each field is marked with, and what the send
 * left on screen.
 *
 * The component posts the answers and dispatches what came back; what the
 * card decides — what a choice or "Something else" does to an answer, when
 * the local check stops a send, what a 422, a 502 or a refusal leaves on
 * screen, how the questions are numbered and labelled — is here, and tested
 * in question-actions.model.test.ts.
 */

import { isRecord } from '@renkei/guards';
import {
  checkQuestionAnswers,
  otherAnswer,
  otherAnswerText,
  type QuestionAnswerValue,
  type QuestionField,
} from '@renkei/agents';

export interface QuestionState {
  answers: Record<string, QuestionAnswerValue>;
  /** Field name → the message under its control. */
  fieldErrors: Record<string, string>;
  busy: boolean;
  /** Saved, but the run is slow to wake (a 502 with a warning). */
  notice: string | null;
  error: string | null;
}

/** What the server's answer to a send means for the card. */
export type SendOutcome =
  | { kind: 'answered' }
  | { kind: 'saved-late'; warning: string }
  | { kind: 'refused'; error: string; fieldErrors: Record<string, string> };

export type QuestionAction =
  | { type: 'answered'; name: string; value: QuestionAnswerValue }
  /** The local check (the server's own function) found problems; nothing was sent. */
  | { type: 'checkFailed'; fieldErrors: Record<string, string> }
  | { type: 'sent' }
  | { type: 'outcome'; outcome: SendOutcome }
  | { type: 'settled' };

export const initialQuestion: QuestionState = {
  answers: {},
  fieldErrors: {},
  busy: false,
  notice: null,
  error: null,
};

export function questionReducer(state: QuestionState, action: QuestionAction): QuestionState {
  switch (action.type) {
    case 'answered': {
      // Changing an answer clears the mark on that field, and only that one.
      const { [action.name]: _cleared, ...rest } = state.fieldErrors;
      return {
        ...state,
        answers: { ...state.answers, [action.name]: action.value },
        fieldErrors: state.fieldErrors[action.name] ? rest : state.fieldErrors,
      };
    }
    case 'checkFailed':
      return { ...state, fieldErrors: action.fieldErrors };
    case 'sent':
      return { ...state, busy: true, error: null, notice: null, fieldErrors: {} };
    case 'outcome': {
      const { outcome } = action;
      if (outcome.kind === 'saved-late') return { ...state, notice: outcome.warning };
      if (outcome.kind === 'refused') {
        return {
          ...state,
          error: outcome.error,
          // The server is the one whose answer counts: mark whatever it named.
          fieldErrors:
            Object.keys(outcome.fieldErrors).length > 0 ? outcome.fieldErrors : state.fieldErrors,
        };
      }
      return state;
    }
    case 'settled':
      return { ...state, busy: false };
  }
}

/**
 * The marks the local check puts on the form before anything is sent, or
 * null when it passes (a card with no fields always passes).
 */
export function checkBeforeSend(
  fields: QuestionField[],
  answers: Record<string, QuestionAnswerValue>
): Record<string, string> | null {
  if (fields.length === 0) return null;
  const checked = checkQuestionAnswers(fields, answers);
  if (checked.ok) return null;
  return Object.fromEntries(checked.issues.map((issue) => [issue.name, issue.message]));
}

/** What the send's answer means: answered, saved but slow to resume, or refused. */
export function sendOutcomeOf(status: number, body: unknown): SendOutcome {
  const record = isRecord(body) ? body : {};
  if (status === 502 && typeof record.warning === 'string') {
    return { kind: 'saved-late', warning: record.warning };
  }
  if (status >= 200 && status < 300) return { kind: 'answered' };
  const issues = Array.isArray(record.issues) ? record.issues : [];
  const fieldErrors = Object.fromEntries(
    issues.flatMap((issue) =>
      isRecord(issue) && typeof issue.name === 'string' && typeof issue.message === 'string'
        ? [[issue.name, issue.message]]
        : []
    )
  );
  return {
    kind: 'refused',
    error: typeof record.error === 'string' ? record.error : `Request failed (${status})`,
    fieldErrors,
  };
}

/** "Leave any question blank to skip it." — for a batch where nothing is required. */
export function showsSkipHint(fields: QuestionField[]): boolean {
  return fields.length > 1 && fields.every((field) => !field.required);
}

export function sendLabel(fields: QuestionField[]): string {
  return fields.length > 0 ? 'Send the answers' : 'Send';
}

/** A batch question (q1, q2, …) reads as a numbered question: "1.". */
export function questionNumber(name: string): string | null {
  return /^q(\d+)$/.exec(name)?.[1] ?? null;
}

/** A choice field's options as the card draws them: which are checked. */
export function isPicked(
  field: QuestionField,
  value: QuestionAnswerValue | undefined,
  option: string
): boolean {
  return field.type === 'multi' ? Array.isArray(value) && value.includes(option) : value === option;
}

/** A click on an option: a radio replaces the answer, a checkbox adds or removes it. */
export function pickedOption(
  field: QuestionField,
  value: QuestionAnswerValue | undefined,
  option: string
): QuestionAnswerValue {
  if (field.type !== 'multi') return option;
  const picks = Array.isArray(value) ? value : [];
  return picks.includes(option) ? picks.filter((pick) => pick !== option) : [...picks, option];
}

/**
 * The "Something else" choice as it stands: whether it is picked (which
 * opens its box) and what is written in that box.
 */
export function otherChoiceOf(
  field: QuestionField,
  value: QuestionAnswerValue | undefined
): { checked: boolean; own: string; current: string | undefined } {
  const text = typeof value === 'string' ? value : '';
  const picks = Array.isArray(value) ? value : [];
  const current =
    field.type === 'multi'
      ? picks.find((pick) => otherAnswerText(field, pick) !== null)
      : otherAnswerText(field, text) !== null
        ? text
        : undefined;
  return {
    checked: current !== undefined,
    own: current !== undefined ? (otherAnswerText(field, current) ?? '') : '',
    current,
  };
}

/**
 * The answer after the person picks, unpicks or types in "Something else":
 * stored as "Something else: what they wrote", so it still travels as the
 * one string (or one pick) the field binds. `next` null takes it off.
 */
export function withOtherAnswer(
  field: QuestionField,
  value: QuestionAnswerValue | undefined,
  next: string | null
): QuestionAnswerValue {
  const other = field.other ?? '';
  if (field.type !== 'multi') return next === null ? '' : otherAnswer(other, next);
  const picks = Array.isArray(value) ? value : [];
  const { current } = otherChoiceOf(field, value);
  const rest = picks.filter((pick) => pick !== current);
  return next === null ? rest : [...rest, otherAnswer(other, next)];
}

/** A press on the "Something else" control: a checkbox toggles it, a radio picks it. */
export function toggledOther(
  field: QuestionField,
  value: QuestionAnswerValue | undefined
): QuestionAnswerValue {
  const { checked, own } = otherChoiceOf(field, value);
  return withOtherAnswer(field, value, checked && field.type === 'multi' ? null : own);
}
