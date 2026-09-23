'use client';

/**
 * Pipeline-template CRUD — the project-template-forms shape: a
 * client-side list plus one draft form serving both create and edit.
 * Every tenant starts with a few rows seeded by migration
 * (121-pipeline-templates); from here they are ordinary rows like any
 * other — rename, rewrite or delete. Bitbucket only today; the provider
 * rides along so a GitHub Actions catalog can share the table.
 */

import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson } from '@/lib/fetch-json';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

interface TemplateRow {
  id: string;
  provider: string;
  name: string;
  description: string | null;
  body: string;
}

interface Draft {
  id: string | null;
  name: string;
  description: string;
  body: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: '', description: '', body: '' };

export default function PipelineTemplateForms({ slug }: { slug: string }) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ templates: TemplateRow[] }>(
      `/api/admin/${slug}/pipeline-templates`
    );
    if (loadError) setError(loadError);
    else setTemplates(data?.templates ?? []);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft || !draft.name.trim() || !draft.body.trim()) return;
    setBusy(true);
    setError(null);
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      body: draft.body,
    };
    const saveError = draft.id
      ? await sendJson(`/api/admin/${slug}/pipeline-templates/${draft.id}`, 'PUT', payload)
      : await sendJson(`/api/admin/${slug}/pipeline-templates`, 'POST', payload);
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setDraft(null);
    await load();
  };

  const remove = async (templateId: string) => {
    setBusy(true);
    setError(null);
    const removeError = await sendJson(
      `/api/admin/${slug}/pipeline-templates/${templateId}`,
      'DELETE'
    );
    setBusy(false);
    if (removeError) {
      setError(removeError);
      return;
    }
    if (draft?.id === templateId) setDraft(null);
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
                  onClick={() =>
                    setDraft({
                      id: template.id,
                      name: template.name,
                      description: template.description ?? '',
                      body: template.body,
                    })
                  }
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
              placeholder="e.g. Node with pnpm"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="block text-sm font-medium">
            Description (optional — shown next to the name in the picker)
            <input
              className={`${inputClass} mt-1`}
              value={draft.description}
              maxLength={300}
              placeholder="A short line describing when to pick this one"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label className="block text-sm font-medium">
            bitbucket-pipelines.yml
            <textarea
              className={`${inputClass} mt-1 font-mono`}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              rows={16}
              maxLength={60_000}
              spellCheck={false}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !draft.name.trim() || !draft.body.trim()}
              onClick={() => void save()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {draft.id ? 'Save template' : 'Create template'}
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setDraft(EMPTY_DRAFT)}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + New template
        </button>
      )}

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
