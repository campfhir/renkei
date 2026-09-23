'use client';

/**
 * The Pipelines section of a Bitbucket code project's page: whether
 * Bitbucket runs pipelines for the repository at all, whether a
 * `bitbucket-pipelines.yml` is on the branch, and the variables the
 * runs get — the repository's and each deployment environment's. Read
 * on open and after every change, with the person's own Bitbucket grant.
 *
 * None of this is a chat tool, on purpose: a chat can write the YAML
 * (a file, committed like any other), but the switch and the variables
 * — where deploy keys and registry tokens live — are set here by a
 * person. A secured value goes to Bitbucket once and is never shown
 * again; Bitbucket itself never sends one back.
 */

import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { PipelineSetup, PipelineVariable } from '@/lib/code/bitbucket-pipelines';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';
const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
const linkButtonClass =
  'text-xs font-medium whitespace-nowrap text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400';

interface Setup extends PipelineSetup {
  access: {
    /** Why the switch cannot be flipped from here; null when it can. */
    configureNeeds: string | null;
    /** Why variables cannot be set from here; null when they can. */
    variablesNeeds: string | null;
  };
}

/** Which set a form writes to: the repository's, or one environment's. */
type Scope = { environmentUuid?: string };

interface Draft extends Scope {
  /** Set when editing; absent when adding. */
  editing?: PipelineVariable;
  key: string;
  value: string;
  secured: boolean;
}

export default function PipelinesSection({
  tenantId,
  projectId,
  repoFullName,
  branch,
  canEdit,
}: {
  tenantId: string;
  projectId: string;
  repoFullName: string;
  /** The project's branch; empty for the repository's default. */
  branch: string;
  canEdit: boolean;
}) {
  const url = `/api/tenant/${tenantId}/code/projects/${projectId}/pipelines`;
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const reload = useCallback(async () => {
    const result = await getJson<Setup>(url);
    if (result.data) {
      setSetup(result.data);
      setLoadError(null);
    } else setLoadError(result.error ?? 'The pipelines setup could not be read.');
  }, [url]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (work: () => Promise<{ error: string | null }>) => {
    setBusy(true);
    setError(null);
    const result = await work();
    if (result.error) setError(result.error);
    else await reload();
    setBusy(false);
    return !result.error;
  };

  const flip = (enabled: boolean) => void act(async () => sendJsonFull(url, 'PUT', { enabled }));

  const save = async () => {
    if (!draft) return;
    const body = {
      key: draft.key.trim(),
      value: draft.value,
      secured: draft.secured,
      ...(draft.environmentUuid ? { environmentUuid: draft.environmentUuid } : {}),
    };
    const saved = await act(() =>
      draft.editing
        ? sendJsonFull(url, 'PATCH', { ...body, uuid: draft.editing.uuid })
        : sendJsonFull(url, 'POST', body)
    );
    if (saved) setDraft(null);
  };

  const remove = (variable: PipelineVariable, scope: Scope) => {
    if (!window.confirm(`Remove ${variable.key}? Pipeline runs will no longer see it.`)) return;
    void act(() =>
      sendJsonFull(url, 'DELETE', {
        uuid: variable.uuid,
        key: variable.key,
        ...(scope.environmentUuid ? { environmentUuid: scope.environmentUuid } : {}),
      })
    );
  };

  const [workspace, slug] = repoFullName.split('/');
  const pipelinesUrl =
    workspace && slug
      ? `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/pipelines`
      : null;
  const branchLabel = branch || 'the default branch';
  const canSetVariables = canEdit && setup?.access.variablesNeeds === null;

  const statusPill =
    setup === null ? null : setup.enabled === true ? (
      <Pill tone="green">On</Pill>
    ) : setup.enabled === false ? (
      <Pill tone="gray">Off</Pill>
    ) : null;

  return (
    <section className={sectionClass} aria-busy={busy || setup === null}>
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Pipelines</h2>
          {statusPill}
          {pipelinesUrl ? (
            <a
              href={pipelinesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
            >
              Open on Bitbucket
            </a>
          ) : null}
        </div>
        <p className="text-xs text-gray-500">
          How Bitbucket builds and deploys this repository. A chat can write the pipeline file; the
          switch and the variables are set here, by you, and chats never see them.
        </p>
      </div>

      {loadError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {loadError}
        </p>
      ) : setup === null ? (
        <p className="text-sm text-gray-500">Reading from Bitbucket…</p>
      ) : (
        <>
          <dl className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <dt className="text-gray-500">Pipelines on Bitbucket</dt>
              <dd className="flex min-w-0 flex-1 items-center gap-2">
                {setup.enabled === null ? (
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    {setup.enabledError ?? 'Could not be read.'}
                  </span>
                ) : (
                  <>
                    <span>{setup.enabled ? 'On' : 'Off'}</span>
                    {canEdit ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => flip(!setup.enabled)}
                        className={linkButtonClass}
                      >
                        {setup.enabled ? 'Turn off' : 'Turn on'}
                      </button>
                    ) : null}
                  </>
                )}
              </dd>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <dt className="text-gray-500">
                <span className="font-mono">bitbucket-pipelines.yml</span>
              </dt>
              <dd className="min-w-0 flex-1">
                {setup.configFile === 'present' ? (
                  <span>On {branchLabel}.</span>
                ) : setup.configFile === 'absent' ? (
                  <span>
                    Not on {branchLabel} yet — ask a chat in this project to write one. Runs start
                    once it is committed and Pipelines is on.
                  </span>
                ) : (
                  <span className="text-gray-500">Could not be checked.</span>
                )}
              </dd>
            </div>
          </dl>

          <VariableGroup
            title="Repository variables"
            hint="Every pipeline run gets these."
            variables={setup.variables}
            error={setup.variablesError}
            scope={{}}
            canEdit={canSetVariables}
            needs={canEdit ? setup.access.variablesNeeds : null}
            busy={busy}
            draft={draft}
            setDraft={setDraft}
            onSave={save}
            onRemove={remove}
          />
          {setup.environments.map((environment) => (
            <VariableGroup
              key={environment.uuid}
              title={environment.name}
              hint={`Runs deploying to this ${environment.type ? environment.type.toLowerCase() + ' ' : ''}environment get these as well.`}
              variables={environment.variables}
              error={environment.error}
              scope={{ environmentUuid: environment.uuid }}
              canEdit={canSetVariables}
              needs={null}
              busy={busy}
              draft={draft}
              setDraft={setDraft}
              onSave={save}
              onRemove={remove}
            />
          ))}
          {setup.environmentsError ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              Deployment environments could not be read: {setup.environmentsError}
            </p>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function VariableGroup({
  title,
  hint,
  variables,
  error,
  scope,
  canEdit,
  needs,
  busy,
  draft,
  setDraft,
  onSave,
  onRemove,
}: {
  title: string;
  hint: string;
  variables: PipelineVariable[];
  error: string | null;
  scope: Scope;
  canEdit: boolean;
  /** Why an editor still cannot set variables, shown once on the first group. */
  needs: string | null;
  busy: boolean;
  draft: Draft | null;
  setDraft: (draft: Draft | null) => void;
  onSave: () => Promise<void>;
  onRemove: (variable: PipelineVariable, scope: Scope) => void;
}) {
  const here = (draft: Draft | null): draft is Draft =>
    draft !== null && (draft.environmentUuid ?? '') === (scope.environmentUuid ?? '');
  const open = here(draft) ? draft : null;
  const groupId = `pipeline-variables-${scope.environmentUuid ?? 'repository'}`;
  return (
    <div className="mt-4" role="group" aria-labelledby={groupId}>
      <div className="flex items-center gap-2">
        <h3 id={groupId} className="text-sm font-medium">
          {title}
        </h3>
        {canEdit ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setDraft({ ...scope, key: '', value: '', secured: true })}
            className={`ml-auto ${linkButtonClass}`}
          >
            Add variable
          </button>
        ) : null}
      </div>
      <p className="text-xs text-gray-500">{hint}</p>
      {error ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{error}</p>
      ) : variables.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">No variables.</p>
      ) : (
        <ul className="mt-1 divide-y divide-gray-200 text-sm dark:divide-gray-800">
          {variables.map((variable) => (
            <li key={variable.uuid} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-mono">{variable.key}</span>
                {variable.secured ? (
                  <span className="ml-2">
                    <Pill tone="gray">Secured</Pill>
                  </span>
                ) : (
                  <span className="ml-2 font-mono text-xs text-gray-500">
                    {variable.value || '(empty)'}
                  </span>
                )}
              </span>
              {canEdit ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setDraft({
                        ...scope,
                        editing: variable,
                        key: variable.key,
                        value: variable.value ?? '',
                        secured: variable.secured,
                      })
                    }
                    className={linkButtonClass}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRemove(variable, scope)}
                    className="text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                  >
                    Remove
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {needs ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{needs}</p> : null}
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
          aria-label={open.editing ? `Edit ${open.editing.key}` : `Add a variable to ${title}`}
          className="mt-3 space-y-2"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="text-gray-500">Name</span>
              <input
                value={open.key}
                onChange={(event) => setDraft({ ...open, key: event.target.value })}
                spellCheck={false}
                autoComplete="off"
                placeholder="DEPLOY_TOKEN"
                className={`mt-0.5 font-mono ${inputClass}`}
              />
            </label>
            <label className="block text-xs">
              <span className="text-gray-500">Value</span>
              <input
                type={open.secured ? 'password' : 'text'}
                value={open.value}
                onChange={(event) => setDraft({ ...open, value: event.target.value })}
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  open.editing?.secured ? 'Leave empty to keep the current value' : undefined
                }
                className={`mt-0.5 font-mono ${inputClass}`}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={open.secured}
              onChange={(event) => setDraft({ ...open, secured: event.target.checked })}
            />
            Secured — Bitbucket masks it in logs and never shows the value again
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !open.key.trim()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'green' | 'gray'; children: string }) {
  const tones = {
    green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
