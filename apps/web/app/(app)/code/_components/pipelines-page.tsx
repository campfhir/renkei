'use client';

/**
 * A branch's runs on Bitbucket Pipelines: the "Runs" tab of a branch on a
 * code project's Environments page (environments-page.tsx picks the
 * environment and the branch). The branch's recent runs, and the setup —
 * whether Bitbucket runs pipelines for the repository at all, and whether
 * a `bitbucket-pipelines.yml` is on the branch, with an editor that
 * writes one and commits it, or edits the one there (the branch's
 * Pipeline tab builds one from blocks). Read on open and after every
 * change, with the person's own Bitbucket grant. Its GitHub counterpart,
 * drawn from the same parts (pipeline-parts.tsx), is actions-page.tsx.
 *
 * The variables the runs get, and the secured ones, are the Variables
 * tab's (variables-editor.tsx), not this one's.
 *
 * A run can be started from here too, on the scope the chat's trigger
 * tool stands on. A chat can also write the YAML (a file, committed like
 * any other) and stop a run, but it cannot flip the switch.
 *
 * The layout is one column of cards on a phone (where the runs are
 * cards too, not a table) and two on a wide screen, runs beside setup.
 * What the page decides — the requests, when they can be sent, the words
 * after each change — is pipelines-page.model.ts.
 */

import { useCallback, useEffect, useReducer, type Dispatch } from 'react';
import ExternalLink from '@/components/external-link';
import LocalTime from '@/components/local-time';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { PipelineRun } from '@/lib/code/bitbucket-pipelines';
import { RunStatePill, StatusPill, cardClass, inputClass, linkButtonClass } from './pipeline-parts';
import {
  branchLabel as labelOfBranch,
  canCommit,
  canRun,
  canStartRun,
  committedReminder,
  duration,
  fileRequest,
  initialPipelines,
  pipelinesReducer,
  pipelinesUrl as urlOfPipelines,
  runRequest,
  textRows,
  type Committed,
  type PipelinesAction,
  type RunDraft,
  type Setup,
} from './pipelines-page.model';

export default function PipelinesPage({
  projectId,
  repoFullName,
  branch,
  canEdit,
}: {
  projectId: string;
  repoFullName: string;
  /** The branch whose runs and pipeline file these are. */
  branch: string;
  canEdit: boolean;
}) {
  const url = `/api/code/projects/${projectId}/pipelines`;
  const [state, dispatch] = useReducer(pipelinesReducer, initialPipelines);
  const onBranch = `?branch=${encodeURIComponent(branch)}`;
  const { setup, loadError, error, busy, runDraft, started, fileDraft, committed } = state;

  const reload = useCallback(async () => {
    const result = await getJson<Setup>(`${url}${onBranch}`);
    if (result.data) dispatch({ type: 'loaded', setup: result.data });
    else
      dispatch({ type: 'loadFailed', error: result.error ?? 'The pipelines could not be read.' });
  }, [url, onBranch]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Send a change; on success read the setup again before saying it is done. */
  const act = async (
    what: 'flip' | 'run' | 'file',
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

  /** Open the file editor: the file as it is on the branch, or an empty one to write. */
  const openFile = async () => {
    dispatch({ type: 'fileOpening' });
    const file = await getJson<{ ref: string; text: string | null }>(
      `${url}/config-file${onBranch}`
    );
    if (file.error) {
      dispatch({ type: 'fileOpenFailed', error: file.error });
      return;
    }
    dispatch({
      type: 'fileOpened',
      text: file.data?.text ?? null,
    });
  };

  const commitFile = async () => {
    if (!fileDraft) return;
    let result: Committed | null = null;
    await act(
      'file',
      async () => {
        const response = await sendJsonFull<Committed>(
          `${url}/config-file${onBranch}`,
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
  const refreshButton = (
    <button
      type="button"
      disabled={busy || setup === null}
      onClick={() => void reload()}
      className="rounded-md border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
    >
      Refresh
    </button>
  );
  const hostLink = pipelinesUrl ? (
    <ExternalLink
      href={pipelinesUrl}
      className="text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
    >
      Open on Bitbucket
    </ExternalLink>
  ) : null;

  return (
    <div>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-gray-500">
          Bitbucket Pipelines
          {setup ? (
            <>
              {' '}
              <StatusPill enabled={setup.enabled} />
            </>
          ) : null}
        </p>
        {refreshButton}
        {hostLink}
      </div>

      <div className="mt-3 space-y-4">
        <p className="text-xs text-gray-500">
          How Bitbucket runs <span className="font-mono">{branch}</span>. A chat in the project can
          write the pipeline file and start or stop runs; the switch is set here, by you. The
          variables and secured values its runs get are on the Variables tab.
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
            className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:items-start xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
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
                defaultRef={branch}
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
                          Not on {branchLabel} yet. Build it from blocks on this branch’s Pipeline
                          tab
                          {canEdit && !fileDraft ? (
                            <>
                              {', or '}
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void openFile()}
                                className={linkButtonClass}
                              >
                                write one by hand
                              </button>
                            </>
                          ) : null}
                          . A chat in this project can write one fitted to the code too. Runs start
                          once it is committed and Pipelines is on.
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
                        Commit goes straight to {branchLabel}, with your Bitbucket access: what is
                        in the box is what lands.
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

export { RunStatePill, StatusPill } from './pipeline-parts';
