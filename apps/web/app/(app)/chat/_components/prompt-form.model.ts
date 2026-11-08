/**
 * The form a prompt's variables open: what it starts with, and what Insert
 * puts in the message box. The controls and their marks are the shared
 * question form's (question-form.tsx); this is only the step from a
 * prompt's template and the person's answers to the text, or to the marks
 * that stop it.
 */

import { checkQuestionAnswers, type QuestionAnswerValue, type QuestionField } from '@renkei/agents';
import {
  fillPromptTemplate,
  type PromptAnswer,
  type PromptVariables,
} from '@/lib/chat/prompt-variables';

/** The answers the form starts with: each variable's default, where it has one. */
export function initialPromptAnswers(
  variables: Pick<PromptVariables, 'fields' | 'defaults'>
): Record<string, QuestionAnswerValue> {
  const answers: Record<string, QuestionAnswerValue> = {};
  for (const field of variables.fields) {
    const given = variables.defaults[field.name];
    if (given !== undefined) answers[field.name] = given;
  }
  return answers;
}

export type PromptFormResult =
  { ok: true; text: string } | { ok: false; fieldErrors: Record<string, string> };

/** The prompt with the answers in it, or the mark each wrong answer gets. */
export function promptFormResult(
  variables: Pick<PromptVariables, 'template' | 'fields'>,
  answers: Record<string, QuestionAnswerValue>
): PromptFormResult {
  const checked = checkQuestionAnswers(variables.fields, answers);
  if (!checked.ok) {
    return {
      ok: false,
      fieldErrors: Object.fromEntries(checked.issues.map((issue) => [issue.name, issue.message])),
    };
  }
  const values: Record<string, PromptAnswer> = checked.values;
  return { ok: true, text: fillPromptTemplate(variables.template, variables.fields, values) };
}

/** The form's fields as the nodes the shared question form draws. */
export function promptFormNodes(fields: QuestionField[]): ({ kind: 'field' } & QuestionField)[] {
  return fields.map((field) => ({ kind: 'field' as const, ...field }));
}

/** What Insert is called: it fills the message box, it does not send. */
export const PROMPT_FORM_SUBMIT_LABEL = 'Insert';
