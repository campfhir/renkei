'use client';

/**
 * The model roster CRUD — the rule-forms shape: client-side list + one
 * draft form that serves both create and edit. What the screen decides
 * (which fields show, what goes stale, what Save sends or refuses, the
 * row badges) is model-forms.model.ts; this makes the calls, dispatches
 * what the person did and what the server answered, and renders.
 */

import RemoveButton from '@/components/remove-button';
import Modal from '@/components/modal';
import { useCallback, useEffect, useReducer } from 'react';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { LoadingRegion, SkeletonCards } from '@/components/skeleton';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import {
  canList as canListOf,
  canTest as canTestOf,
  formView,
  initialModelForms,
  isLoading,
  keyedSiblings as keyedSiblingsOf,
  listRequest,
  modelFormsReducer,
  rowView,
  saveRequest,
  showsEmpty,
  testRequest,
  type AvailableModelRow,
  type ModelRow,
} from './model-forms.model';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/** The same categories @renkei/agent-llm's PROVIDER_RETENTIONS names (kept local: this is a client component). */
const PROVIDER_RETENTION_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Unknown — not yet confirmed with the provider' },
  { value: 'none', label: 'None — zero data retention' },
  { value: 'abuse-monitoring', label: 'Abuse monitoring only (short-lived, e.g. 30 days)' },
  { value: 'stored', label: 'Stored — the provider keeps requests' },
];

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

export default function ModelForms() {
  const listAnchor = useCoachAnchor('admin-models-list');
  const addAnchor = useCoachAnchor('admin-models-add');
  const [state, dispatch] = useReducer(modelFormsReducer, initialModelForms);
  const { models, loadError, editingId, draft, saving, formError } = state;
  const { available, listing, listError, testing, testError, testReply } = state;

  const reload = useCallback(async () => {
    const result = await getJson<{ models: ModelRow[] }>(`/api/admin/llm-models`);
    if (result.error || !result.data) dispatch({ type: 'loadFailed', error: result.error });
    else dispatch({ type: 'loaded', models: result.data.models });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const closeForm = () => dispatch({ type: 'closeForm' });

  const canList = canListOf(state);
  const canTest = canTestOf(state);
  const keyedSiblings = keyedSiblingsOf(state);
  const view = formView(state);
  const isImage = view.defaultBox.disabled;

  const listModels = async () => {
    dispatch({ type: 'listSent' });
    const result = await sendJsonFull<{ models: AvailableModelRow[] }>(
      `/api/admin/llm-models/available`,
      'POST',
      listRequest(state)
    );
    if (result.error || !result.data) dispatch({ type: 'listFailed', error: result.error });
    else dispatch({ type: 'listed', models: result.data.models });
  };

  const testConnection = async () => {
    dispatch({ type: 'testSent' });
    const result = await sendJsonFull<{ model: string; reply: string }>(
      `/api/admin/llm-models/test`,
      'POST',
      testRequest(state)
    );
    if (result.error || !result.data) dispatch({ type: 'testFailed', error: result.error });
    else dispatch({ type: 'tested', reply: result.data.reply });
  };

  const submit = async () => {
    const request = saveRequest(state);
    if (!request.ok) {
      dispatch({ type: 'saveFailed', error: request.error });
      return;
    }
    dispatch({ type: 'saveSent' });
    const result = await sendJsonFull(request.path, request.method, request.body);
    if (result.error) {
      dispatch({ type: 'saveFailed', error: result.error });
      return;
    }
    dispatch({ type: 'saved' });
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
    const result = await sendJsonFull(`/api/admin/llm-models/${row.id}`, 'DELETE');
    if (result.error) dispatch({ type: 'removeFailed', error: result.error });
    else await reload();
  };

  if (isLoading(state)) {
    return (
      <LoadingRegion label="Loading models…">
        <SkeletonCards count={2} lines={1} chips={2} />
      </LoadingRegion>
    );
  }

  return (
    <div {...listAnchor} className="space-y-4">
      {loadError ? <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p> : null}

      {showsEmpty(state) ? (
        <p className="rounded-md border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          No models configured yet — agents cannot run until one is added.
        </p>
      ) : null}

      {(models ?? []).map((row) => {
        const badges = rowView(row);
        return (
          <div
            key={row.id}
            className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {row.label}
                  {badges.isDefault ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                      Default
                    </span>
                  ) : null}
                  {badges.imageGeneration ? (
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300">
                      Image generation
                    </span>
                  ) : null}
                  {badges.disabled ? (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                      Disabled
                    </span>
                  ) : null}
                  {badges.warning ? (
                    <span
                      className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300"
                      title="Data handling: the organization has not recorded a BAA and a retention term for this model. Fill them in under Edit → Data handling."
                    >
                      ⚠ {badges.warning}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {row.provider} · <span className="font-mono">{row.model}</span>
                  {row.baseUrl ? ` · ${row.baseUrl}` : ''} ·{' '}
                  {badges.keyStored ? (
                    'key stored'
                  ) : (
                    <span className="text-red-600 dark:text-red-400">no key stored</span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'startEdit', row })}
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
        );
      })}

      {editingId !== null ? (
        <Modal
          title={editingId === 'new' ? 'Add a model' : 'Edit model'}
          size="lg"
          onClose={closeForm}
        >
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
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
                onChange={(event) =>
                  dispatch({ type: 'edited', field: 'label', value: event.target.value })
                }
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
                onChange={(event) =>
                  dispatch({ type: 'edited', field: 'provider', value: event.target.value })
                }
              >
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI-compatible (OpenAI, Azure AI Foundry)</option>
              </select>
            </div>

            {/*
            Connection info first, what to run on it second: Base URL, API
            key, and API version are exactly what "List available models"
            and "Test connection" below need to reach the right endpoint —
            asking a person to click either before entering a base URL (an
            Azure deployment, a gateway) or a key never worked.
          */}
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
                onChange={(event) =>
                  dispatch({ type: 'edited', field: 'baseUrl', value: event.target.value })
                }
              />
              <p className={hintClass}>
                {PROVIDER_HINTS[draft.provider]?.baseUrl ??
                  'Only for a gateway or proxy in front of the provider.'}
              </p>
            </div>

            {view.showsApiSurface ? (
              <div>
                <label className={labelClass} htmlFor="model-api-surface">
                  API surface
                </label>
                <select
                  id="model-api-surface"
                  className={inputClass}
                  value={draft.apiSurface}
                  onChange={(event) =>
                    dispatch({ type: 'edited', field: 'apiSurface', value: event.target.value })
                  }
                >
                  <option value="">Chat completions (default)</option>
                  <option value="responses">Responses API</option>
                  <option value="images">Images API — gpt-image (image generation)</option>
                  <option value="flux">FLUX — Black Forest Labs (image generation)</option>
                </select>
                {view.imageSurface ? (
                  <p className={hintClass} data-testid="image-surface-hint">
                    For a model that draws pictures rather than chats. It is never offered as a chat
                    model or the default; instead, chats get a &quot;generate image&quot; tool that
                    sends the prompt to it.{' '}
                    {view.imageSurface === 'flux' ? (
                      <>
                        FLUX through its native provider route (FLUX.2 pro / flex): set the base URL
                        to the model&apos;s own endpoint, e.g.{' '}
                        <span className="font-mono break-all">
                          https://&#123;resource&#125;.api.cognitive.microsoft.com/providers/blackforestlabs/v1/flux-2-flex
                        </span>{' '}
                        (a <span className="font-mono">.services.ai.azure.com</span> host works the
                        same; the path is <span className="font-mono">flux-2-pro</span> or{' '}
                        <span className="font-mono">flux-2-flex</span>), the model id to its name
                        (FLUX.2-flex), and the API version to{' '}
                        <span className="font-mono">preview</span>. FLUX.1 Kontext Pro and 1.1 Pro
                        take a different request on this route — pick the Images API for those.
                      </>
                    ) : (
                      <>
                        gpt-image: leave the base URL blank for OpenAI, or on Azure set it to the
                        resource&apos;s <span className="font-mono">/openai/v1</span> surface and
                        the model id to your deployment name. FLUX.1 Kontext and 1.1 Pro deployed on
                        Azure answer on this same route.
                      </>
                    )}
                  </p>
                ) : null}
                {view.showsResponsesHint ? (
                  <p className={hintClass}>
                    Some reasoning-model deployments (an Azure gpt-6-astra-1 case is where this
                    setting came from) cannot make tool calls on chat completions at ANY reasoning
                    effort value — their own error names{' '}
                    <span className="font-mono">/v1/responses</span> as the only path. Switch this
                    only if &quot;Test connection&quot; with tools fails citing
                    <span className="font-mono"> reasoning_effort</span> no matter what you set it
                    to.
                  </p>
                ) : null}
              </div>
            ) : null}

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
                  onChange={(event) =>
                    dispatch({ type: 'edited', field: 'apiKeyFromId', value: event.target.value })
                  }
                >
                  <option value="">
                    {editingId === 'new'
                      ? 'Enter a key'
                      : 'Keep the stored key (or enter a new one)'}
                  </option>
                  {keyedSiblings.map((row) => (
                    <option key={row.id} value={row.id}>
                      Reuse the key stored on “{row.label}”
                    </option>
                  ))}
                </select>
              ) : null}
              {view.showsKeyInput ? (
                <>
                  <input
                    id="model-key"
                    className={inputClass}
                    type="password"
                    value={draft.apiKey}
                    required={view.keyRequired}
                    placeholder={
                      editingId === 'new'
                        ? draft.provider === 'openai'
                          ? 'sk-… or an Azure API key'
                          : 'sk-ant-…'
                        : 'Leave blank to keep the stored key'
                    }
                    autoComplete="off"
                    onChange={(event) =>
                      dispatch({ type: 'edited', field: 'apiKey', value: event.target.value })
                    }
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
              <label className={labelClass} htmlFor="model-api-version">
                API version <span className="font-normal text-gray-500">(optional, Azure)</span>
              </label>
              <input
                id="model-api-version"
                className={inputClass}
                value={draft.apiVersion}
                placeholder="e.g. 2024-05-01-preview"
                onChange={(event) =>
                  dispatch({ type: 'edited', field: 'apiVersion', value: event.target.value })
                }
              />
              <p className={hintClass}>
                Appended as ?api-version=… — only when the Azure surface demands it (a &quot;Missing
                required query parameter: api-version&quot; error). Leave blank for Anthropic,
                OpenAI, and Azure&apos;s /openai/v1 surface.
              </p>
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
                onChange={(event) =>
                  dispatch({ type: 'edited', field: 'model', value: event.target.value })
                }
              />
              <datalist id="model-suggestions">
                {/* Live answers replace the hardcoded guesses once fetched. */}
                {view.modelSuggestions.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
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
                {view.listMissing ? (
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
                        onClick={() => dispatch({ type: 'picked', model: entry.id })}
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

            {/*
              One grid with the labels in their own row: a wrapped label then
              grows its row for both columns, so the two inputs stay level.
            */}
            <div className="grid grid-cols-2 gap-x-3">
              <label className={labelClass} htmlFor="model-max-tokens">
                Max output tokens <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <label className={labelClass} htmlFor="model-temperature">
                Temperature <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <input
                id="model-max-tokens"
                className={inputClass}
                type="text"
                value={draft.maxOutputTokens}
                placeholder="4k"
                onChange={(event) =>
                  dispatch({ type: 'edited', field: 'maxOutputTokens', value: event.target.value })
                }
              />
              <input
                id="model-temperature"
                className={inputClass}
                type="number"
                step="0.1"
                min={0}
                max={1}
                value={draft.temperature}
                placeholder="provider default"
                onChange={(event) =>
                  dispatch({ type: 'edited', field: 'temperature', value: event.target.value })
                }
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="model-context-window">
                Context window (tokens){' '}
                <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <input
                id="model-context-window"
                className={inputClass}
                type="text"
                value={draft.contextWindow}
                placeholder="200k"
                onChange={(event) =>
                  dispatch({ type: 'edited', field: 'contextWindow', value: event.target.value })
                }
              />
              <p className="mt-1 text-xs text-gray-500">
                The most the model can read in one call — type 200k, 1m or 200000. Chats show how
                much of it the conversation uses; leave blank to show usage without a limit.
              </p>
            </div>

            <div>
              <label className={labelClass} htmlFor="model-reasoning-effort">
                Reasoning effort <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <input
                id="model-reasoning-effort"
                className={inputClass}
                value={draft.reasoningEffort}
                list="reasoning-effort-suggestions"
                placeholder="Model default"
                onChange={(event) =>
                  dispatch({ type: 'edited', field: 'reasoningEffort', value: event.target.value })
                }
              />
              <datalist id="reasoning-effort-suggestions">
                {view.reasoningSuggestions.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
              {view.reasoningHint === 'anthropic' ? (
                <p className={hintClass}>
                  Claude 4.6 and later think adaptively, and this is the one dial on how long they
                  deliberate and how many tool rounds they take (sent as output_config.effort: low,
                  medium, high, xhigh or max; blank is the provider&apos;s default, high). A
                  chat&apos;s own Thinking switch only shows or hides the thinking summary on these
                  models — it does not turn thinking off. Set medium or low here when replies think
                  longer than the work needs, or for a model row meant for sub-agents and quick
                  lookups. Ignored on older Claude models, which take a thinking budget instead.
                </p>
              ) : (
                <p className={hintClass}>
                  Reasoning models only (GPT-5 family and newer). Leave temperature blank for these
                  — they reject it. Free text, not a fixed list: which values a model accepts (and
                  whether it accepts &quot;none&quot; at all) is entirely the provider&apos;s call
                  and differs by model — one Azure deployment demanded &quot;none&quot; to allow
                  tool calls at all, another rejected &quot;none&quot; outright and only took
                  low/medium/ high/xhigh. Blank keeps the model&apos;s own default, which is not the
                  same as &quot;none&quot; and may reject tool calls on its own. Check the exact
                  error message — it names the accepted values — and paste one here.
                </p>
              )}
            </div>

            <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
              {/*
              Proves the configuration actually answers, before Save commits
              it: a real chat completion sent with the draft's own settings.
              Listing models (above) only proves the key is valid — a wrong
              Azure deployment name or an unreachable model still lists fine
              and only fails here.
            */}
              <button
                type="button"
                disabled={!canTest || testing}
                onClick={() => void testConnection()}
                className="text-xs font-medium text-blue-600 hover:underline disabled:cursor-not-allowed disabled:text-gray-400 disabled:no-underline dark:text-blue-400 dark:disabled:text-gray-600"
              >
                {testing ? 'Sending a test message…' : 'Test connection'}
              </button>
              {view.testMissing ? (
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  Enter a model id and an API key (or pick one to reuse) first.
                </span>
              ) : null}
              <p className={hintClass}>
                {isImage
                  ? 'An image generation model cannot be tested here: the check sends a chat completion, which it rejects. Ask a chat to draw something to try it.'
                  : 'Sends one real chat completion with these settings — the same check an agent run would make.'}
              </p>
              {testError ? (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{testError}</p>
              ) : null}
              {testReply !== null ? (
                <p className="mt-1 text-xs text-green-700 dark:text-green-400">
                  ✓ The model responded: “{testReply}”
                </p>
              ) : null}
            </div>

            <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
              <legend className="px-1 text-sm font-medium">Data handling</legend>
              <p className={hintClass}>
                Where this model processes requests and what the provider keeps. Recorded by you,
                not checked by Renkei: it is what the roster&apos;s warning badge and the
                &quot;Require a BAA-covered model for PHI connectors&quot; setting go by.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="model-data-residency">
                    Data residency <span className="font-normal text-gray-500">(optional)</span>
                  </label>
                  <input
                    id="model-data-residency"
                    className={inputClass}
                    value={draft.dataResidency}
                    placeholder="e.g. Azure East US, DataZone"
                    onChange={(event) =>
                      dispatch({
                        type: 'edited',
                        field: 'dataResidency',
                        value: event.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="model-provider-retention">
                    Data retention
                  </label>
                  <select
                    id="model-provider-retention"
                    className={inputClass}
                    value={draft.providerRetention}
                    onChange={(event) =>
                      dispatch({
                        type: 'edited',
                        field: 'providerRetention',
                        value: event.target.value,
                      })
                    }
                  >
                    {PROVIDER_RETENTION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.baaCovered}
                  onChange={(event) =>
                    dispatch({ type: 'edited', field: 'baaCovered', value: event.target.checked })
                  }
                />
                Covered by a Business Associate Agreement (BAA)
              </label>
              <div className="mt-3">
                <label className={labelClass} htmlFor="model-data-notes">
                  Notes <span className="font-normal text-gray-500">(optional)</span>
                </label>
                <textarea
                  id="model-data-notes"
                  className={inputClass}
                  rows={2}
                  value={draft.notes}
                  placeholder="Contract reference, date confirmed, who to ask"
                  onChange={(event) =>
                    dispatch({ type: 'edited', field: 'notes', value: event.target.value })
                  }
                />
              </div>
            </fieldset>

            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    dispatch({ type: 'edited', field: 'enabled', value: event.target.checked })
                  }
                />
                Enabled
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={view.defaultBox.checked}
                  disabled={view.defaultBox.disabled}
                  onChange={(event) =>
                    dispatch({ type: 'edited', field: 'isDefault', value: event.target.checked })
                  }
                />
                Organization default
              </label>
            </div>

            {formError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>
            ) : null}

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
                onClick={closeForm}
                className="rounded-md border border-gray-300 px-4 py-1.5 text-sm dark:border-gray-700"
              >
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      <button
        {...addAnchor}
        type="button"
        onClick={() => dispatch({ type: 'startCreate' })}
        className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        + Add a model
      </button>
    </div>
  );
}
