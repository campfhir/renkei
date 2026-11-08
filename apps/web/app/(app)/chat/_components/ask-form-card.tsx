'use client';

/**
 * A form the model asked in the thread (chat_ask_form): its intro, then the
 * questions as radio buttons, checkboxes and boxes, drawn by the same form an
 * agent's question uses. Send puts the answers in the thread as the person's
 * next message, which is what the model is waiting on; after that the card
 * is a record. What it checks and sends is ask-form-card.model.ts.
 */

import { useId, useReducer, useState } from 'react';
import { flattenFormFields } from '@renkei/agents';
import { Icon, ICONS } from '@/components/icons';
import type { AskFormAnswers, AskFormRequest } from '@/lib/chat/ask-form';
import { FormNodeView } from '../../question-form';
import { initialQuestion, questionReducer, showsSkipHint } from '../../question-actions.model';
import {
  ASK_FORM_SEND_LABEL,
  askFormMode,
  askFormNote,
  askFormSubmission,
  askFormSummary,
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

  // Once answered the form is gone: the card is one line, opened to read what was said.
  if (later.kind === 'answers') return <AnsweredCard answers={later.answers} />;

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
      className="my-3 max-w-md rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950"
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

/**
 * The card after the form is answered: a line saying how much was, opened
 * on a click to the questions and what was said to each. The answers are
 * read back from the message that carried them to the model, which the
 * thread does not show as a bubble of its own.
 */
function AnsweredCard({ answers }: { answers: AskFormAnswers }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <section
      aria-label="Questions for you"
      className="my-3 max-w-md rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
      >
        <span className="min-w-0 flex-1 font-medium">{askFormSummary(answers)}</span>
        <span className="text-xs text-gray-500">{open ? 'Hide' : 'Show'}</span>
        <Icon
          path={ICONS.chevron}
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform motion-reduce:transition-none ${
            open ? 'rotate-90' : ''
          }`}
        />
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="space-y-3 border-t border-gray-200 px-3 py-3 dark:border-gray-800"
      >
        {answers.rows.map((row, index) => (
          <div key={index}>
            <p className="text-sm font-medium">{row.question}</p>
            {row.answer === null ? (
              <p className="text-sm text-gray-500 italic dark:text-gray-400">Skipped</p>
            ) : (
              <p className="text-sm whitespace-pre-wrap text-gray-700 dark:text-gray-300">
                {row.answer}
              </p>
            )}
          </div>
        ))}
        {answers.also ? (
          <div>
            <p className="text-sm font-medium">Also</p>
            <p className="text-sm whitespace-pre-wrap text-gray-700 dark:text-gray-300">
              {answers.also}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
