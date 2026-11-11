'use client';

/**
 * The model a project's new chats start on, in its About section: a chat
 * project and a code project alike. Saved as it is picked. What it decides
 * is project-model.model.ts; this loads the org's models, sends the pick
 * and draws.
 */

import { useEffect, useId, useReducer } from 'react';
import { sendJsonFull } from '@/lib/fetch-json';
import { chatClient } from '@/lib/chat/client';
import {
  initProjectModel,
  pickerOptions,
  pickerValue,
  projectModelReducer,
  requestBody,
  showsPicker,
} from './project-model.model';

export default function ProjectModel({
  project,
}: {
  project: { id: string; llmModelId: string | null };
}) {
  const [state, dispatch] = useReducer(projectModelReducer, project, initProjectModel);
  const selectId = useId();

  useEffect(() => {
    let live = true;
    void chatClient.models().then((result) => {
      if (live) dispatch({ type: 'modelsLoaded', models: result.data?.models ?? [] });
    });
    return () => {
      live = false;
    };
  }, []);

  if (!showsPicker(state)) return null;

  const pick = async (value: string) => {
    dispatch({ type: 'picked', value });
    const result = await sendJsonFull(
      `/api/chat/projects/${project.id}`,
      'PATCH',
      requestBody(value)
    );
    if (result.error) dispatch({ type: 'saveFailed', error: result.error });
    else dispatch({ type: 'saved' });
  };

  return (
    <div>
      <label htmlFor={selectId} className="mb-1 block text-xs font-medium text-gray-500">
        Model — what new chats in this project start on
      </label>
      <select
        id={selectId}
        value={pickerValue(state)}
        disabled={state.saving}
        onChange={(event) => void pick(event.target.value)}
        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900"
      >
        {pickerOptions(state).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {state.error ? (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
