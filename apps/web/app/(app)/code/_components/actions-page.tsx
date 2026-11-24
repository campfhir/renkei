'use client';

/**
 * A branch's runs on GitHub Actions: the "Runs" tab of a branch on a code
 * project's Environments page (environments-page.tsx picks the
 * environment and the branch) — the Bitbucket one (pipelines-page.tsx)
 * for GitHub, drawn from the same parts (pipeline-parts.tsx): the
 * branch's recent runs, and the setup — whether GitHub runs Actions for
 * the repository at all, and the workflow files on the branch, each
 * editable, with a way to write a new one (the branch's Pipeline tab
 * builds one from blocks). Read on open and after every change, with the
 * person's own GitHub grant.
 *
 * The variables and secrets the runs get are the Variables tab's
 * (variables-editor.tsx), not this one's. A chat can write a workflow
 * file; the switch is the person's.
 *
 * What the page decides — the requests, when Commit can be pressed, the
 * words after a change — is actions-page.model.ts.
 */

import { useCallback, useEffect, useReducer } from 'react';
import ExternalLink from '@/components/external-link';
import LocalTime from '@/components/local-time';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { actionsUrl } from '@/lib/code/github-actions-urls';
import type { HostPipelineRun } from '@/lib/code/repo-host';
import Pill, { type PillTone } from '@/app/(app)/code/_components/pill';
import {
  StatusPill,
  cardClass,
  inputClass,
  linkButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './pipeline-parts';
import {
  actionsReducer,
  branchLabel as labelOfBranch,
  canCommitWorkflow,
  canConfigure,
  committedReminder,
  initialActions,
  workflowNameProblem,
  workflowRequest,
  workflowsLine,
  type ActionsAction,
  type ActionsPageSetup,
} from './actions-page.model';
import { textRows, type Committed } from './pipelines-page.model';

const STATE_TONE: Record<HostPipelineRun['state'], PillTone> = {
  success: 'green',
  failure: 'red',
  running: 'blue',
  pending: 'gray',
  other: 'gray',
};
const STATE_LABEL: Record<HostPipelineRun['state'], string> = {
  success: 'Success',
  failure: 'Failure',
  running: 'Running',
  pending: 'Pending',
  other: 'Unknown',
};

export default function ActionsPage({
  projectId,
  repoFullName,
  branch,
  canEdit,
}: {
  projectId: string;
  repoFullName: string;
  /** The branch whose runs and workflow files these are. */
  branch: string;
  canEdit: boolean;
}) {
  const url = `/api/code/projects/${projectId}/actions`;
  const [state, dispatch] = useReducer(actionsReducer, initialActions);
  const onBranch = `branch=${encodeURIComponent(branch)}`;
  const { setup, loadError, error, busy, fileDraft, committed } = state;

  const reload = useCallback(async () => {
    const result = await getJson<ActionsPageSetup>(`${url}?${onBranch}`);
    if (result.data) dispatch({ type: 'loaded', setup: result.data });
    else
      dispatch({
        type: 'loadFailed',
        error: result.error ?? 'The Actions setup could not be read.',
      });
  }, [url, onBranch]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Send a change; on success read the setup again before saying it is done. */
  const act = async (
    what: 'flip' | 'file',
    work: () => Promise<{ error: string | null }>,
    done: () => ActionsAction
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

  /** Open the editor: a workflow as it is on the branch, or an empty one to write. */
  const openFile = async (name: string | null) => {
    dispatch({ type: 'fileOpening' });
    const file = name
      ? await getJson<{ text: string | null }>(
          `${url}/workflow-file?name=${encodeURIComponent(name)}&${onBranch}`
        )
      : { data: { text: null }, error: null };
    if (file.error) {
      dispatch({ type: 'fileOpenFailed', error: file.error });
      return;
    }
    dispatch({
      type: 'fileOpened',
      name,
      text: file.data?.text ?? null,
    });
  };

  const commitFile = async () => {
    if (!fileDraft) return;
    const request = workflowRequest(fileDraft);
    let result: (Committed & { name: string }) | null = null;
    await act(
      'file',
      async () => {
        const response = await sendJsonFull<Committed & { name: string }>(
          `${url}/workflow-file?${onBranch}`,
          'PUT',
          request
        );
        result = response.data && !response.error ? { ...response.data, name: request.name } : null;
        return response;
      },
      () => ({ type: 'fileCommitted', committed: result })
    );
  };

  const hostUrl = actionsUrl(repoFullName);
  const branchLabel = labelOfBranch(branch);
  const canSet = canConfigure(state, canEdit);

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
  const hostLink = hostUrl ? (
    <ExternalLink
      href={hostUrl}
      className="text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
    >
      Open on GitHub
    </ExternalLink>
  ) : null;

  return (
    <div>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-gray-500">
          GitHub Actions
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
          How GitHub runs <span className="font-mono">{branch}</span>. A chat in the project can
          write workflow files and run or cancel workflows; the switch is set here, by you. The
          variables and secrets its runs get are on the Variables tab.
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
          <p className="text-sm text-gray-500">Reading from GitHub…</p>
        ) : null}
        {setup ? (
          <div
            aria-busy={busy}
            className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:items-start xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
          >
            <div className="space-y-4">
              <RunsCard runs={setup.runs} error={setup.runsError} />
            </div>
            <div className="space-y-4">
              <section className={cardClass} aria-labelledby="actions-setup">
                <h2 id="actions-setup" className="text-sm font-semibold">
                  Setup
                </h2>
                <dl className="mt-2 space-y-2 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <dt className="text-gray-500">Actions on GitHub</dt>
                    <dd className="flex min-w-0 flex-1 items-center gap-2">
                      {setup.enabled === null ? (
                        <span className="text-xs text-amber-700 dark:text-amber-400">
                          {setup.enabledError ?? 'Could not be read.'}
                        </span>
                      ) : (
                        <>
                          <span>{setup.enabled ? 'On' : 'Off'}</span>
                          {canSet ? (
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
                    <dt className="text-gray-500">Workflows</dt>
                    <dd className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                      {workflowsLine(setup, branchLabel)}{' '}
                      {setup.workflows && setup.workflows.length > 0 ? null : (
                        <>Build one from blocks on this branch’s Pipeline tab. </>
                      )}
                      {canEdit && !fileDraft ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void openFile(null)}
                          className={linkButtonClass}
                        >
                          {setup.workflows && setup.workflows.length > 0
                            ? 'New workflow'
                            : 'or write one by hand'}
                        </button>
                      ) : null}
                    </dd>
                  </div>
                </dl>
                {setup.workflows && setup.workflows.length > 0 ? (
                  <ul className="mt-2 divide-y divide-gray-200 text-sm dark:divide-gray-800">
                    {setup.workflows.map((file) => (
                      <li key={file.path} className="flex items-center gap-2 py-1.5">
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-xs"
                          title={file.path}
                        >
                          {file.name}
                        </span>
                        {canEdit && !fileDraft ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void openFile(file.name)}
                            className={linkButtonClass}
                            aria-label={`Edit ${file.name}`}
                          >
                            Edit file
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {fileDraft ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void commitFile();
                    }}
                    aria-label="Workflow file"
                    className="mt-3 space-y-2"
                  >
                    {fileDraft.isNew ? (
                      <label className="block text-xs">
                        <span className="text-gray-500">File name</span>
                        <input
                          value={fileDraft.name}
                          onChange={(event) =>
                            dispatch({
                              type: 'fileChanged',
                              field: 'name',
                              value: event.target.value,
                            })
                          }
                          spellCheck={false}
                          autoComplete="off"
                          placeholder="ci.yml"
                          className={`mt-0.5 font-mono ${inputClass}`}
                        />
                        {workflowNameProblem(fileDraft, setup.workflows ?? []) ? (
                          <span
                            role="alert"
                            className="mt-0.5 block text-amber-700 dark:text-amber-400"
                          >
                            {workflowNameProblem(fileDraft, setup.workflows ?? [])}
                          </span>
                        ) : null}
                      </label>
                    ) : null}
                    <textarea
                      value={fileDraft.text}
                      onChange={(event) =>
                        dispatch({ type: 'fileChanged', field: 'text', value: event.target.value })
                      }
                      rows={textRows(fileDraft.text, 8, 28)}
                      spellCheck={false}
                      aria-label={fileDraft.name || 'Workflow file'}
                      placeholder={
                        'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test'
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
                        Commit goes straight to {branchLabel}, with your GitHub access: what is in
                        the box is what lands.
                      </p>
                      <button
                        type="button"
                        onClick={() => dispatch({ type: 'fileCancelled' })}
                        className={secondaryButtonClass}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!canCommitWorkflow(state)}
                        className={primaryButtonClass}
                      >
                        {busy ? 'Committing…' : 'Commit'}
                      </button>
                    </div>
                  </form>
                ) : null}
                {committed ? (
                  <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-400">
                    Committed {committed.name} to {committed.ref}.{' '}
                    <ExternalLink href={committed.url} className="underline">
                      Open on GitHub
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

function RunsCard({ runs, error }: { runs: HostPipelineRun[]; error: string | null }) {
  return (
    <section className={cardClass} aria-labelledby="actions-runs">
      <h2 id="actions-runs" className="text-sm font-semibold">
        Recent runs
      </h2>
      <p className="text-xs text-gray-500">
        The newest first. Each opens on GitHub, where its jobs and logs are.
      </p>
      {error ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{error}</p>
      ) : runs.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">No runs yet.</p>
      ) : (
        <>
          {/* A phone gets one card per run instead of a table too wide to read. */}
          <ul className="mt-2 divide-y divide-gray-200 sm:hidden dark:divide-gray-800">
            {runs.map((run) => (
              <li key={run.id} className="space-y-1 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <ExternalLink href={run.url} className="font-medium hover:underline">
                    Run {run.id}
                  </ExternalLink>
                  <span className="ml-auto shrink-0">
                    <Pill tone={STATE_TONE[run.state]}>{STATE_LABEL[run.state]}</Pill>
                  </span>
                </div>
                <div className="truncate font-mono text-xs" title={run.ref}>
                  {run.ref}
                </div>
                <div className="text-xs text-gray-500">
                  {run.startedAt ? <LocalTime at={run.startedAt} /> : '—'}
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
                  Branch
                </th>
                <th scope="col" className="py-1 font-medium">
                  Started
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    <ExternalLink href={run.url} className="font-medium hover:underline">
                      Run {run.id}
                    </ExternalLink>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Pill tone={STATE_TONE[run.state]}>{STATE_LABEL[run.state]}</Pill>
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-xs">
                    <span className="block max-w-[10rem] truncate" title={run.ref}>
                      {run.ref}
                    </span>
                  </td>
                  <td className="py-1.5 text-xs whitespace-nowrap text-gray-500">
                    {run.startedAt ? <LocalTime at={run.startedAt} /> : '—'}
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
