'use client';

/**
 * Image-rule CRUD — the project-template-forms shape: a client-side list
 * plus one draft form serving both create and edit. A rule's registry
 * credential is write-only: the list shows the username it carries, the
 * draft takes a new pair or clears the one there, and the secret is
 * never read back.
 */

import { useCallback, useEffect, useReducer } from 'react';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';
import {
  canSave,
  credentialNote,
  imageRulesReducer,
  initialImageRules,
  saveRequest,
  shapeOf,
  type RuleRow,
} from './image-rule-forms.model';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function ImageRuleForms() {
  const [state, dispatch] = useReducer(imageRulesReducer, initialImageRules);
  const { rules, draft, busy, error, notice } = state;

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ rules: RuleRow[] }>(
      `/api/admin/code-services/rules`
    );
    if (loadError) dispatch({ type: 'load-failed', error: loadError });
    else dispatch({ type: 'loaded', rules: data?.rules ?? [] });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft || !canSave(state)) return;
    dispatch({ type: 'sent' });
    const request = saveRequest(draft);
    const result = await sendJsonFull<{ dropped: string | null }>(
      request.url,
      request.method,
      request.body
    );
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    dispatch({ type: 'saved', dropped: result.data?.dropped ?? null });
    await load();
  };

  const remove = async (ruleId: string) => {
    dispatch({ type: 'sent' });
    const removeError = await sendJson(`/api/admin/code-services/rules/${ruleId}`, 'DELETE');
    if (removeError) {
      dispatch({ type: 'failed', error: removeError });
      return;
    }
    dispatch({ type: 'removed', ruleId });
    await load();
  };

  const restore = async () => {
    dispatch({ type: 'sent' });
    const result = await sendJsonFull<{ added: number }>(
      `/api/admin/code-services/rules/restore`,
      'POST'
    );
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    dispatch({ type: 'restored', added: result.data?.added ?? 0 });
    await load();
  };

  const note = draft ? credentialNote(draft) : null;

  return (
    <div className="space-y-4">
      <ul className="space-y-2" aria-label="Allowed images">
        {rules.map((rule) => (
          <li key={rule.id} className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  <code className="break-all">{rule.pattern}</code>
                  <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                    {shapeOf(rule.pattern)}
                  </span>
                </p>
                {rule.note ? (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{rule.note}</p>
                ) : null}
                {rule.registryUsername ? (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Pulled as <code>{rule.registryUsername}</code>
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => dispatch({ type: 'edit', rule })}
                  className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(rule.id)}
                  className="text-sm text-red-600 hover:underline dark:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
        {rules.length === 0 ? (
          <li className="rounded-md border border-dashed border-gray-300 p-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            No images are allowed: a code project cannot start any service until a rule is added.
          </li>
        ) : null}
      </ul>

      {draft ? (
        <div className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <label className="block text-sm font-medium">
            Rule
            <input
              className={`${inputClass} mt-1 font-mono`}
              value={draft.pattern}
              maxLength={512}
              placeholder="myorg.azurecr.io, myorg.azurecr.io/platform/*, or postgres"
              onChange={(event) =>
                dispatch({ type: 'draft', patch: { pattern: event.target.value } })
              }
            />
          </label>
          <label className="block text-sm font-medium">
            Note (optional — what this is for)
            <input
              className={`${inputClass} mt-1`}
              value={draft.note}
              maxLength={300}
              placeholder="Our platform team's registry"
              onChange={(event) => dispatch({ type: 'draft', patch: { note: event.target.value } })}
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Registry credential (optional — for a private registry)
            </legend>
            {note === 'carries' ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                This rule carries a credential. Enter a new pair to replace it, or{' '}
                <button
                  type="button"
                  className="text-red-600 hover:underline dark:text-red-400"
                  onClick={() => dispatch({ type: 'clear-credential' })}
                >
                  remove it
                </button>
                .
              </p>
            ) : null}
            {note === 'removing' ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                The credential is removed on save.{' '}
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => dispatch({ type: 'keep-credential' })}
                >
                  Keep it
                </button>
              </p>
            ) : null}
            <label className="block text-sm">
              Username
              <input
                className={`${inputClass} mt-1`}
                value={draft.registryUsername}
                maxLength={255}
                autoComplete="off"
                placeholder="A service principal id, or a token name"
                onChange={(event) =>
                  dispatch({ type: 'draft', patch: { registryUsername: event.target.value } })
                }
              />
            </label>
            <label className="block text-sm">
              Secret
              <input
                type="password"
                className={`${inputClass} mt-1`}
                value={draft.registrySecret}
                maxLength={4096}
                autoComplete="new-password"
                placeholder="Sealed on the sandbox worker; never shown again"
                onChange={(event) =>
                  dispatch({ type: 'draft', patch: { registrySecret: event.target.value } })
                }
              />
            </label>
          </fieldset>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!canSave(state)}
              onClick={() => void save()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {draft.id ? 'Save rule' : 'Add rule'}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'cancel' })}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-4">
          <button
            type="button"
            onClick={() => dispatch({ type: 'new' })}
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            + New rule
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void restore()}
            className="text-sm text-gray-600 hover:underline dark:text-gray-400"
          >
            Restore default images
          </button>
        </div>
      )}

      {notice ? (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
