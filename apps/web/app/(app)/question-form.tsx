'use client';

import React from 'react';
import {
  REPLY_FIELD,
  type FormNode,
  type QuestionAnswerValue,
  type QuestionField,
} from '@renkei/agents';
import {
  isPicked,
  otherChoiceOf,
  pickedOption,
  questionNumber,
  toggledOther,
  withOtherAnswer,
} from './question-actions.model';

/**
 * The controls of a question form, drawn from a `FormNode` tree: paragraphs,
 * one level of groups, and fields — text, long text, number, date, a choice
 * as radio buttons, several as checkboxes, each with its label, a required
 * star, help and the mark a failed check leaves under it. Shared by the
 * question card an agent's `ask_person` raises (question-actions.tsx) and the
 * form a prompt's variables open in the chat (prompt-form-dialog.tsx); what
 * either does with the answers is its own.
 */

/** One FormNode entry: a paragraph, a one-level group, or an answerable field. */
export function FormNodeView({
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
