'use client';

/**
 * The form a prompt's variables open: one control per variable (radio
 * buttons, checkboxes, text, long text, number, date), drawn by the same
 * form an agent's question uses. Insert puts the filled-in prompt in the
 * message box; it does not send, so it can still be read and changed.
 */

import { useReducer } from 'react';
import Modal from '@/components/modal';
import { type PromptVariables } from '@/lib/chat/prompt-variables';
import { FormNodeView } from '../../question-form';
import { initialQuestion, questionReducer, showsSkipHint } from '../../question-actions.model';
import {
  PROMPT_FORM_SUBMIT_LABEL,
  initialPromptAnswers,
  promptFormNodes,
  promptFormResult,
} from './prompt-form.model';

export default function PromptFormDialog({
  title,
  variables,
  onInsert,
  onClose,
}: {
  title: string;
  variables: PromptVariables;
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(questionReducer, {
    ...initialQuestion,
    answers: initialPromptAnswers(variables),
  });
  const nodes = promptFormNodes(variables.fields);

  const submit = () => {
    const result = promptFormResult(variables, state.answers);
    if (result.ok) onInsert(result.text);
    else dispatch({ type: 'checkFailed', fieldErrors: result.fieldErrors });
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form
        // The marks under the fields are the check's (the same one an agent's question
        // uses); the browser's own popup would answer first, in different words.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="space-y-3"
      >
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Answer these and the prompt is filled in for you.
        </p>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {nodes.map((node) => (
            <FormNodeView
              key={node.name}
              node={node}
              answers={state.answers}
              fieldErrors={state.fieldErrors}
              onChange={(field, value) => dispatch({ type: 'answered', name: field.name, value })}
            />
          ))}
        </div>
        {showsSkipHint(variables.fields) ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Leave any question blank to skip it.
          </p>
        ) : null}
        {variables.problems.length > 0 ? (
          <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">
            {variables.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            {PROMPT_FORM_SUBMIT_LABEL}
          </button>
        </div>
      </form>
    </Modal>
  );
}
