'use client';

/**
 * The model roster CRUD — the rule-forms shape: client-side list + one
 * draft form that serves both create and edit. The API key field is
 * write-only: the list shows presence, the edit form ships blank and a
 * blank submit keeps the stored key (the embeddings-connector rule).
 */

import RemoveButton from '@/components/remove-button';
import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJsonFull } from '@/lib/fetch-json';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/** Common model ids per provider, offered as suggestions — any id is accepted. */
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  anthropic: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'],
};

const PROVIDER_HINTS: Record<string, { model: string; baseUrl: string }> = {
  anthropic: {
    model: "Anthropic's model identifier — or, on Azure AI Foundry, your Claude DEPLOYMENT name.",
    baseUrl:
      'Blank = api.anthropic.com. For a Claude deployment on Azure AI Foundry use https://{resource}.services.ai.azure.com/anthropic',
  },
  openai: {
    model: 'The model id — or, on Azure AI Foundry, your DEPLOYMENT name.',
    baseUrl:
      'Blank = api.openai.com. For Azure AI Foundry use the resource’s OpenAI-compatible surface: https://{resource}.openai.azure.com/openai/v1',
  },
};

interface ModelRow {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  settings: {
    maxOutputTokens?: number;
    temperature?: number;
    apiVersion?: string;
    reasoningEffort?: string;
  } | null;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
}

interface ModelDraft {
  label: string;
  provider: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: string;
  temperature: string;
  apiVersion: string;
  reasoningEffort: string;
  apiKey: string;
  /** '' = type/keep a key; a config id = reuse that config's stored key. */
  apiKeyFromId: string;
  enabled: boolean;
  isDefault: boolean;
}

const emptyDraft: ModelDraft = {
  label: '',
  provider: 'anthropic',
  model: '',
  baseUrl: '',
  maxOutputTokens: '',
  temperature: '',
  apiVersion: '',
  reasoningEffort: '',
  apiKey: '',
  apiKeyFromId: '',
  enabled: true,
  isDefault: false,
};

/** One row of the provider's answer to "what models do you offer?". */
interface AvailableModelRow {
  id: string;
  displayName: string | null;
}

function draftOf(row: ModelRow): ModelDraft {
  return {
    label: row.label,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl ?? '',
    maxOutputTokens:
      typeof row.settings?.maxOutputTokens === 'number' ? String(row.settings.maxOutputTokens) : '',
    temperature:
      typeof row.settings?.temperature === 'number' ? String(row.settings.temperature) : '',
    apiVersion: typeof row.settings?.apiVersion === 'string' ? row.settings.apiVersion : '',
    reasoningEffort:
      typeof row.settings?.reasoningEffort === 'string' ? row.settings.reasoningEffort : '',
    apiKey: '',
    apiKeyFromId: '',
    enabled: row.enabled,
    isDefault: row.isDefault,
  };
}

export default function ModelForms({ slug }: { slug: string }) {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<ModelDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /*
    The provider's live model list, fetched on demand with whichever key
    the form can reach — a freshly typed one, a sibling config's, or the
    stored key of the row being edited. Cleared whenever the credentials it
    was fetched with change: a list from the old key is not a smaller
    inconvenience than no list, it is wrong with confidence.
  */
  const [available, setAvailable] = useState<AvailableModelRow[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const clearAvailable = () => {
    setAvailable(null);
    setListError(null);
  };

  const reload = useCallback(async () => {
    const result = await getJson<{ models: ModelRow[] }>(`/api/admin/${slug}/llm-models`);
    if (result.error || !result.data) setLoadError(result.error ?? 'Could not load models');
    else {
      setModels(result.data.models);
      setLoadError(null);
    }
  }, [slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startCreate = () => {
    setDraft({ ...emptyDraft, isDefault: (models ?? []).length === 0 });
    setEditingId('new');
    setFormError(null);
    clearAvailable();
  };

  const startEdit = (row: ModelRow) => {
    setDraft(draftOf(row));
    setEditingId(row.id);
    setFormError(null);
    clearAvailable();
  };

  /*
    Which stored config the listing (and a keyless save) can borrow a key
    from: the reuse choice when one is made, else the row being edited —
    its stored key is what a blank field means on save, so it is what the
    list should answer for too.
  */
  const editingRow =
    editingId !== 'new' ? (models ?? []).find((row) => row.id === editingId) : undefined;
  const borrowFromId = draft.apiKeyFromId || (editingRow?.hasApiKey ? editingRow.id : '');
  const canList = Boolean(draft.apiKey || borrowFromId);

  /** Other configs whose stored key can be reused — the same connection
   *  serving another model row. */
  const keyedSiblings = (models ?? []).filter((row) => row.hasApiKey && row.id !== editingId);

  const listModels = async () => {
    setListing(true);
    setListError(null);
    const result = await sendJsonFull<{ models: AvailableModelRow[] }>(
      `/api/admin/${slug}/llm-models/available`,
      'POST',
      {
        provider: draft.provider,
        baseUrl: draft.baseUrl || null,
        ...(draft.apiVersion.trim() ? { apiVersion: draft.apiVersion.trim() } : {}),
        // A typed key wins — it is what a save would store; otherwise the
        // server lends the borrowed config's stored key without it ever
        // reaching this page.
        ...(draft.apiKey ? { apiKey: draft.apiKey } : { modelConfigId: borrowFromId }),
      }
    );
    setListing(false);
    if (result.error || !result.data) {
      setAvailable(null);
      setListError(result.error ?? 'Could not list models');
      return;
    }
    setAvailable(result.data.models);
  };

  const submit = async () => {
    setSaving(true);
    setFormError(null);
    const payload = {
      label: draft.label,
      provider: draft.provider,
      model: draft.model,
      baseUrl: draft.baseUrl || null,
      ...(draft.maxOutputTokens ? { maxOutputTokens: Number(draft.maxOutputTokens) } : {}),
      ...(draft.temperature ? { temperature: Number(draft.temperature) } : {}),
      ...(draft.apiVersion.trim() ? { apiVersion: draft.apiVersion.trim() } : {}),
      ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      ...(draft.apiKeyFromId && !draft.apiKey ? { apiKeyFromId: draft.apiKeyFromId } : {}),
      enabled: draft.enabled,
      isDefault: draft.isDefault,
    };
    const result =
      editingId === 'new'
        ? await sendJsonFull(`/api/admin/${slug}/llm-models`, 'POST', payload)
        : await sendJsonFull(`/api/admin/${slug}/llm-models/${editingId}`, 'PUT', payload);
    setSaving(false);
    if (result.error) {
      setFormError(result.error);
      return;
    }
    setEditingId(null);
    setDraft(emptyDraft);
    await reload();
  };

  const remove = async (row: ModelRow) => {
    if (
      !window.confirm(
        `Remove “${row.label}”? Agents pinned to it fall back to the organization default.`
      )
    ) {
      return;
    }
    const result = await sendJsonFull(`/api/admin/${slug}/llm-models/${row.id}`, 'DELETE');
    if (result.error) setLoadError(result.error);
    else await reload();
  };

  if (models === null && !loadError) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {loadError ? <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p> : null}

      {(models ?? []).length === 0 && editingId === null ? (
        <p className="rounded-md border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          No models configured yet — agents cannot run until one is added.
        </p>
      ) : null}

      {(models ?? []).map((row) => (
        <div
          key={row.id}
          className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {row.label}
                {row.isDefault ? (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                    Default
                  </span>
                ) : null}
                {!row.enabled ? (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    Disabled
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {row.provider} · <span className="font-mono">{row.model}</span>
                {row.baseUrl ? ` · ${row.baseUrl}` : ''} ·{' '}
                {row.hasApiKey ? (
                  'key stored'
                ) : (
                  <span className="text-red-600 dark:text-red-400">no key stored</span>
                )}
              </p>
            </div>
            <div className="flex shrink-0 gap-3 text-xs">
              <button
                type="button"
                onClick={() => startEdit(row)}
                className="font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Edit
              </button>
              <RemoveButton
                label="Remove"
                accessibleLabel={`Remove ${row.label}`}
                onClick={() => remove(row)}
              />
            </div>
          </div>
        </div>
      ))}

      {editingId !== null ? (
        <form
          className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm font-semibold">
            {editingId === 'new' ? 'Add a model' : 'Edit model'}
          </p>

          <div>
            <label className={labelClass} htmlFor="model-label">
              Display name
            </label>
            <input
              id="model-label"
              className={inputClass}
              value={draft.label}
              required
              maxLength={128}
              placeholder="e.g. Claude Sonnet"
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
            <p className={hintClass}>What agent owners see in the model picker.</p>
          </div>

          <div>
            <label className={labelClass} htmlFor="model-provider">
              Provider
            </label>
            <select
              id="model-provider"
              className={inputClass}
              value={draft.provider}
              onChange={(event) => {
                setDraft({ ...draft, provider: event.target.value });
                clearAvailable();
              }}
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI-compatible (OpenAI, Azure AI Foundry)</option>
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="model-id">
              Model id
            </label>
            <input
              id="model-id"
              className={inputClass}
              value={draft.model}
              required
              list="model-suggestions"
              placeholder={
                draft.provider === 'openai'
                  ? 'e.g. gpt-5 or your deployment name'
                  : 'e.g. claude-sonnet-5'
              }
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
            <datalist id="model-suggestions">
              {/* Live answers replace the hardcoded guesses once fetched. */}
              {(available ?? MODEL_SUGGESTIONS[draft.provider]?.map((id) => ({ id })) ?? []).map(
                (suggestion) => (
                  <option key={suggestion.id} value={suggestion.id} />
                )
              )}
            </datalist>
            <p className={hintClass}>
              {PROVIDER_HINTS[draft.provider]?.model ?? 'The provider’s model identifier.'}
            </p>

            {/*
              Ask the connection itself instead of the provider's docs. The
              button needs a key to ask with, so it stays disabled until
              the form has one — typed, borrowed, or stored on this row —
              and the hint says which is missing rather than looking broken.
            */}
            <div className="mt-2">
              <button
                type="button"
                disabled={!canList || listing}
                onClick={() => void listModels()}
                className="text-xs font-medium text-blue-600 hover:underline disabled:cursor-not-allowed disabled:text-gray-400 disabled:no-underline dark:text-blue-400 dark:disabled:text-gray-600"
              >
                {listing ? 'Asking the provider…' : 'List available models'}
              </button>
              {!canList ? (
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  Enter an API key (or pick one to reuse) first.
                </span>
              ) : null}
            </div>
            {listError ? (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{listError}</p>
            ) : null}
            {available !== null && available.length === 0 ? (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                The provider answered with an empty list.
              </p>
            ) : null}
            {available !== null && available.length > 0 ? (
              <ul className="mt-2 max-h-48 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
                {available.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, model: entry.id })}
                      aria-pressed={draft.model === entry.id}
                      className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-900 ${
                        draft.model === entry.id
                          ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                          : ''
                      }`}
                    >
                      <span className="min-w-0 truncate font-mono text-xs">{entry.id}</span>
                      {entry.displayName ? (
                        <span className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">
                          {entry.displayName}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div>
            <label className={labelClass} htmlFor="model-key">
              API key
            </label>
            {/*
              One connection can serve every model row: when sibling configs
              already hold a key, the field grows a source picker and
              "reuse" copies the stored key server-side — it never rides
              through the browser, and nobody retypes it per model.
            */}
            {keyedSiblings.length > 0 ? (
              <select
                aria-label="API key source"
                className={`${inputClass} mb-2`}
                value={draft.apiKeyFromId}
                onChange={(event) => {
                  setDraft({ ...draft, apiKeyFromId: event.target.value, apiKey: '' });
                  clearAvailable();
                }}
              >
                <option value="">
                  {editingId === 'new' ? 'Enter a key' : 'Keep the stored key (or enter a new one)'}
                </option>
                {keyedSiblings.map((row) => (
                  <option key={row.id} value={row.id}>
                    Reuse the key stored on “{row.label}”
                  </option>
                ))}
              </select>
            ) : null}
            {draft.apiKeyFromId === '' ? (
              <>
                <input
                  id="model-key"
                  className={inputClass}
                  type="password"
                  value={draft.apiKey}
                  required={editingId === 'new'}
                  placeholder={
                    editingId === 'new'
                      ? draft.provider === 'openai'
                        ? 'sk-… or an Azure API key'
                        : 'sk-ant-…'
                      : 'Leave blank to keep the stored key'
                  }
                  autoComplete="off"
                  onChange={(event) => {
                    setDraft({ ...draft, apiKey: event.target.value });
                    clearAvailable();
                  }}
                />
                <p className={hintClass}>Stored encrypted; never shown again after saving.</p>
              </>
            ) : (
              <p className={hintClass}>
                Saving copies that key onto this model — still encrypted, never shown.
              </p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor="model-base-url">
              Base URL <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <input
              id="model-base-url"
              className={inputClass}
              value={draft.baseUrl}
              placeholder={
                draft.provider === 'openai'
                  ? 'https://{resource}.openai.azure.com/openai/v1'
                  : 'https://api.anthropic.com'
              }
              onChange={(event) => {
                setDraft({ ...draft, baseUrl: event.target.value });
                clearAvailable();
              }}
            />
            <p className={hintClass}>
              {PROVIDER_HINTS[draft.provider]?.baseUrl ??
                'Only for a gateway or proxy in front of the provider.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="model-max-tokens">
                Max output tokens <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <input
                id="model-max-tokens"
                className={inputClass}
                type="number"
                min={1}
                value={draft.maxOutputTokens}
                placeholder="4096"
                onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.value })}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="model-temperature">
                Temperature <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <input
                id="model-temperature"
                className={inputClass}
                type="number"
                step="0.1"
                min={0}
                max={1}
                value={draft.temperature}
                placeholder="provider default"
                onChange={(event) => setDraft({ ...draft, temperature: event.target.value })}
              />
            </div>
          </div>

          {draft.provider === 'openai' ? (
            <div>
              <label className={labelClass} htmlFor="model-reasoning-effort">
                Reasoning effort <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <select
                id="model-reasoning-effort"
                className={inputClass}
                value={draft.reasoningEffort}
                onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}
              >
                <option value="">Model default</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
              <p className={hintClass}>
                Reasoning models only (GPT-5 family). Leave temperature blank for these — they
                reject it.
              </p>
            </div>
          ) : null}

          <div>
            <label className={labelClass} htmlFor="model-api-version">
              API version <span className="font-normal text-gray-500">(optional, Azure)</span>
            </label>
            <input
              id="model-api-version"
              className={inputClass}
              value={draft.apiVersion}
              placeholder="e.g. 2024-05-01-preview"
              onChange={(event) => {
                setDraft({ ...draft, apiVersion: event.target.value });
                clearAvailable();
              }}
            />
            <p className={hintClass}>
              Appended as ?api-version=… — only when the Azure surface demands it (a &quot;Missing
              required query parameter: api-version&quot; error). Leave blank for Anthropic, OpenAI,
              and Azure&apos;s /openai/v1 surface.
            </p>
          </div>

          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              Enabled
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })}
              />
              Organization default
            </label>
          </div>

          {formError ? <p className="text-sm text-red-600 dark:text-red-400">{formError}</p> : null}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(emptyDraft);
                setFormError(null);
              }}
              className="rounded-md border border-gray-300 px-4 py-1.5 text-sm dark:border-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={startCreate}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + Add a model
        </button>
      )}
    </div>
  );
}
