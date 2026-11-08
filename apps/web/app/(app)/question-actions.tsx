'use client';

import React, { useReducer } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import {
  flattenFormFields,
  type FormNode,
  type QuestionAnswerValue,
  type QuestionField,
} from '@renkei/agents';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  checkBeforeSend,
  initialQuestion,
  questionReducer,
  sendLabel,
  sendOutcomeOf,
  showsSkipHint,
} from './question-actions.model';
import { FormNodeView } from './question-form';

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
