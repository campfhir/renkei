'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  checkQuestionAnswers,
  flattenFormFields,
  type FormNode,
  type QuestionAnswerValue,
  type QuestionField,
} from '@renkei/agents';

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
 * A 502 still refreshes: the answer is durably recorded and the worker's
 * sweep resumes the run on its own — the warning is about latency, not
 * loss.
 */
export default function QuestionActions({
  tenantId,
  itemId,
  form,
}: {
  tenantId: string;
  itemId: string;
  form: FormNode[];
}): React.ReactNode {
  const router = useRouter();
  const fields = flattenFormFields(form);
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerValue>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setField = (field: QuestionField, value: QuestionAnswerValue): void => {
    setAnswers((current) => ({ ...current, [field.name]: value }));
    setFieldErrors((current) => {
      if (!current[field.name]) return current;
      const { [field.name]: _cleared, ...rest } = current;
      return rest;
    });
  };

  async function submit(): Promise<void> {
    if (fields.length > 0) {
      const checked = checkQuestionAnswers(fields, answers);
      if (!checked.ok) {
        setFieldErrors(
          Object.fromEntries(checked.issues.map((issue) => [issue.name, issue.message]))
        );
        return;
      }
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    try {
      const response = await fetch(`/api/tenant/${tenantId}/actionable-items/${itemId}/question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      const body: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof body === 'object' && body !== null ? { ...body } : {};
      if (response.status === 502 && typeof record.warning === 'string') {
        setNotice(record.warning);
        router.refresh();
        return;
      }
      if (!response.ok) {
        // The server checked the form too, and it is the one whose answer
        // counts — mark whatever it named, wherever this copy disagreed.
        const issues = Array.isArray(record.issues) ? record.issues : [];
        if (issues.length > 0) {
          setFieldErrors(
            Object.fromEntries(
              issues.flatMap((issue) => {
                const entry: { name?: unknown; message?: unknown } =
                  typeof issue === 'object' && issue !== null ? { ...issue } : {};
                return typeof entry.name === 'string' && typeof entry.message === 'string'
                  ? [[entry.name, entry.message]]
                  : [];
              })
            )
          );
        }
        setError(
          typeof record.error === 'string' ? record.error : `Request failed (${response.status})`
        );
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
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
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {fields.length > 0 ? 'Send the answers' : 'Send'}
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
      <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{node.text}</p>
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
  const describedBy = error ? `${controlId}-error` : field.help ? `${controlId}-help` : undefined;
  const border = error
    ? 'border-red-400 dark:border-red-700'
    : 'border-gray-300 dark:border-gray-700';
  const text = typeof value === 'string' ? value : '';
  const picks = Array.isArray(value) ? value : [];
  const choices = field.type === 'choice' || field.type === 'multi';

  return (
    <div>
      <label htmlFor={choices ? undefined : controlId} className="block text-sm font-medium">
        {field.label}
        {field.required ? (
          <span className="ml-1 text-red-600 dark:text-red-400" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {field.type === 'longtext' ? (
        <textarea
          id={controlId}
          value={text}
          rows={3}
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
            const checked = many ? picks.includes(option) : text === option;
            return (
              <label key={option} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type={many ? 'checkbox' : 'radio'}
                  name={controlId}
                  className="mt-0.5"
                  checked={checked}
                  onChange={() => {
                    if (!many) {
                      onChange(option);
                      return;
                    }
                    onChange(
                      checked ? picks.filter((pick) => pick !== option) : [...picks, option]
                    );
                  }}
                />
                <span>{option}</span>
              </label>
            );
          })}
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
