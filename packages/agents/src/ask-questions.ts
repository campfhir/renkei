/**
 * What an `ask_person` call becomes on its question card.
 *
 * A run asks the way a person would, in one of two shapes the model
 * chooses between:
 *  - a conversation: an `intro` that says what it needs, answered in ONE
 *    reply box — right for an open question, or for related questions a
 *    person would rather answer in a sentence or two than field by field;
 *  - a batch: an `intro` plus `questions`, each one complete sentence with
 *    the evidence behind it and its own answer control — right for
 *    separate decisions (which issue? should I comment? by when?), the
 *    way stage_actions batches separate changes.
 * Either way every question may be left blank (skipped), and a batch ends
 * with an "Anything else?" box, so a person is never boxed in by the form
 * the model guessed at.
 *
 * The older `{message, form}` shape is still read (cards already waiting
 * hold it); a form with nothing to answer gets the one reply box, rather
 * than a card whose only control is Send.
 */

import { flattenFormFields, parseFormNodes, type FormNode } from './question-form';
import type { QuestionField, QuestionFieldType } from './question-field';
import { isRecord } from '@renkei/guards';

export const MAX_ASKED_QUESTIONS = 10;
export const MAX_QUESTION_CHARS = 300;
export const MAX_QUESTION_CONTEXT_CHARS = 1_500;
export const MAX_INTRO_CHARS = 4_000;
const MAX_OPTIONS = 25;

/** The one reply box of a conversational question. */
export const REPLY_FIELD = 'reply';
/** The free box closing every batch. */
export const ANYTHING_ELSE_FIELD = 'anything_else';

/** The free-text choice every choice/multi question carries. */
export const OTHER_LABEL = 'Something else';
/** Options a model adds as a catch-all; the card's own replaces them. */
const CATCH_ALL =
  /^(something else|other|others|none of (these|the above)|other \(.*\)|something else.*)$/i;

const ANSWER_TYPES = new Set(['text', 'longtext', 'choice', 'multi', 'number', 'date', 'yesno']);

function replyField(): FormNode {
  return {
    kind: 'field',
    name: REPLY_FIELD,
    label: 'Your reply',
    type: 'longtext',
    required: false,
  };
}

export type AskedQuestions =
  | { ok: true; message: string; form: FormNode[]; timeoutHours?: number }
  | { ok: false; error: string };

/**
 * An `ask_person` call's arguments as the card's message and form — the
 * conversational or batch shape, or the older {message, form}.
 */
export function askedQuestionsOf(input: unknown): AskedQuestions {
  const args = isRecord(input) ? input : {};
  const timeout =
    typeof args.timeoutHours === 'number' && Number.isFinite(args.timeoutHours)
      ? { timeoutHours: args.timeoutHours }
      : {};
  const intro = (
    typeof args.intro === 'string'
      ? args.intro
      : typeof args.message === 'string'
        ? args.message
        : ''
  ).trim();

  if (Array.isArray(args.questions) && args.questions.length > 0) {
    if (args.questions.length > MAX_ASKED_QUESTIONS) {
      return {
        ok: false,
        error: `Ask at most ${MAX_ASKED_QUESTIONS} questions at once — the ones that matter now.`,
      };
    }
    const form: FormNode[] = [];
    for (const [index, raw] of args.questions.entries()) {
      const field = questionField(raw, index);
      if (typeof field === 'string') return { ok: false, error: `Question ${index + 1}: ${field}` };
      form.push(field);
    }
    form.push({
      kind: 'field',
      name: ANYTHING_ELSE_FIELD,
      label: 'Anything else I should know?',
      type: 'longtext',
      required: false,
    });
    const count = form.length - 1;
    return {
      ok: true,
      message:
        intro.slice(0, MAX_INTRO_CHARS) ||
        `I have ${count === 1 ? 'a question' : `${count} questions`} before I carry on.`,
      form,
      ...timeout,
    };
  }

  if (!intro) {
    return {
      ok: false,
      error:
        'ask_person needs an intro (one question, answered in a reply box) or a list of questions.',
    };
  }
  const legacy = parseFormNodes(args.form);
  const form = flattenFormFields(legacy).length > 0 ? legacy : [...legacy, replyField()];
  return { ok: true, message: intro.slice(0, MAX_INTRO_CHARS), form, ...timeout };
}

function questionField(raw: unknown, index: number): FormNode | string {
  if (!isRecord(raw)) return 'each question is an object with a "question".';
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (!question) return 'write the question itself, as one complete sentence.';
  if (question.length > MAX_QUESTION_CHARS) {
    return `keep the question to one sentence (at most ${MAX_QUESTION_CHARS} characters) and put the evidence in "context".`;
  }
  const context = typeof raw.context === 'string' ? raw.context.trim() : '';
  const answer = isRecord(raw.answer) ? raw.answer : {};
  const kind = typeof answer.type === 'string' ? answer.type : 'longtext';
  if (!ANSWER_TYPES.has(kind)) {
    return `answer.type is one of text, longtext, choice, multi, number, date, yesno.`;
  }
  let options = Array.isArray(answer.options)
    ? [
        ...new Set(
          answer.options
            .filter(
              (option): option is string => typeof option === 'string' && option.trim() !== ''
            )
            .map((option) => option.trim())
        ),
      ]
    : [];
  let type: QuestionFieldType;
  let fieldOptions: string[] | undefined;
  if (kind === 'yesno') {
    type = 'choice';
    fieldOptions = ['Yes', 'No'];
  } else if (kind === 'choice' || kind === 'multi') {
    // The card always offers "Something else" with a box of its own; a
    // catch-all the model listed itself folds into it.
    options = options.filter((option) => !CATCH_ALL.test(option));
    if (options.length < 2) return `a ${kind} answer needs at least two options.`;
    if (options.length > MAX_OPTIONS) return `offer at most ${MAX_OPTIONS} options.`;
    type = kind;
    fieldOptions = options;
  } else {
    type =
      kind === 'text'
        ? 'text'
        : kind === 'number'
          ? 'number'
          : kind === 'date'
            ? 'date'
            : 'longtext';
  }
  const field: QuestionField = {
    name: `q${index + 1}`,
    label: question,
    type,
    // Any question may be skipped: the agent decides what a blank means.
    required: false,
    ...(fieldOptions ? { options: fieldOptions } : {}),
    ...(kind === 'choice' || kind === 'multi' ? { other: OTHER_LABEL } : {}),
    ...(context ? { context: context.slice(0, MAX_QUESTION_CONTEXT_CHARS) } : {}),
    ...(typeof answer.hint === 'string' && answer.hint.trim()
      ? { help: answer.hint.trim().slice(0, 500) }
      : {}),
    ...(type === 'number' && typeof answer.min === 'number' ? { min: answer.min } : {}),
    ...(type === 'number' && typeof answer.max === 'number' ? { max: answer.max } : {}),
  };
  return { kind: 'field', ...field };
}

/**
 * A card's answers as the agent reads them: each question and its answer,
 * a blank one marked skipped, the closing box only when something is in it.
 */
export function answersForAgent(form: FormNode[], answers: Record<string, unknown>): string {
  const blocks: string[] = [];
  for (const field of flattenFormFields(form)) {
    const raw = answers[field.name];
    const value = Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === 'string').join(', ')
      : typeof raw === 'string'
        ? raw
        : '';
    const given = value.trim();
    if (field.name === ANYTHING_ELSE_FIELD || field.name === REPLY_FIELD) {
      if (given) blocks.push(field.name === REPLY_FIELD ? given : `Also: ${given}`);
      continue;
    }
    const label = field.label.trim() || field.name;
    blocks.push(
      `Q: ${label}${field.key ? ` [${field.key}]` : ''}\nA: ${given || '(skipped — no answer given)'}`
    );
  }
  return blocks.join('\n\n') || 'Answered, with nothing filled in.';
}
