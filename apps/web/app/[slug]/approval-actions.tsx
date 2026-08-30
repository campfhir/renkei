'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { checkApprovalAnswers, type ApprovalAnswerValue, type ApprovalField } from '@renkei/agents';

/**
 * The decision controls of an APPROVAL card — the human half of a paused
 * agent run. Approve/decline in 'approve' mode; in 'input' mode either one
 * text box or the step's FORM, plus "I don't know". There is deliberately
 * no dismiss: a dismissed card would leave the run waiting on a decision
 * nobody can see anymore — declining is the "no", and doing nothing lets
 * the wait run out onto the flow's timed-out path.
 *
 * Both modes send the same `decision: 'decline'`; only the WORD differs,
 * and it has to. "Stop the run" is what the second button used to say in
 * input mode, and it described something that does not happen: declining
 * routes the node's declined path like any other outcome, and where that
 * path is empty the run simply carries on. What the person means by
 * pressing it is "I have no answer" — so that is what it says.
 *
 * The form validates HERE with the same function the server uses
 * (`checkApprovalAnswers` in @renkei/agents), so a bad number is caught
 * under the control that holds it rather than as a banner after a round
 * trip. The server still checks: this copy is for the pointing, never for
 * the trust — and it is why the 422 path below can also mark fields.
 *
 * A 502 still refreshes: the decision is durably recorded and the worker's
 * sweep resumes the run on its own — the warning is about latency, not loss.
 */
export default function ApprovalActions({
  tenantId,
  itemId,
  mode,
  fields = [],
}: {
  tenantId: string;
  itemId: string;
  mode: 'approve' | 'input';
  /** The step's form, snapshotted onto the card. Empty = one plain box. */
  fields?: ApprovalField[];
}): React.ReactNode {
  const router = useRouter();
  const [answer, setAnswer] = useState('');
  const [answers, setAnswers] = useState<Record<string, ApprovalAnswerValue>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isForm = mode === 'input' && fields.length > 0;

  const setField = (field: ApprovalField, value: ApprovalAnswerValue): void => {
    setAnswers((current) => ({ ...current, [field.name]: value }));
    setFieldErrors((current) => {
      if (!current[field.name]) return current;
      const { [field.name]: _cleared, ...rest } = current;
      return rest;
    });
  };

  async function decide(decision: 'approve' | 'decline'): Promise<void> {
    if (isForm && decision === 'approve') {
      const checked = checkApprovalAnswers(fields, answers);
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
      const response = await fetch(`/api/tenant/${tenantId}/actionable-items/${itemId}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          decision === 'approve' && mode === 'input'
            ? isForm
              ? { decision, answers }
              : { decision, answer: answer.trim() }
            : { decision }
        ),
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
    <div className="space-y-2">
      {mode === 'input' ? (
        <>
          {isForm ? (
            <div className="space-y-3">
              {fields.map((field, index) => (
                <FormField
                  key={field.name || index}
                  field={field}
                  index={index}
                  value={answers[field.name]}
                  error={fieldErrors[field.name]}
                  onChange={(value) => setField(field, value)}
                />
              ))}
            </div>
          ) : (
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              rows={3}
              maxLength={10_000}
              placeholder="Type your answer — the run continues with it"
              aria-label="Your answer"
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void decide('approve')}
              disabled={busy || (!isForm && answer.trim().length === 0)}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isForm ? 'Send the answers' : 'Send the answer'}
            </button>
            <button
              onClick={() => void decide('decline')}
              disabled={busy}
              title="Send no answer — the run continues down the path its author wrote for that."
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
            >
              I don&apos;t know
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void decide('approve')}
            disabled={busy}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => void decide('decline')}
            disabled={busy}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
          >
            Decline
          </button>
        </div>
      )}
      {notice && <p className="text-sm text-amber-700 dark:text-amber-300">{notice}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    </div>
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
function FormField({
  field,
  index,
  value,
  error,
  onChange,
}: {
  field: ApprovalField;
  /** Position on this card — the control's DOM id, which a name with
   *  spaces in it could not be. */
  index: number;
  value: ApprovalAnswerValue | undefined;
  error: string | undefined;
  onChange: (value: ApprovalAnswerValue) => void;
}): React.ReactNode {
  const controlId = `approval-field-${index}`;
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
