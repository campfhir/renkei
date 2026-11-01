'use client';

import React, { useReducer } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import {
  REPLY_FIELD,
  flattenFormFields,
  type FormNode,
  type QuestionAnswerValue,
  type QuestionField,
} from '@renkei/agents';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  checkBeforeSend,
  initialQuestion,
  isPicked,
  otherChoiceOf,
  pickedOption,
  questionNumber,
  questionReducer,
  sendLabel,
  sendOutcomeOf,
  showsSkipHint,
  toggledOther,
  withOtherAnswer,
} from './question-actions.model';

/**
 * The decision controls of a QUESTION card — an `ask_person` call's form,
 * waiting on an answer. Renders the `FormNode` tree the model built at run
 * time: paragraphs for context, one level of groups to cluster related
 * fields, and fields answered the same way a drafted form's would be.
 *
 * Validates HERE with the same function the server uses
 * (`checkQuestionAnswers` in @renkei/agents), so a bad number is caught
 * under the control that holds it rather than as a banner after a round
 * trip. The server still checks: this copy is for the pointing, never for
 * the trust — and it is why the 422 path below can also mark fields.
 *
 * What the card decides (answers, marks, what a send's answer leaves on
 * screen) is question-actions.model.ts, tested in node.
 *
 * A 502 still refreshes: the answer is durably recorded and the worker's
 * sweep resumes the run on its own — the warning is about latency, not
 * loss.
 */
export default function QuestionActions({
  itemId,
  form,
}: {
  itemId: string;
  form: FormNode[];
}): React.ReactNode {
  const { refresh, pending } = useRefresh();
  const fields = flattenFormFields(form);
  const [{ answers, fieldErrors, busy, notice, error }, dispatch] = useReducer(
    questionReducer,
    initialQuestion
  );

  const setField = (field: QuestionField, value: QuestionAnswerValue): void => {
    dispatch({ type: 'answered', name: field.name, value });
  };

  async function submit(): Promise<void> {
    const marks = checkBeforeSend(fields, answers);
    if (marks) {
      dispatch({ type: 'checkFailed', fieldErrors: marks });
      return;
    }
    dispatch({ type: 'sent' });
    const url = `/api/actionable-items/${itemId}/question`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      const body: unknown = await response.json().catch(() => null);
      const outcome = sendOutcomeOf(response.status, body);
      dispatch({ type: 'outcome', outcome });
      if (outcome.kind === 'saved-late') {
        reportFetchFailure('POST', url, response.status, outcome.warning);
      } else if (outcome.kind === 'refused') {
        reportFetchFailure('POST', url, response.status, outcome.error);
        return;
      }
      refresh();
    } finally {
      dispatch({ type: 'settled' });
    }
  }

  return (
    <div className="space-y-3">
      {form.map((node, index) => (
        <FormNodeView
          key={index}
          node={node}
          answers={answers}
          fieldErrors={fieldErrors}
          onChange={setField}
        />
      ))}
      {showsSkipHint(fields) ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Leave any question blank to skip it.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={busy || pending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {sendLabel(fields)}
        </button>
      </div>
      {notice && <p className="text-sm text-amber-700 dark:text-amber-300">{notice}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}

/** One FormNode entry: a paragraph, a one-level group, or an answerable field. */
function FormNodeView({
  node,
  answers,
  fieldErrors,
  onChange,
}: {
  node: FormNode;
  answers: Record<string, QuestionAnswerValue>;
  fieldErrors: Record<string, string>;
  onChange: (field: QuestionField, value: QuestionAnswerValue) => void;
}): React.ReactNode {
  if (node.kind === 'paragraph') {
    return (
      <p className="whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">
        {node.text}
      </p>
    );
  }
  if (node.kind === 'group') {
    return (
      <fieldset className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium">{node.label}</legend>
        {node.nodes.map((child, index) => (
          <FormNodeView
            key={index}
            node={child}
            answers={answers}
            fieldErrors={fieldErrors}
            onChange={onChange}
          />
        ))}
      </fieldset>
    );
  }
  const { kind: _kind, ...field } = node;
  return (
    <FormFieldControl
      field={field}
      value={answers[field.name]}
      error={fieldErrors[field.name]}
      onChange={(value) => onChange(field, value)}
    />
  );
}

const CONTROL_CLASS =
  'w-full rounded-md border bg-white px-2 py-1.5 text-sm dark:bg-gray-900 disabled:opacity-50';

/**
 * One control, chosen by the field's type.
 *
 * Single choice is RADIO BUTTONS rather than a select, and multi is
 * checkboxes: the option list is capped small enough to show, and a person
 * answering a question their agent stopped to ask should see what the
 * choices are without opening anything. A native `<select>` hides exactly
 * the information that makes the answer possible.
 */
function FormFieldControl({
  field,
  value,
  error,
  onChange,
}: {
  field: QuestionField;
  value: QuestionAnswerValue | undefined;
  error: string | undefined;
  onChange: (value: QuestionAnswerValue) => void;
}): React.ReactNode {
  const controlId = `question-field-${field.name}`;
  const describedBy =
    [
      field.context ? `${controlId}-context` : null,
      error ? `${controlId}-error` : field.help ? `${controlId}-help` : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  // A batch question (q1, q2, …) reads as a numbered question.
  const numbered = questionNumber(field.name);
  const border = error
    ? 'border-red-400 dark:border-red-700'
    : 'border-gray-300 dark:border-gray-700';
  const text = typeof value === 'string' ? value : '';
  const choices = field.type === 'choice' || field.type === 'multi';

  return (
    <div>
      <label htmlFor={choices ? undefined : controlId} className="block text-sm font-medium">
        {numbered ? <span className="mr-1.5 text-gray-500">{numbered}.</span> : null}
        {field.label}
        {field.required ? (
          <span className="ml-1 text-red-600 dark:text-red-400" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {field.context ? (
        <p
          id={`${controlId}-context`}
          className="mt-0.5 whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-400"
        >
          {field.context}
        </p>
      ) : null}

      {field.type === 'longtext' ? (
        <textarea
          id={controlId}
          value={text}
          rows={field.name === REPLY_FIELD ? 6 : 3}
          maxLength={10_000}
          required={field.required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={`mt-1 ${CONTROL_CLASS} ${border}`}
        />
      ) : field.type === 'number' ? (
        <input
          id={controlId}
          type="number"
          inputMode="decimal"
          value={text}
          min={field.min}
          max={field.max}
          required={field.required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={`mt-1 ${CONTROL_CLASS} ${border}`}
        />
      ) : field.type === 'date' ? (
        <input
          id={controlId}
          type="date"
          value={text}
          required={field.required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={`mt-1 ${CONTROL_CLASS} ${border}`}
        />
      ) : choices ? (
        <fieldset className="mt-1 space-y-1" aria-describedby={describedBy}>
          <legend className="sr-only">{field.label}</legend>
          {(field.options ?? []).map((option) => {
            const many = field.type === 'multi';
            const checked = isPicked(field, value, option);
            return (
              <label key={option} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type={many ? 'checkbox' : 'radio'}
                  name={controlId}
                  className="mt-0.5"
                  checked={checked}
                  onChange={() => onChange(pickedOption(field, value, option))}
                />
                <span>{option}</span>
              </label>
            );
          })}
          {field.other ? (
            <OtherChoice field={field} controlId={controlId} value={value} onChange={onChange} />
          ) : null}
        </fieldset>
      ) : (
        <input
          id={controlId}
          type="text"
          value={text}
          maxLength={10_000}
          required={field.required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={`mt-1 ${CONTROL_CLASS} ${border}`}
        />
      )}

      {error ? (
        <p id={`${controlId}-error`} className="mt-0.5 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : field.help ? (
        <p id={`${controlId}-help`} className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {field.help}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A choice question's "Something else": one more radio (or checkbox) that,
 * when picked, opens a box for the person's own answer — stored as
 * "Something else: what they wrote" (otherAnswer), so the answer still
 * travels as the one string (or one pick) the field binds.
 */
function OtherChoice({
  field,
  controlId,
  value,
  onChange,
}: {
  field: QuestionField;
  controlId: string;
  value: QuestionAnswerValue | undefined;
  onChange: (value: QuestionAnswerValue) => void;
}): React.ReactNode {
  const other = field.other ?? '';
  const many = field.type === 'multi';
  const { checked, own } = otherChoiceOf(field, value);
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type={many ? 'checkbox' : 'radio'}
          name={controlId}
          className="mt-0.5"
          checked={checked}
          onChange={() => onChange(toggledOther(field, value))}
        />
        <span>{other}</span>
      </label>
      {checked ? (
        <div className="mt-1 pl-6">
          <textarea
            aria-label={`${other} — your answer`}
            value={own}
            rows={2}
            maxLength={2_000}
            autoFocus
            onChange={(event) => onChange(withOtherAnswer(field, value, event.target.value))}
            className={`${CONTROL_CLASS} border-gray-300 dark:border-gray-700`}
          />
        </div>
      ) : null}
    </div>
  );
}
