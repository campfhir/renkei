'use client';

/**
 * A Bitbucket code project's Pipelines page: the recent runs, the setup
 * — whether Bitbucket runs pipelines for the repository at all, and
 * whether a `bitbucket-pipelines.yml` is on the branch, with an editor
 * that starts one from the org's pipeline templates and commits it, or
 * edits the one there — and the
 * variables the runs get, the repository's and each deployment
 * environment's — each set edited as one text box, `KEY=value` a line,
 * and applied as a difference. Read on open and after every change,
 * with the person's own Bitbucket grant. Its summary card on the project page is
 * pipelines-summary.tsx.
 *
 * A run can be started from here too, on the scope the chat's trigger
 * tool stands on. The switch and the variables, though, are no chat
 * tool, on purpose: a chat can write the YAML (a file, committed like
 * any other) and run or stop a pipeline, but where deploy keys and
 * registry tokens live is set here by a person. A secured value goes to Bitbucket once and
 * is never shown again; Bitbucket itself never sends one back.
 *
 * The layout is one column of cards on a phone (where the runs are
 * cards too, not a table) and two on a wide screen, runs beside setup
 * and variables; a GitHub Actions variant would fill the same frame
 * from its own reader. What the page decides — the requests, when they
 * can be sent, what a save takes away, the words after each change — is
 * pipelines-page.model.ts.
 */

import { useCallback, useEffect, useReducer, type Dispatch } from 'react';
import BackLink from '@/components/back-link';
import ExternalLink from '@/components/external-link';
import LocalTime from '@/components/local-time';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type {
  PipelineRun,
  PipelineVariable,
  VariablesApplied,
} from '@/lib/code/bitbucket-pipelines';
import type { PipelineTemplate } from '@/lib/code/pipeline-templates';
import Pill from './pill';
import {
  branchLabel as labelOfBranch,
  canCommit,
  canRun,
  canSetVariables as mayVariables,
  canStartRun,
  committedReminder,
  draftFor,
  duration,
  environmentHint,
  fileRequest,
  initialPipelines,
  outcomeFor,
  outcomeLines,
  outcomeOf,
  pipelinesReducer,
  pipelinesUrl as urlOfPipelines,
  removalQuestion,
  runRequest,
  runStatePill,
  templateBlankOption,
  templateOptionLabel,
  textRows,
  variableShown,
  variablesButtonLabel,
  variablesGoing,
  variablesRequest,
  type Committed,
  type Draft,
  type Outcome,
  type PipelinesAction,
  type RunDraft,
  type Scope,
  type Setup,
} from './pipelines-page.model';

const cardClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';
const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
const linkButtonClass =
  'text-xs font-medium whitespace-nowrap text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400';

export default function PipelinesPage({
  projectId,
  projectName,
  repoFullName,
  branch,
  canEdit,
}: {
  projectId: string;
  projectName: string;
  repoFullName: string;
  /** The project's branch; empty for the repository's default. */
  branch: string;
  canEdit: boolean;
}) {
  const url = `/api/code/projects/${projectId}/pipelines`;
  const [state, dispatch] = useReducer(pipelinesReducer, initialPipelines);
  const {
    setup,
    loadError,
    error,
    busy,
    draft,
    runDraft,
    started,
    fileDraft,
    templates,
    committed,
  } = state;

  const reload = useCallback(async () => {
    const result = await getJson<Setup>(url);
    if (result.data) dispatch({ type: 'loaded', setup: result.data });
    else
      dispatch({ type: 'loadFailed', error: result.error ?? 'The pipelines could not be read.' });
  }, [url]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Send a change; on success read the setup again before saying it is done. */
  const act = async (
    what: 'flip' | 'variables' | 'run' | 'file',
    work: () => Promise<{ error: string | null }>,
    done: () => PipelinesAction
  ) => {
    dispatch({ type: 'sent', what });
    const result = await work();
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    await reload();
    dispatch(done());
  };

  const flip = (enabled: boolean) =>
    void act(
      'flip',
      async () => sendJsonFull(url, 'PUT', { enabled }),
      () => ({ type: 'flipped' })
    );

  /**
   * Save one set from its text. Keys about to disappear are named first:
   * a secured value cannot be brought back once its line is gone.
   */
  const saveVariables = async (current: PipelineVariable[]) => {
    if (!draft) return;
    const question = removalQuestion(variablesGoing(draft.text, current));
    if (question && !window.confirm(question)) return;
    let result: Outcome | null = null;
    await act(
      'variables',
      async () => {
        const response = await sendJsonFull<VariablesApplied & { problems: string[] }>(
          `${url}/variables`,
          'PUT',
          variablesRequest(draft)
        );
        if (response.data && !response.error) result = outcomeOf(draft, response.data);
        return response;
      },
      () => ({ type: 'variablesSaved', outcome: result })
    );
  };

  /** Open the file editor: the file as it is on the branch, or empty for a template to fill. */
  const openFile = async () => {
    dispatch({ type: 'fileOpening' });
    const [file, catalog] = await Promise.all([
      getJson<{ ref: string; text: string | null }>(`${url}/config-file`),
      templates
        ? Promise.resolve({ data: { templates }, error: null })
        : getJson<{ templates: PipelineTemplate[] }>(
            `/api/code/pipeline-templates?provider=atlassian-bitbucket`
          ),
    ]);
    if (file.error) {
      dispatch({ type: 'fileOpenFailed', error: file.error });
      return;
    }
    dispatch({
      type: 'fileOpened',
      text: file.data?.text ?? null,
      templates: catalog.data?.templates ?? [],
    });
  };

  const commitFile = async () => {
    if (!fileDraft) return;
    let result: Committed | null = null;
    await act(
      'file',
      async () => {
        const response = await sendJsonFull<Committed>(
          `${url}/config-file`,
          'PUT',
          fileRequest(fileDraft)
        );
        result = response.data && !response.error ? response.data : null;
        return response;
      },
      () => ({ type: 'fileCommitted', committed: result })
    );
  };

  const startRun = async () => {
    if (!runDraft) return;
    let run: PipelineRun | null = null;
    await act(
      'run',
      async () => {
        const result = await sendJsonFull<{ run: PipelineRun }>(
          `${url}/runs`,
          'POST',
          runRequest(runDraft)
        );
        run = result.data?.run ?? null;
        return result;
      },
      () => ({ type: 'runStarted', run })
    );
  };

  const pipelinesUrl = urlOfPipelines(repoFullName);
  const branchLabel = labelOfBranch(branch);
  const canSetVariables = mayVariables(state, canEdit);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <BackLink href={`/code/${projectId}`} label={projectName} />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-sm font-semibold">
            <span className="truncate">Pipelines</span>
            {setup ? <StatusPill enabled={setup.enabled} /> : null}
          </h1>
          <p className="truncate text-xs text-gray-500">
            {projectName} · <span className="font-mono">{repoFullName}</span>
          </p>
        </div>
        <button
          type="button"
          disabled={busy || setup === null}
          onClick={() => void reload()}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Refresh
        </button>
        {pipelinesUrl ? (
          <ExternalLink
            href={pipelinesUrl}
            className="text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
          >
            Open on Bitbucket
          </ExternalLink>
        ) : null}
      </header>

      <div className="mx-auto max-w-6xl space-y-4 p-4">
        <p className="text-xs text-gray-500">
          How Bitbucket builds and deploys this repository. A chat in the project can write the
          pipeline file and start or stop runs; the switch and the variables are set here, by you,
          and chats never see them.
        </p>
        {loadError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {loadError}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        {setup === null && !loadError ? (
          <p className="text-sm text-gray-500">Reading from Bitbucket…</p>
        ) : null}
        {setup ? (
          <div
            aria-busy={busy}
            className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start"
          >
            <div className="space-y-4">
              <RunsCard
                runs={setup.runs}
                error={setup.runsError}
                canRun={canRun(state, canEdit)}
                canStart={canStartRun(state)}
                busy={busy}
                draft={runDraft}
                dispatch={dispatch}
                defaultRef={branch || 'main'}
                onStart={startRun}
                started={started}
              />
            </div>
            <div className="space-y-4">
              <section className={cardClass} aria-labelledby="pipelines-setup">
                <h2 id="pipelines-setup" className="text-sm font-semibold">
                  Setup
                </h2>
                <dl className="mt-2 space-y-2 text-sm">
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
                    <dd className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                      {setup.configFile === 'present' ? (
                        <span>
                          On {branchLabel}.{' '}
                          {canEdit && !fileDraft ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void openFile()}
                              className={linkButtonClass}
                            >
                              Edit file
                            </button>
                          ) : null}
                        </span>
                      ) : setup.configFile === 'absent' ? (
                        <span>
                          Not on {branchLabel} yet.{' '}
                          {canEdit && !fileDraft ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void openFile()}
                              className={linkButtonClass}
                            >
                              Start from a template
                            </button>
                          ) : null}{' '}
                          A chat in this project can write one fitted to the code. Runs start once
                          it is committed and Pipelines is on.
                        </span>
                      ) : (
                        <span className="text-gray-500">Could not be checked.</span>
                      )}
                    </dd>
                  </div>
                </dl>
                {fileDraft ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void commitFile();
                    }}
                    aria-label="Pipeline file"
                    className="mt-3 space-y-2"
                  >
                    {templates && templates.length > 0 ? (
                      <label className="block text-xs">
                        <span className="text-gray-500">Start from a template</span>
                        <select
                          value={fileDraft.templateId}
                          onChange={(event) => {
                            dispatch({ type: 'templatePicked', templateId: event.target.value });
                          }}
                          className={`mt-0.5 ${inputClass}`}
                        >
                          <option value="">{templateBlankOption(fileDraft)}</option>
                          {templates.map((template) => (
                            <option key={template.id} value={template.id}>
                              {templateOptionLabel(template)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <textarea
                      value={fileDraft.text}
                      onChange={(event) =>
                        dispatch({ type: 'fileChanged', field: 'text', value: event.target.value })
                      }
                      rows={textRows(fileDraft.text, 8, 28)}
                      spellCheck={false}
                      aria-label="bitbucket-pipelines.yml"
                      placeholder={
                        'image: node:22\n\npipelines:\n  default:\n    - step:\n        script:\n          - npm test'
                      }
                      className={`font-mono ${inputClass}`}
                    />
                    <label className="block text-xs">
                      <span className="text-gray-500">Commit message</span>
                      <input
                        value={fileDraft.message}
                        onChange={(event) =>
                          dispatch({
                            type: 'fileChanged',
                            field: 'message',
                            value: event.target.value,
                          })
                        }
                        maxLength={500}
                        className={`mt-0.5 ${inputClass}`}
                      />
                    </label>
                    <div className="flex items-center justify-end gap-2">
                      <p className="mr-auto text-xs text-gray-500">
                        Commit goes straight to {branchLabel}, with your Bitbucket access. The
                        picked template is a starting point; what is in the box is what lands.
                      </p>
                      <button
                        type="button"
                        onClick={() => dispatch({ type: 'fileCancelled' })}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!canCommit(state)}
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {busy ? 'Committing…' : 'Commit'}
                      </button>
                    </div>
                  </form>
                ) : null}
                {committed ? (
                  <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-400">
                    Committed bitbucket-pipelines.yml to {committed.ref}.{' '}
                    <ExternalLink href={committed.url} className="underline">
                      Open on Bitbucket
                    </ExternalLink>
                    {committedReminder(state)}
                  </p>
                ) : null}
              </section>

              <VariableGroup
                title="Repository variables"
                hint="Every pipeline run gets these."
                variables={setup.variables}
                error={setup.variablesError}
                scope={{}}
                canEdit={canSetVariables}
                needs={canEdit ? setup.access.variablesNeeds : null}
                busy={busy}
                open={draftFor(state, {})}
                last={outcomeFor(state, {})}
                dispatch={dispatch}
                onSave={saveVariables}
              />
              {setup.environments.map((environment) => (
                <VariableGroup
                  key={environment.uuid}
                  title={environment.name}
                  hint={environmentHint(environment)}
                  variables={environment.variables}
                  error={environment.error}
                  scope={{ environmentUuid: environment.uuid }}
                  canEdit={canSetVariables}
                  needs={null}
                  busy={busy}
                  open={draftFor(state, { environmentUuid: environment.uuid })}
                  last={outcomeFor(state, { environmentUuid: environment.uuid })}
                  dispatch={dispatch}
                  onSave={saveVariables}
                />
              ))}
              {setup.environmentsError ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Deployment environments could not be read: {setup.environmentsError}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RunsCard({
  runs,
  error,
  canRun,
  canStart,
  busy,
  draft,
  dispatch,
  defaultRef,
  onStart,
  started,
}: {
  runs: PipelineRun[];
  error: string | null;
  /** An editor, with Pipelines not known to be off. */
  canRun: boolean;
  /** Start run can be pressed. */
  canStart: boolean;
  busy: boolean;
  draft: RunDraft | null;
  dispatch: Dispatch<PipelinesAction>;
  /** What the form starts with: the project's branch. */
  defaultRef: string;
  onStart: () => Promise<void>;
  /** The run just started from here, if any. */
  started: PipelineRun | null;
}) {
  return (
    <section className={cardClass} aria-labelledby="pipelines-runs">
      <div className="flex items-center gap-2">
        <h2 id="pipelines-runs" className="text-sm font-semibold">
          Recent runs
        </h2>
        {canRun ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => dispatch({ type: 'runOpened', defaultRef })}
            className={`ml-auto ${linkButtonClass}`}
          >
            Run pipeline
          </button>
        ) : null}
      </div>
      <p className="text-xs text-gray-500">
        The newest first. Each opens on Bitbucket, where its steps and logs are.
      </p>
      {draft ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onStart();
          }}
          aria-label="Run pipeline"
          className="mt-3 space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-800"
        >
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <label className="block text-xs">
              <span className="text-gray-500">Branch or tag</span>
              <input
                value={draft.ref}
                onChange={(event) =>
                  dispatch({ type: 'runChanged', field: 'ref', value: event.target.value })
                }
                spellCheck={false}
                autoComplete="off"
                className={`mt-0.5 font-mono ${inputClass}`}
              />
            </label>
            <label className="block text-xs">
              <span className="text-gray-500">Type</span>
              <select
                value={draft.refType}
                onChange={(event) =>
                  dispatch({ type: 'runTypeChanged', value: event.target.value })
                }
                className={`mt-0.5 ${inputClass}`}
              >
                <option value="branch">Branch</option>
                <option value="tag">Tag</option>
              </select>
            </label>
            <label className="block text-xs">
              <span className="text-gray-500">Custom pipeline (optional)</span>
              <input
                value={draft.pattern}
                onChange={(event) =>
                  dispatch({ type: 'runChanged', field: 'pattern', value: event.target.value })
                }
                spellCheck={false}
                autoComplete="off"
                placeholder="the ref’s default"
                className={`mt-0.5 font-mono ${inputClass}`}
              />
            </label>
          </div>
          <div className="flex items-center justify-end gap-2">
            <p className="mr-auto text-xs text-gray-500">
              A run spends build minutes and can deploy. A custom pipeline is one named under{' '}
              <span className="font-mono">custom:</span> in the YAML.
            </p>
            <button
              type="button"
              onClick={() => dispatch({ type: 'runCancelled' })}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canStart}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Start run'}
            </button>
          </div>
        </form>
      ) : null}
      {started ? (
        <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-400">
          Run #{started.buildNumber} started on {started.ref}.{' '}
          <ExternalLink href={started.url} className="underline">
            Open on Bitbucket
          </ExternalLink>
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{error}</p>
      ) : runs.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">No runs yet.</p>
      ) : (
        <>
          {/* A phone gets one card per run instead of a table too wide to read. */}
          <ul className="mt-2 divide-y divide-gray-200 sm:hidden dark:divide-gray-800">
            {runs.map((run) => (
              <li key={run.uuid} className="space-y-1 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <ExternalLink href={run.url} className="font-medium hover:underline">
                    #{run.buildNumber}
                  </ExternalLink>
                  <RunStatePill state={run.state} />
                  <span className="ml-auto text-xs whitespace-nowrap text-gray-500">
                    {run.durationSeconds === null ? '' : duration(run.durationSeconds)}
                  </span>
                </div>
                <div className="truncate font-mono text-xs" title={run.ref}>
                  {run.ref}
                </div>
                <div className="text-xs text-gray-500">
                  {run.startedBy ? `${run.startedBy} · ` : ''}
                  {run.createdOn ? <LocalTime at={run.createdOn} /> : '—'}
                </div>
              </li>
            ))}
          </ul>
          <table className="mt-2 hidden w-full text-sm sm:table">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Run
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  State
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Ref
                </th>
                <th scope="col" className="hidden py-1 pr-2 font-medium sm:table-cell">
                  Started by
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  When
                </th>
                <th scope="col" className="hidden py-1 font-medium sm:table-cell">
                  Took
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {runs.map((run) => (
                <tr key={run.uuid}>
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    <ExternalLink href={run.url} className="font-medium hover:underline">
                      #{run.buildNumber}
                    </ExternalLink>
                  </td>
                  <td className="py-1.5 pr-2">
                    <RunStatePill state={run.state} />
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-xs">
                    <span className="block max-w-[10rem] truncate" title={run.ref}>
                      {run.ref}
                    </span>
                  </td>
                  <td className="hidden max-w-[10rem] truncate py-1.5 pr-2 text-xs text-gray-500 sm:table-cell">
                    {run.startedBy || '—'}
                  </td>
                  <td className="py-1.5 pr-2 text-xs whitespace-nowrap text-gray-500">
                    {run.createdOn ? <LocalTime at={run.createdOn} /> : '—'}
                  </td>
                  <td className="hidden py-1.5 text-xs whitespace-nowrap text-gray-500 sm:table-cell">
                    {run.durationSeconds === null ? '—' : duration(run.durationSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** A run's state as a pill: green when it passed, red when it failed, blue while it runs. */
export function RunStatePill({ state }: { state: string }) {
  const { tone, label } = runStatePill(state);
  return <Pill tone={tone}>{label}</Pill>;
}

/** On, Off, or nothing when the switch could not be read. */
export function StatusPill({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) return null;
  return enabled ? <Pill tone="green">On</Pill> : <Pill tone="gray">Off</Pill>;
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
  open,
  last,
  dispatch,
  onSave,
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
  /** The open box, when it is this set's. */
  open: Draft | null;
  /** The last save's outcome, when it was this set's. */
  last: Outcome | null;
  dispatch: Dispatch<PipelinesAction>;
  onSave: (current: PipelineVariable[]) => Promise<void>;
}) {
  const groupId = `pipeline-variables-${scope.environmentUuid ?? 'repository'}`;
  const lines = last ? outcomeLines(last) : null;
  return (
    <section className={cardClass} aria-labelledby={groupId}>
      <div className="flex items-center gap-2">
        <h2 id={groupId} className="text-sm font-semibold">
          {title}
        </h2>
        {canEdit && !open ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => dispatch({ type: 'variablesOpened', scope, variables })}
            className={`ml-auto ${linkButtonClass}`}
          >
            {variablesButtonLabel(variables)}
          </button>
        ) : null}
      </div>
      <p className="text-xs text-gray-500">{hint}</p>
      {error ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{error}</p>
      ) : open ? null : variables.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">No variables.</p>
      ) : (
        <ul className="mt-1 divide-y divide-gray-200 text-sm dark:divide-gray-800">
          {variables.map((variable) => {
            const shown = variableShown(variable);
            return (
              <li key={variable.uuid} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono">{variable.key}</span>
                  {'secured' in shown ? (
                    <span className="ml-2">
                      <Pill tone="gray">Secured</Pill>
                    </span>
                  ) : (
                    <span className="ml-2 font-mono text-xs text-gray-500">{shown.value}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {needs ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{needs}</p> : null}
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(variables);
          }}
          aria-label={`Edit ${title}`}
          className="mt-2 space-y-2"
        >
          <textarea
            value={open.text}
            onChange={(event) => dispatch({ type: 'variablesChanged', text: event.target.value })}
            rows={textRows(open.text, 4, 16)}
            spellCheck={false}
            aria-label={`${title} as text`}
            placeholder={'API_BASE_URL=https://api.example.test\nsecret DEPLOY_TOKEN=…'}
            className={`font-mono ${inputClass}`}
          />
          <p className="text-xs text-gray-500">
            One <span className="font-mono">KEY=value</span> a line, as a .env; start a line with{' '}
            <span className="font-mono">secret</span> to secure it — Bitbucket masks it in logs and
            never shows the value again, so a secured one shows here as{' '}
            <span className="font-mono">secret KEY=</span> and keeps its value while that line
            stays. A line taken out removes the variable.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => dispatch({ type: 'variablesCancelled' })}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : null}
      {lines ? (
        <div className="mt-2 space-y-1 text-xs">
          {lines.status ? (
            <p
              role="status"
              className={
                lines.status === 'Nothing changed.'
                  ? 'text-gray-500'
                  : 'text-green-700 dark:text-green-400'
              }
            >
              {lines.status}
            </p>
          ) : null}
          {lines.notApplied ? (
            <p role="alert" className="text-red-600 dark:text-red-400">
              {lines.notApplied}
            </p>
          ) : null}
          {lines.notRead ? (
            <p className="text-amber-700 dark:text-amber-400">{lines.notRead}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
