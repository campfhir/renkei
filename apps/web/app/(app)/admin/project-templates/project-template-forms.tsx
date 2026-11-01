'use client';

/**
 * Project-template CRUD — the calendar-forms shape: a client-side list
 * plus one draft form serving both create and edit. Every tenant starts
 * with a few rows seeded by migration (114-code-project-templates); from
 * here they are ordinary rows like any other — rename, rewrite or delete.
 * When Save is allowed and what it sends are project-template-forms.model.ts.
 */

import { useCallback, useEffect, useReducer } from 'react';
import { getJson, sendJson } from '@/lib/fetch-json';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

import {
  canSave,
  initialTemplates,
  saveLabel,
  saveRequest,
  templatesReducer,
  type TemplateRow,
} from './project-template-forms.model';

export default function ProjectTemplateForms() {
  const [state, dispatch] = useReducer(templatesReducer, initialTemplates);
  const { templates, draft, busy, error } = state;

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ templates: TemplateRow[] }>(
      `/api/admin/project-templates`
    );
    if (loadError) dispatch({ type: 'loadFailed', error: loadError });
    else dispatch({ type: 'loaded', templates: data?.templates ?? [] });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const request = saveRequest(state);
    if (!request) return;
    dispatch({ type: 'sent' });
    const saveError = await sendJson(request.url, request.method, request.body);
    if (saveError) {
      dispatch({ type: 'failed', error: saveError });
      return;
    }
    dispatch({ type: 'saved' });
    await load();
  };

  const remove = async (templateId: string) => {
    dispatch({ type: 'sent' });
    const removeError = await sendJson(`/api/admin/project-templates/${templateId}`, 'DELETE');
    if (removeError) {
      dispatch({ type: 'failed', error: removeError });
      return;
    }
    dispatch({ type: 'removed', id: templateId });
    await load();
  };

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {templates.map((template) => (
          <li
            key={template.id}
            className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{template.name}</p>
                {template.description ? (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {template.description}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => dispatch({ type: 'edit', template })}
                  className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(template.id)}
                  className="text-sm text-red-600 hover:underline dark:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <label className="block text-sm font-medium">
            Name
            <input
              className={`${inputClass} mt-1`}
              value={draft.name}
              maxLength={200}
              placeholder="e.g. Microservice / API service"
              onChange={(event) =>
                dispatch({ type: 'draftChanged', field: 'name', value: event.target.value })
              }
            />
          </label>
          <label className="block text-sm font-medium">
            Description (optional — shown next to the name in the picker)
            <input
              className={`${inputClass} mt-1`}
              value={draft.description}
              maxLength={300}
              placeholder="A short line describing when to pick this one"
              onChange={(event) =>
                dispatch({ type: 'draftChanged', field: 'description', value: event.target.value })
              }
            />
          </label>
          <label className="block text-sm font-medium">
            Instructions
            <textarea
              className={`${inputClass} mt-1 font-mono`}
              value={draft.instructions}
              onChange={(event) =>
                dispatch({ type: 'draftChanged', field: 'instructions', value: event.target.value })
              }
              rows={14}
              maxLength={20_000}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!canSave(state)}
              onClick={() => void save()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saveLabel(state)}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'draftCancelled' })}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => dispatch({ type: 'newTemplate' })}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + New template
        </button>
      )}

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
