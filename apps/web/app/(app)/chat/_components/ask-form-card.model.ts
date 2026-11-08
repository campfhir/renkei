/**
 * The form card's rules (ask-form-card.tsx): what Send checks, and the
 * message it sends. The controls and the marks under them are the shared
 * question form's; the check is the server's own function, so a bad
 * number is caught under its field before anything is sent.
 */

import { flattenFormFields, type QuestionAnswerValue } from '@renkei/agents';
import {
  ASK_FORM_ANSWER_PREFIX,
  askFormAnswersText,
  type AskFormRequest,
} from '@/lib/chat/ask-form';
import { checkBeforeSend } from '../../question-actions.model';

export type AskFormSubmission =
  { ok: true; text: string } | { ok: false; fieldErrors: Record<string, string> };

/** The message the answers become, or the mark each wrong answer gets. */
export function askFormSubmission(
  request: AskFormRequest,
  answers: Record<string, QuestionAnswerValue>
): AskFormSubmission {
  const marks = checkBeforeSend(flattenFormFields(request.form), answers);
  if (marks) return { ok: false, fieldErrors: marks };
  return { ok: true, text: askFormAnswersText(request, answers) };
}

/** What came after the form in the thread: nothing yet, the answers, or something else. */
export type AskFormLater = 'none' | 'answers' | 'other';

export type AskFormMode = 'fill' | 'answered' | 'closed' | 'view';

/**
 * What the thread did after a form, from the prompts of the turn that
 * follows it: the form's own answers (a message that begins with them), or
 * anything else the person said instead.
 */
export function formLaterOf(nextTurnPromptTexts: string[] | null): AskFormLater {
  if (nextTurnPromptTexts === null) return 'none';
  return nextTurnPromptTexts.some((text) => text.startsWith(ASK_FORM_ANSWER_PREFIX))
    ? 'answers'
    : 'other';
}

/**
 * Whether the card can be filled in: only the chat's owner can send, and
 * only while nothing has come after it — the model is waiting on it.
 */
export function askFormMode(input: { later: AskFormLater; canAnswer: boolean }): AskFormMode {
  if (input.later === 'answers') return 'answered';
  if (input.later === 'other') return 'closed';
  return input.canAnswer ? 'fill' : 'view';
}

/** What Send is called. */
export const ASK_FORM_SEND_LABEL = 'Send answers';

/** What the card says in place of Send. */
export function askFormNote(mode: AskFormMode): string | null {
  if (mode === 'answered') return 'Answered — your answers are in the message below.';
  if (mode === 'closed') return 'Closed — the conversation moved on without these answers.';
  if (mode === 'view') return 'Only the person who owns this chat can answer.';
  return null;
}
