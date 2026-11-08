'use client';

/**
 * A form the model asked in the thread (chat_ask_form): its intro, then the
 * questions as radio buttons, checkboxes and boxes, drawn by the same form an
 * agent's question uses. Send puts the answers in the thread as the person's
 * next message, which is what the model is waiting on; after that the card
 * is a record. What it checks and sends is ask-form-card.model.ts.
 */

import { useReducer } from 'react';
import { flattenFormFields } from '@renkei/agents';
import type { AskFormRequest } from '@/lib/chat/ask-form';
import { FormNodeView } from '../../question-form';
import { initialQuestion, questionReducer, showsSkipHint } from '../../question-actions.model';
import {
  ASK_FORM_SEND_LABEL,
  askFormMode,
  askFormNote,
  askFormSubmission,
  type AskFormLater,
} from './ask-form-card.model';

export default function AskFormCard({
  request,
  later,
  onAnswer,
}: {
  request: AskFormRequest;
  /** What came after the form in the thread. */
  later: AskFormLater;
  /** Send the answers as the next message; null when this person cannot send. */
  onAnswer: ((text: string) => Promise<boolean>) | null;
}) {
  const [state, dispatch] = useReducer(questionReducer, initialQuestion);
  const mode = askFormMode({ later, canAnswer: onAnswer !== null });
  const fields = flattenFormFields(request.form);
  const note = askFormNote(mode);

  const submit = async () => {
    if (!onAnswer) return;
    const result = askFormSubmission(request, state.answers);
    if (!result.ok) {
      dispatch({ type: 'checkFailed', fieldErrors: result.fieldErrors });
      return;
    }
    dispatch({ type: 'sent' });
    const sent = await onAnswer(result.text);
    dispatch({
      type: 'outcome',
      outcome: sent
        ? { kind: 'answered' }
        : { kind: 'refused', error: 'Your answers could not be sent. Try again.', fieldErrors: {} },
    });
    dispatch({ type: 'settled' });
  };

  return (
    <section
      aria-label="Questions for you"
      className="my-3 max-w-xl rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase">
        Questions for you
      </h3>
      <p className="mb-3 text-sm whitespace-pre-wrap text-gray-800 dark:text-gray-200">
        {request.intro}
      </p>
      <form
        // The marks under the fields are the check's, in its own words, not the browser's popup.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <fieldset disabled={mode !== 'fill' || state.busy} className="space-y-3">
          {request.form.map((node, index) => (
            <FormNodeView
              key={index}
              node={node}
              answers={state.answers}
              fieldErrors={state.fieldErrors}
              onChange={(field, value) => dispatch({ type: 'answered', name: field.name, value })}
            />
          ))}
        </fieldset>
        {mode === 'fill' ? (
          <>
            {showsSkipHint(fields) ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Leave any question blank to skip it.
              </p>
            ) : null}
            <button
              type="submit"
              disabled={state.busy}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {ASK_FORM_SEND_LABEL}
            </button>
            {state.error ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                {state.error}
              </p>
            ) : null}
          </>
        ) : null}
        {note ? <p className="text-xs text-gray-500 dark:text-gray-400">{note}</p> : null}
      </form>
    </section>
  );
}
