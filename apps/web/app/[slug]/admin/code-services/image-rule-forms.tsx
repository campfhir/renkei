'use client';

/**
 * Image-rule CRUD — the project-template-forms shape: a client-side list
 * plus one draft form serving both create and edit. A rule's registry
 * credential is write-only: the list shows the username it carries, the
 * draft takes a new pair or clears the one there, and the secret is
 * never read back.
 */

import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

interface RuleRow {
  id: string;
  pattern: string;
  note: string | null;
  registryUsername: string | null;
}

interface Draft {
  id: string | null;
  pattern: string;
  note: string;
  registryUsername: string;
  registrySecret: string;
  /** Editing a rule that carries a credential: keep it unless a new pair or a clear says otherwise. */
  hasCredential: boolean;
  clearCredential: boolean;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  pattern: '',
  note: '',
  registryUsername: '',
  registrySecret: '',
  hasCredential: false,
  clearCredential: false,
};

/** What a rule's shape says at a glance. */
function shapeOf(pattern: string): string {
  if (pattern.endsWith('/*')) return 'namespace';
  return pattern.includes('/') ? 'repository' : 'whole registry';
}

export default function ImageRuleForms({ slug }: { slug: string }) {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ rules: RuleRow[] }>(
      `/api/admin/${slug}/code-services/rules`
    );
    if (loadError) setError(loadError);
    else setRules(data?.rules ?? []);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft || !draft.pattern.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const payload = {
      pattern: draft.pattern.trim(),
      note: draft.note.trim() || null,
      ...(draft.registryUsername.trim()
        ? { registryUsername: draft.registryUsername.trim(), registrySecret: draft.registrySecret }
        : {}),
      ...(draft.clearCredential ? { clearCredential: true } : {}),
    };
    const result = draft.id
      ? await sendJsonFull<{ dropped: string | null }>(
          `/api/admin/${slug}/code-services/rules/${draft.id}`,
          'PUT',
          payload
        )
      : await sendJsonFull<{ dropped: string | null }>(
          `/api/admin/${slug}/code-services/rules`,
          'POST',
          payload
        );
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.data?.dropped) {
      setNotice(`Saved without ${result.data.dropped}: a rule allows a repository at any tag.`);
    }
    setDraft(null);
    await load();
  };

  const remove = async (ruleId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const removeError = await sendJson(
      `/api/admin/${slug}/code-services/rules/${ruleId}`,
      'DELETE'
    );
    setBusy(false);
    if (removeError) {
      setError(removeError);
      return;
    }
    if (draft?.id === ruleId) setDraft(null);
    await load();
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await sendJsonFull<{ added: number }>(
      `/api/admin/${slug}/code-services/rules/restore`,
      'POST'
    );
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    const added = result.data?.added ?? 0;
    setNotice(
      added === 0
        ? 'The default images are all in the list already.'
        : `Put ${added} default ${added === 1 ? 'image' : 'images'} back.`
    );
    await load();
  };

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
                  onClick={() =>
                    setDraft({
                      id: rule.id,
                      pattern: rule.pattern,
                      note: rule.note ?? '',
                      registryUsername: '',
                      registrySecret: '',
                      hasCredential: rule.registryUsername !== null,
                      clearCredential: false,
                    })
                  }
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
              onChange={(event) => setDraft({ ...draft, pattern: event.target.value })}
            />
          </label>
          <label className="block text-sm font-medium">
            Note (optional — what this is for)
            <input
              className={`${inputClass} mt-1`}
              value={draft.note}
              maxLength={300}
              placeholder="Our platform team's registry"
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Registry credential (optional — for a private registry)
            </legend>
            {draft.hasCredential && !draft.clearCredential ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                This rule carries a credential. Enter a new pair to replace it, or{' '}
                <button
                  type="button"
                  className="text-red-600 hover:underline dark:text-red-400"
                  onClick={() => setDraft({ ...draft, clearCredential: true })}
                >
                  remove it
                </button>
                .
              </p>
            ) : null}
            {draft.clearCredential ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                The credential is removed on save.{' '}
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => setDraft({ ...draft, clearCredential: false })}
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
                  setDraft({
                    ...draft,
                    registryUsername: event.target.value,
                    clearCredential: false,
                  })
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
                  setDraft({ ...draft, registrySecret: event.target.value, clearCredential: false })
                }
              />
            </label>
          </fieldset>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={
                busy ||
                !draft.pattern.trim() ||
                Boolean(draft.registryUsername.trim()) !== Boolean(draft.registrySecret)
              }
              onClick={() => void save()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {draft.id ? 'Save rule' : 'Add rule'}
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
        <div className="flex flex-wrap gap-4">
          <button
            type="button"
            onClick={() => setDraft(EMPTY_DRAFT)}
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
