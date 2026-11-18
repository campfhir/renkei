'use client';

/**
 * One building block's editor: describe it and let the AI draft it, or
 * fill the definition in by hand — where it runs, its inputs, the
 * variables and secrets it needs, the artifacts it takes and leaves, its
 * caches and its commands — and see it as Bitbucket's or GitHub's
 * pipeline file would get it. Save keeps a draft; Publish makes it the
 * next version. Every rule is block-editor.model.ts's; this makes the
 * calls and draws.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useReducer, useState } from 'react';
import { BLOCK_KINDS, INPUT_TYPES } from '@renkei/ci-blocks';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import {
  KIND_LABELS,
  blockEditorReducer,
  canPublish,
  canSave,
  hostNoteOf,
  initialEditor,
  isDirty,
  previewFileOf,
  previewOf,
  problemsOf,
  publishLabel,
  saveRequest,
  statusOf,
  type BlockDetailView,
} from './block-editor.model';

/** A field sized by its row; `input` fills its column. */
const field =
  'rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
const input = `w-full ${field}`;
const label = 'flex flex-col gap-1 text-xs font-semibold text-gray-700 dark:text-gray-300';
const secondary =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';
const primary =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const cell = 'border-b border-gray-100 px-1.5 py-1 align-top dark:border-gray-900';
const removeButton =
  'rounded px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-900';

export default function BlockEditor({
  blockId,
  askFirst,
}: {
  blockId: string | null;
  askFirst: boolean;
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(blockEditorReducer, blockId, initialEditor);
  const [ask, setAsk] = useState('');

  useEffect(() => {
    if (!blockId) return;
    let cancelled = false;
    void (async () => {
      const result = await getJson<BlockDetailView>(`/api/admin/ci-blocks/${blockId}`);
      if (cancelled) return;
      if (result.data) dispatch({ type: 'loaded', block: result.data });
      else dispatch({ type: 'loadFailed', error: result.error ?? 'The block could not be read.' });
    })();
    return () => {
      cancelled = true;
    };
  }, [blockId]);

  useEffect(() => {
    if (state.gone) router.push('/admin/ci-blocks');
  }, [state.gone, router]);

  /** Save what is on screen; the block's id, or null when it was refused. */
  const save = async (): Promise<string | null> => {
    const request = saveRequest(state);
    dispatch({ type: 'sent', busy: 'save' });
    const result = await sendJsonFull<{ id?: string }>(request.url, request.method, request.body);
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return null;
    }
    const id = state.blockId ?? result.data?.id ?? null;
    if (!id) {
      dispatch({ type: 'failed', error: 'The block was not saved.' });
      return null;
    }
    dispatch({ type: 'saved', id });
    if (!state.blockId) router.replace(`/admin/ci-blocks/${id}`);
    return id;
  };

  const publish = async () => {
    const id = isDirty(state) ? await save() : state.blockId;
    if (!id) return;
    dispatch({ type: 'sent', busy: 'publish' });
    const result = await sendJsonFull<{ version?: number; problems?: string[] }>(
      `/api/admin/ci-blocks/${id}/publish`,
      'POST',
      {}
    );
    if (result.error || typeof result.data?.version !== 'number') {
      dispatch({
        type: 'failed',
        error: result.error ?? 'The block was not published.',
        problems: Array.isArray(result.data?.problems) ? result.data.problems : [],
      });
      return;
    }
    dispatch({ type: 'published', version: result.data.version });
  };

  const discard = async () => {
    if (!state.blockId) return;
    dispatch({ type: 'sent', busy: 'discard' });
    const result = await sendJsonFull(`/api/admin/ci-blocks/${state.blockId}/discard`, 'POST', {});
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    const block = await getJson<BlockDetailView>(`/api/admin/ci-blocks/${state.blockId}`);
    if (block.data) dispatch({ type: 'discarded', block: block.data });
    else dispatch({ type: 'failed', error: block.error ?? 'The block could not be read again.' });
  };

  const remove = async () => {
    if (!state.blockId) return;
    if (
      !window.confirm(
        `Delete “${state.form.name}” and every version of it? Pipelines already written keep their YAML.`
      )
    )
      return;
    dispatch({ type: 'sent', busy: 'delete' });
    const result = await sendJsonFull(`/api/admin/ci-blocks/${state.blockId}`, 'DELETE');
    if (result.error) dispatch({ type: 'failed', error: result.error });
    else dispatch({ type: 'deleted' });
  };

  const draftWithAi = async () => {
    dispatch({ type: 'sent', busy: 'draft' });
    const result = await sendJsonFull<{
      key?: string;
      name?: string;
      description?: string;
      definition?: unknown;
    }>('/api/admin/ci-blocks/draft', 'POST', { description: ask });
    if (result.error || !result.data?.definition) {
      dispatch({ type: 'failed', error: result.error ?? 'Nothing was drafted.' });
      return;
    }
    dispatch({
      type: 'drafted',
      definition: result.data.definition,
      ...(result.data.key ? { key: result.data.key } : {}),
      ...(result.data.name ? { name: result.data.name } : {}),
      ...(result.data.description ? { description: result.data.description } : {}),
    });
  };

  if (state.loading) return <p className="text-sm text-gray-500">Loading the block…</p>;
  if (state.loadError) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {state.loadError}
      </p>
    );
  }

  const { form } = state;
  const problems = problemsOf(state);
  const preview = previewOf(state);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/admin/ci-blocks"
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          ← Building blocks
        </Link>
        <h1 className="min-w-0 flex-[1_1_280px] text-xl font-bold break-words">
          {form.name.trim() || 'New block'}{' '}
          <span
            className="align-middle text-xs font-medium text-gray-500"
            data-testid="block-status"
          >
            {statusOf(state)}
          </span>
        </h1>
        {state.blockId && state.hasDraft && state.latestVersion > 0 ? (
          <button
            type="button"
            className={secondary}
            disabled={state.busy !== null}
            onClick={() => void discard()}
          >
            Discard changes
          </button>
        ) : null}
        <button
          type="button"
          className={secondary}
          disabled={!canSave(state)}
          onClick={() => void save()}
        >
          {state.busy === 'save' ? 'Saving…' : 'Save draft'}
        </button>
        <button
          type="button"
          className={primary}
          disabled={!canPublish(state)}
          onClick={() => void publish()}
        >
          {state.busy === 'publish' ? 'Publishing…' : publishLabel(state)}
        </button>
      </div>

      {state.notice ? (
        <p
          role="status"
          className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-300"
        >
          {state.notice}
        </p>
      ) : null}
      {state.error ? (
        <div
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>{state.error}</p>
          {state.problems.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {state.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <section
        aria-label="Draft with AI"
        className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900 dark:bg-indigo-950/30"
      >
        <label htmlFor="block-ask" className="text-sm font-semibold">
          Describe the block you want
        </label>
        <textarea
          id="block-ask"
          className={input}
          rows={2}
          autoFocus={askFirst}
          value={ask}
          maxLength={2000}
          onChange={(event) => setAsk(event.target.value)}
          placeholder="Deploy a Go service to our on-prem worker machines with systemd, check /healthz for a minute, and roll back if it never answers."
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            disabled={state.busy !== null || ask.trim().length < 10}
            onClick={() => void draftWithAi()}
          >
            {state.busy === 'draft' ? 'Drafting…' : 'Draft the block'}
          </button>
          <span className="text-xs text-gray-600 dark:text-gray-400">
            Drafted from your description and the organization’s existing blocks. It fills the form
            below; nothing is saved until you save it.
          </span>
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <section
          aria-label="Definition"
          className="min-w-0 flex-[1_1_440px] space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
        >
          <h2 className="text-sm font-semibold">
            Definition <span className="font-normal text-gray-500">— the same on every host</span>
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className={label}>
              Name
              <input
                className={input}
                value={form.name}
                maxLength={200}
                onChange={(e) => dispatch({ type: 'field', field: 'name', value: e.target.value })}
              />
            </label>
            <label className={label}>
              Key{' '}
              <span className="font-normal text-gray-500">
                how pipelines name it{state.blockId ? '; fixed once created' : ''}
              </span>
              <input
                className={`${input} font-mono`}
                value={form.key}
                readOnly={state.blockId !== null}
                placeholder="deploy-systemd"
                maxLength={80}
                onChange={(e) => dispatch({ type: 'field', field: 'key', value: e.target.value })}
              />
            </label>
            <label className={`${label} sm:col-span-2`}>
              Description
              <input
                className={input}
                value={form.description}
                maxLength={1000}
                onChange={(e) =>
                  dispatch({ type: 'field', field: 'description', value: e.target.value })
                }
              />
            </label>
            <label className={label}>
              Kind
              <select
                className={input}
                value={form.kind}
                onChange={(e) =>
                  dispatch({
                    type: 'kind',
                    kind: BLOCK_KINDS.find((k) => k === e.target.value) ?? form.kind,
                  })
                }
              >
                {BLOCK_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              Runs on
              <select
                className={input}
                value={form.runsOn}
                onChange={(e) =>
                  dispatch({
                    type: 'runsOn',
                    runsOn: e.target.value === 'target' ? 'target' : 'hosted',
                  })
                }
              >
                <option value="hosted">A hosted runner, in a container image</option>
                <option value="target">A target the pipeline picks (self-hosted runners)</option>
              </select>
            </label>
            {form.runsOn === 'hosted' ? (
              <label className={`${label} sm:col-span-2`}>
                Container image
                <input
                  className={`${input} font-mono`}
                  value={form.image}
                  placeholder="node:22"
                  onChange={(e) =>
                    dispatch({ type: 'field', field: 'image', value: e.target.value })
                  }
                />
              </label>
            ) : null}
          </div>

          <fieldset className="min-w-0 space-y-1">
            <legend className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              Inputs a pipeline fills in
            </legend>
            {form.inputs.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500">
                      <th className="px-1.5 font-medium">Name</th>
                      <th className="px-1.5 font-medium">Type</th>
                      <th className="px-1.5 font-medium">Default</th>
                      <th className="px-1.5 font-medium">What it is</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {form.inputs.map((row, index) => (
                      <tr key={index}>
                        <td className={cell}>
                          <input
                            aria-label={`Input ${index + 1} name`}
                            className={`${input} font-mono`}
                            value={row.name}
                            onChange={(e) =>
                              dispatch({ type: 'input', index, patch: { name: e.target.value } })
                            }
                          />
                        </td>
                        <td className={cell}>
                          <select
                            aria-label={`Input ${index + 1} type`}
                            className={input}
                            style={{ minWidth: '6.5rem' }}
                            value={row.type}
                            onChange={(e) =>
                              dispatch({
                                type: 'input',
                                index,
                                patch: {
                                  type: INPUT_TYPES.find((t) => t === e.target.value) ?? 'text',
                                },
                              })
                            }
                          >
                            {INPUT_TYPES.map((type) => (
                              <option key={type}>{type}</option>
                            ))}
                          </select>
                        </td>
                        <td className={cell}>
                          <input
                            aria-label={`Input ${index + 1} default`}
                            className={input}
                            value={row.default}
                            placeholder="required"
                            onChange={(e) =>
                              dispatch({ type: 'input', index, patch: { default: e.target.value } })
                            }
                          />
                        </td>
                        <td className={cell}>
                          <input
                            aria-label={`Input ${index + 1} description`}
                            className={input}
                            value={row.description}
                            onChange={(e) =>
                              dispatch({
                                type: 'input',
                                index,
                                patch: { description: e.target.value },
                              })
                            }
                          />
                        </td>
                        <td className={cell}>
                          <button
                            type="button"
                            aria-label={`Remove input ${index + 1}`}
                            className={removeButton}
                            onClick={() => dispatch({ type: 'removeRow', list: 'inputs', index })}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <button
              type="button"
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => dispatch({ type: 'addRow', list: 'inputs' })}
            >
              + Add input
            </button>
          </fieldset>

          <fieldset className="min-w-0 space-y-1">
            <legend className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              Variables and secrets it reads
            </legend>
            {form.variables.map((row, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`Variable ${index + 1} name`}
                  className={`${field} w-48 flex-none font-mono`}
                  value={row.name}
                  placeholder="REGISTRY_TOKEN"
                  onChange={(e) =>
                    dispatch({ type: 'variable', index, patch: { name: e.target.value } })
                  }
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={row.secured}
                    onChange={(e) =>
                      dispatch({ type: 'variable', index, patch: { secured: e.target.checked } })
                    }
                  />
                  Secret
                </label>
                <input
                  aria-label={`Variable ${index + 1} description`}
                  className={`${field} min-w-0 flex-1`}
                  value={row.description}
                  placeholder="What it is"
                  onChange={(e) =>
                    dispatch({ type: 'variable', index, patch: { description: e.target.value } })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove variable ${index + 1}`}
                  className={removeButton}
                  onClick={() => dispatch({ type: 'removeRow', list: 'variables', index })}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => dispatch({ type: 'addRow', list: 'variables' })}
            >
              + Add variable
            </button>
          </fieldset>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className={label}>
              Artifacts it takes{' '}
              <span className="font-normal text-gray-500">from earlier blocks, by name</span>
              <input
                className={`${input} font-mono`}
                value={form.consumes}
                placeholder="dist"
                onChange={(e) =>
                  dispatch({ type: 'field', field: 'consumes', value: e.target.value })
                }
              />
            </label>
            <fieldset className="min-w-0 space-y-1">
              <legend className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                Artifacts it leaves
              </legend>
              {form.produces.map((row, index) => (
                <div key={index} className="flex gap-1.5">
                  <input
                    aria-label={`Artifact ${index + 1} name`}
                    className={`${field} w-24 flex-none font-mono`}
                    value={row.name}
                    placeholder="dist"
                    onChange={(e) =>
                      dispatch({ type: 'artifact', index, patch: { name: e.target.value } })
                    }
                  />
                  <input
                    aria-label={`Artifact ${index + 1} paths`}
                    className={`${field} min-w-0 flex-1 font-mono`}
                    value={row.paths}
                    placeholder="dist, build/report.xml"
                    onChange={(e) =>
                      dispatch({ type: 'artifact', index, patch: { paths: e.target.value } })
                    }
                  />
                  <button
                    type="button"
                    aria-label={`Remove artifact ${index + 1}`}
                    className={removeButton}
                    onClick={() => dispatch({ type: 'removeRow', list: 'produces', index })}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                onClick={() => dispatch({ type: 'addRow', list: 'produces' })}
              >
                + Add artifact
              </button>
            </fieldset>
          </div>

          <fieldset className="min-w-0 space-y-1">
            <legend className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              Caches
            </legend>
            {form.caches.map((row, index) => (
              <div key={index} className="flex flex-wrap gap-1.5">
                <input
                  aria-label={`Cache ${index + 1} name`}
                  className={`${field} w-24 flex-none font-mono`}
                  value={row.name}
                  placeholder="npm"
                  onChange={(e) =>
                    dispatch({ type: 'cache', index, patch: { name: e.target.value } })
                  }
                />
                <input
                  aria-label={`Cache ${index + 1} directory`}
                  className={`${field} w-40 flex-none font-mono`}
                  value={row.path}
                  placeholder="~/.npm"
                  onChange={(e) =>
                    dispatch({ type: 'cache', index, patch: { path: e.target.value } })
                  }
                />
                <input
                  aria-label={`Cache ${index + 1} key files`}
                  className={`${field} min-w-0 flex-1 font-mono`}
                  value={row.keyFiles}
                  placeholder="package-lock.json"
                  onChange={(e) =>
                    dispatch({ type: 'cache', index, patch: { keyFiles: e.target.value } })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove cache ${index + 1}`}
                  className={removeButton}
                  onClick={() => dispatch({ type: 'removeRow', list: 'caches', index })}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => dispatch({ type: 'addRow', list: 'caches' })}
            >
              + Add cache
            </button>
          </fieldset>

          <label className={label}>
            Commands
            <textarea
              aria-label="Commands"
              className={`${input} font-mono text-xs`}
              rows={9}
              spellCheck={false}
              value={form.commands}
              onChange={(e) =>
                dispatch({ type: 'field', field: 'commands', value: e.target.value })
              }
            />
            <span className="font-normal text-gray-500">
              <span className="font-mono">{'${commit}'}</span>,{' '}
              <span className="font-mono">{'${branch}'}</span>,{' '}
              <span className="font-mono">{'${repo}'}</span>,{' '}
              <span className="font-mono">{'${env}'}</span> (deploy blocks) and{' '}
              <span className="font-mono">{'${input.NAME}'}</span> become each host’s own; variables
              are read as <span className="font-mono">$NAME</span>.
            </span>
          </label>
        </section>

        <section
          aria-label="Preview"
          className="min-w-0 flex-[1_1_440px] overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
            <h2 className="flex-[1_1_160px] text-sm font-semibold">As the pipeline file gets it</h2>
            <div
              role="group"
              aria-label="Host"
              className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-700"
            >
              {(['bitbucket', 'github'] as const).map((host) => (
                <button
                  key={host}
                  type="button"
                  aria-pressed={state.host === host}
                  onClick={() => dispatch({ type: 'host', host })}
                  className={`px-3 py-1.5 text-xs font-semibold ${
                    state.host === host
                      ? 'bg-blue-700 text-white'
                      : 'bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-300'
                  }`}
                >
                  {host === 'bitbucket' ? 'Bitbucket Pipelines' : 'GitHub Actions'}
                </button>
              ))}
            </div>
          </div>
          <div className="border-b border-gray-200 bg-gray-50 px-3 py-1.5 font-mono text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            {previewFileOf(state.host)}
          </div>
          {preview ? (
            <pre
              className="overflow-x-auto bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100"
              data-testid="block-preview"
            >
              {preview}
            </pre>
          ) : (
            <div className="p-3 text-sm" data-testid="block-problems">
              <p className="mb-1 font-medium">Not ready to show yet:</p>
              <ul className="list-disc space-y-0.5 pl-5 text-gray-700 dark:text-gray-300">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">{hostNoteOf(state)}</p>
        </section>
      </div>

      {state.versions.length > 0 ? (
        <section
          aria-label="Versions"
          className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800"
        >
          <h2 className="mb-1 text-sm font-semibold">Versions</h2>
          <ul className="space-y-0.5 text-gray-700 dark:text-gray-300">
            {state.versions.map((version) => (
              <li key={version.version}>
                <span className="font-mono">v{version.version}</span> · {version.publishedBy} ·{' '}
                {version.publishedAt === 'just now'
                  ? 'just now'
                  : new Date(version.publishedAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.blockId ? (
        <button
          type="button"
          className="text-sm text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
          disabled={state.busy !== null}
          onClick={() => void remove()}
        >
          Delete this block
        </button>
      ) : null}
    </div>
  );
}
