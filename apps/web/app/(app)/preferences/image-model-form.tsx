'use client';

/**
 * Which image generation model this person's chats draw with. Only shown
 * when the org has at least one (the page leaves it out otherwise) — with
 * exactly one there is nothing to choose between, but the person still
 * sees which model their pictures come from. "Organization default" is no
 * preference: the chat takes the org's first image model by name. A model
 * the admin has since disabled quietly falls back to that too, so a stale
 * pick never blocks a picture.
 *
 * What it decides — Save on or off, what Save sends, what the picker
 * offers — is image-model-form.model.ts, tested in node.
 */

import { useReducer } from 'react';
import type { ImagePrefs } from '@renkei/user-prefs/prefs';
import { reportFetchFailure } from '@/lib/fetch-json';
import { logFailedResponse } from '@/lib/client-logger';
import {
  canSave,
  imageModelFormReducer,
  initImageModelForm,
  pickerHint,
  pickerOptions,
  pickerValue,
  requestBody,
  saveLabel,
  type ImageModelOption,
} from './image-model-form.model';

export type { ImageModelOption } from './image-model-form.model';

export default function ImageModelForm({
  initial,
  models,
}: {
  initial: ImagePrefs;
  models: ImageModelOption[];
}) {
  const [state, dispatch] = useReducer(
    imageModelFormReducer,
    { initial, models },
    initImageModelForm
  );

  async function save() {
    const body = requestBody(state);
    dispatch({ type: 'saving' });
    try {
      const response = await fetch(`/api/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        dispatch({ type: 'saved', modelId: body.image.modelId });
      } else {
        await logFailedResponse('preferences', 'could not save the image model', response);
        dispatch({ type: 'save-failed' });
      }
    } catch (error) {
      reportFetchFailure('PUT', '/api/preferences', 0, 'Could not reach the server', error);
      dispatch({ type: 'save-failed' });
    }
  }

  return (
    <section
      aria-labelledby="image-model-heading"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="image-model-heading" className="font-semibold">
        Image generation
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        The model that draws pictures when you ask a chat for one.
      </p>

      <label className="mt-3 block text-sm" htmlFor="image-model-select">
        Preferred image model
      </label>
      <select
        id="image-model-select"
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
