'use client';

/**
 * Which model this person's new chats start on. A project with a model of
 * its own comes first (a chat project or a code project); this is what
 * its chats, and every chat outside a project, fall back to. "Organization
 * default" is no preference. The page leaves the section out when the org
 * has no chat model at all.
 *
 * What it decides — Save on or off, what Save sends, what the picker
 * offers — is chat-model-form.model.ts, tested in node.
 */

import { useReducer } from 'react';
import type { ChatModelPrefs } from '@renkei/user-prefs/prefs';
import { reportFetchFailure } from '@/lib/fetch-json';
import { logFailedResponse } from '@/lib/client-logger';
import {
  canSave,
  chatModelFormReducer,
  initChatModelForm,
  pickerHint,
  pickerOptions,
  pickerValue,
  requestBody,
  saveLabel,
  type ChatModelOption,
} from './chat-model-form.model';

export type { ChatModelOption } from './chat-model-form.model';

export default function ChatModelForm({
  initial,
  models,
}: {
  initial: ChatModelPrefs;
  models: ChatModelOption[];
}) {
  const [state, dispatch] = useReducer(
    chatModelFormReducer,
    { initial, models },
    initChatModelForm
  );

  async function save() {
    const body = requestBody(state);
    dispatch({ type: 'saving' });
    try {
      const response = await fetch(`/api/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        dispatch({ type: 'saved', modelId: body.chatModel.modelId });
      } else {
        await logFailedResponse('preferences', 'could not save the chat model', response);
        dispatch({ type: 'save-failed' });
      }
    } catch (error) {
      reportFetchFailure('PATCH', '/api/preferences', 0, 'Could not reach the server', error);
      dispatch({ type: 'save-failed' });
    }
  }

  return (
    <section
      aria-labelledby="chat-model-heading"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="chat-model-heading" className="font-semibold">
        Chat model
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        The model your new chats start on.
      </p>

      <label className="mt-3 block text-sm" htmlFor="chat-model-select">
        Preferred chat model
      </label>
      <select
        id="chat-model-select"
        value={pickerValue(state)}
        onChange={(event) => dispatch({ type: 'picked', value: event.target.value })}
        className="mt-1 w-full max-w-md rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      >
        {pickerOptions(models).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{pickerHint(models)}</p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave(state)}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saveLabel(state)}
        </button>
        {state.status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {state.status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">Could not save.</span>
        ) : null}
      </div>
    </section>
  );
}
