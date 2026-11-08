/**
 * The form card's rules (ask-form-card.tsx): what Send checks, and the
 * message it sends. The controls and the marks under them are the shared
 * question form's; the check is the server's own function, so a bad
 * number is caught under its field before anything is sent.
 */

import { flattenFormFields, type QuestionAnswerValue } from '@renkei/agents';
import {
  askFormAnswersText,
  parseAskFormAnswers,
  type AskFormAnswers,
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
export type AskFormLater =
  { kind: 'none' } | { kind: 'answers'; answers: AskFormAnswers } | { kind: 'other' };

export type AskFormMode = 'fill' | 'answered' | 'closed' | 'view';

/**
 * What the thread did after a form, from the prompts of the turn that
 * follows it: the form's own answers (a message that begins with them,
 * read back into its questions and answers), or anything else the person
 * said instead.
 */
export function formLaterOf(nextTurnPromptTexts: string[] | null): AskFormLater {
  if (nextTurnPromptTexts === null) return { kind: 'none' };
  for (const text of nextTurnPromptTexts) {
    const answers = parseAskFormAnswers(text);
    if (answers) return { kind: 'answers', answers };
  }
  return { kind: 'other' };
}

/**
 * Whether the card can be filled in: only the chat's owner can send, and
 * only while nothing has come after it — the model is waiting on it.
 */
export function askFormMode(input: { later: AskFormLater; canAnswer: boolean }): AskFormMode {
  if (input.later.kind === 'answers') return 'answered';
  if (input.later.kind === 'other') return 'closed';
  return input.canAnswer ? 'fill' : 'view';
}

/** The collapsed card's one line: how much of the form they answered. */
export function askFormSummary(answers: AskFormAnswers): string {
  const total = answers.rows.length;
  if (total === 0) return 'Answered';
  const answered = answers.rows.filter((row) => row.answer !== null).length;
  return `Answered ${answered} of ${total} ${total === 1 ? 'question' : 'questions'}`;
}

/** What Send is called. */
export const ASK_FORM_SEND_LABEL = 'Send answers';

/** What the card says in place of Send. */
export function askFormNote(mode: AskFormMode): string | null {
  if (mode === 'closed') return 'Closed — the conversation moved on without these answers.';
  if (mode === 'view') return 'Only the person who owns this chat can answer.';
  return null;
}
