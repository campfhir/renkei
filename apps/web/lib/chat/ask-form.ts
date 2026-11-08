/**
 * chat_ask_form's request and its answer: what the model asks as a form,
 * and the text the person's answers become. The questions are the agents'
 * `ask_person` batch shape — an intro and up to ten questions, each with a
 * type, its options, bounds and help — read by the same parser
 * (`askedQuestionsOf`), so a form means the same thing wherever it is asked;
 * the answers come back as the same "Q: … A: …" text an agent reads.
 *
 * Pure: the tool validates with it, the thread draws the card from it, and
 * the card's model checks and words the answers with it.
 */

import {
  answersForAgent,
  askedQuestionsOf,
  type FormNode,
  type QuestionAnswerValue,
} from '@renkei/agents';

export const ASK_FORM_TOOL = 'chat_ask_form';

export interface AskFormRequest {
  /** What the model needs and why, said in a sentence or two above the form. */
  intro: string;
  /** The questions, closed by the "Anything else?" box every batch carries. */
  form: FormNode[];
}

export type AskFormParse = { ok: true; request: AskFormRequest } | { ok: false; message: string };

/**
 * The agents' parser reads each question as {question, context, answer: {type,
 * options, hint, min, max}}; the tool offers the model one flat object per
 * question, which is easier to write, and maps it here.
 */
function agentQuestion(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const question: Record<string, unknown> = { ...raw };
  if (question.answer !== undefined) return question;
  const answer: Record<string, unknown> = {};
  // The tool says an untyped question is a short box; the agents' parser would make it a long one.
  answer.type = question.type ?? 'text';
  if (question.options !== undefined) answer.options = question.options;
  if (question.help !== undefined) answer.hint = question.help;
  if (question.min !== undefined) answer.min = question.min;
  if (question.max !== undefined) answer.max = question.max;
  return { question: question.question, context: question.context, answer };
}

/** A call's input as the form it draws, or why it cannot be one. */
export function parseAskFormRequest(input: unknown): AskFormParse {
  const record: Record<string, unknown> =
    typeof input === 'object' && input !== null && !Array.isArray(input) ? { ...input } : {};
  // A form is questions: the agents' single reply-box shape is a plain message.
  if (!Array.isArray(record.questions) || record.questions.length === 0) {
    return { ok: false, message: 'chat_ask_form needs a list of questions to put in the form.' };
  }
  const asked = askedQuestionsOf({
    intro: record.intro,
    questions: record.questions.map(agentQuestion),
  });
  if (!asked.ok) return { ok: false, message: asked.error };
  // The agents' form lets every question be skipped; here the model may require one
  // (a prompt template's `required: true`), so the mark is put back on that field.
  const form = asked.form.map((node, index): FormNode => {
    const raw: unknown = record.questions instanceof Array ? record.questions[index] : undefined;
    const required =
      typeof raw === 'object' && raw !== null && 'required' in raw && raw.required === true;
    return required && node.kind === 'field' ? { ...node, required: true } : node;
  });
  return { ok: true, request: { intro: asked.message, form } };
}

/** What the person's answers say, as the message that carries them back. */
export function askFormAnswersText(
  request: AskFormRequest,
  answers: Record<string, QuestionAnswerValue>
): string {
  return `My answers:\n\n${answersForAgent(request.form, answers)}`;
}

/** Whether a message is the person's answers to a form (the card shows itself answered after one). */
export const ASK_FORM_ANSWER_PREFIX = 'My answers:\n\n';
