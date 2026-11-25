'use client';

/**
 * A code project's Environments (/code/[projectId]/environments): where
 * its pipelines, their runs, their variables and what they deployed live.
 *
 * A pipeline file lives on a branch, in version control, so the page is
 * laid out the way the repository is: pick an environment — production,
 * and whatever else the project names — see the branches assigned to it,
 * pick one, and that branch's pipeline (built from blocks, with the
 * assistant), its runs and its variables are below. Production deploys
 * from one branch; any other environment holds as many as it likes.
 * Editors change the list; viewers read it.
 *
 * What the page decides — what is picked, what each change sends, the
 * questions asked first — is environments-page.model.ts.
 */

import { useCallback, useEffect, useReducer, useState } from 'react';
import BackLink from '@/components/back-link';
import ExternalLink from '@/components/external-link';
import { Icon, ICONS } from '@/components/icons';
import LocalTime from '@/components/local-time';
import { LoadingLine } from '@/components/skeleton';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import ActionsPage from './actions-page';
import { DOT, PILL, card } from './deploy-tones';
import DeploymentInstructions from './deployment-instructions';
import HealthCheckins from './health-checkins';
import {
  TABS,
  assignChoices,
  assignLabel,
  assignQuestion,
  assignRequest,
  branchRows,
  canRemove,
  canSubmitForm,
  currentBranch,
  currentEnvironment,
  deploymentCard,
  environmentTabs,
  formProblem,
  formRequest,
  historyRows,
  initialPage,
  pageReducer,
  removeQuestion,
  removeRequest,
  selectionQuery,
  unassignQuestion,
  unassignRequest,
  type EnvironmentsData,
  type SaveRequest,
  type Selection,
} from './environments-page.model';
import PipelineBuilder from './pipeline-builder';
import {
  inputClass,
  linkButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './pipeline-parts';
import PipelinesPage from './pipelines-page';
import VariablesEditor, { type VariableAsk } from './variables-editor';

const HOST = { bitbucket: 'Bitbucket', github: 'GitHub' } as const;

export default function EnvironmentsPage({
  projectId,
  projectName,
  repoFullName,
  host,
  canEdit,
  operator,
  initial,
  ask = null,
}: {
  projectId: string;
  projectName: string;
  repoFullName: string;
  host: 'bitbucket' | 'github';
  canEdit: boolean;
  /** Offers making one of the project's blocks a building block for every project. */
  operator: boolean;
  /** What the address picked. */
  initial: Selection;
  /** A variable the page was sent to set (the builder's "Set it"). */
  ask?: VariableAsk | null;
}) {
  const url = `/api/code/projects/${projectId}/environments`;
  const [state, dispatch] = useReducer(pageReducer, initial, initialPage);
  // The clock, read once the page is in the browser: "2h ago" is drawn from it.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  const load = useCallback(async () => {
    const result = await getJson<EnvironmentsData>(url);
    if (result.data) dispatch({ type: 'loaded', data: result.data });
    else
      dispatch({
        type: 'loadFailed',
        error: result.error ?? 'The environments could not be read.',
      });
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);

  // The address follows what is picked, so a reload or a shared link lands on it.
  const query = state.data ? selectionQuery(state) : null;
  useEffect(() => {
    if (query === null) return;
    const next = `${window.location.pathname}${query}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', next);
    }
  }, [query]);

  /** Save a new list; on success show what the server now has. */
  const save = async (request: SaveRequest | null, select?: Partial<Selection>) => {
    if (!request) return;
    dispatch({ type: 'sent' });
    const result = await sendJsonFull<EnvironmentsData & { problems?: string[] }>(
      url,
      'PUT',
      request
    );
    if (result.error || !result.data) {
      dispatch({
        type: 'failed',
        error: result.error ?? 'The environments could not be saved.',
        problems: result.data?.problems ?? [],
      });
      return;
    }
    dispatch({ type: 'saved', data: result.data, ...(select ? { select } : {}) });
  };

  const environment = currentEnvironment(state);
  const branch = currentBranch(state);
  const tabs = environmentTabs(state);
  const rows = branchRows(state);
  const choices = assignChoices(state);
  const deployed = now === null ? null : deploymentCard(state, now);
  const history = historyRows(state);
  const editable = canEdit && state.data?.canEdit !== false;
  const problem = formProblem(state);

  const assign = () => {
    if (!state.picked) return;
    const question = assignQuestion(state, state.picked);
    if (question && !window.confirm(question)) return;
    void save(assignRequest(state, state.picked), { branch: state.picked });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <BackLink href={`/code/${projectId}`} label={projectName} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">Environments</h1>
          <p className="truncate text-xs text-gray-500">
            {projectName} · {HOST[host]} · <span className="font-mono">{repoFullName}</span>
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-4 p-4">
        <p className="text-xs text-gray-500">
          A pipeline lives on a branch. Assign branches to the environments they deploy, then pick
          one to see its pipeline, runs and variables. Renkei never deploys: a merge to the branch
          starts {HOST[host]}’s pipeline, which does.
        </p>
        {state.loadError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.loadError}
          </p>
        ) : !state.data ? (
          <LoadingLine label="Reading the environments…" />
        ) : (
          <>
            <DeploymentInstructions
              projectId={projectId}
              projectName={projectName}
              repoFullName={repoFullName}
              host={host}
              environments={state.data.environments.map((e) => e.name)}
            />
            <nav aria-label="Environments" className="flex flex-wrap items-stretch gap-2">
              {tabs.map((tab) => (
                <button
                  key={tab.name}
                  type="button"
                  aria-current={tab.current ? 'true' : undefined}
                  onClick={() => dispatch({ type: 'environmentPicked', name: tab.name })}
                  className={`min-w-[9rem] rounded-lg border px-3 py-2 text-left ${
                    tab.current
                      ? 'border-blue-600 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40'
                      : 'border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[tab.tone]}`} />
                    <span className="text-sm font-semibold break-all">{tab.name}</span>
                    {tab.production ? (
                      <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[11px] font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
                        Production
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 pl-4 text-xs text-gray-500">
                    <Icon path={ICONS.gitBranch} className="h-3 w-3" />
                    <span className="font-mono break-all">{tab.detail}</span>
                  </span>
                </button>
              ))}
              {editable ? (
                <button
                  type="button"
                  disabled={state.busy}
                  onClick={() => dispatch({ type: 'formOpened', kind: 'add' })}
                  className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900"
                >
                  + Add an environment
                </button>
              ) : null}
            </nav>

            {state.form ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const request = formRequest(state);
                  if (request) {
                    void save(
                      { environments: request.environments },
                      {
                        environment: request.select,
                        ...(state.form?.kind === 'add' ? { branch: null } : {}),
                      }
                    );
                  }
                }}
                aria-label={
                  state.form.kind === 'add' ? 'Add an environment' : 'Rename the environment'
                }
                className={`${card} space-y-2`}
              >
                <label className="block text-sm font-semibold" htmlFor="environment-name">
                  {state.form.kind === 'add'
                    ? 'A new environment’s name'
                    : `Rename ${environment?.name ?? 'the environment'}`}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="environment-name"
                    value={state.form.name}
                    onChange={(event) =>
                      dispatch({ type: 'formChanged', name: event.target.value })
                    }
                    autoFocus
                    spellCheck={false}
                    autoCapitalize="off"
                    placeholder="dev, staging, test…"
                    className={`max-w-xs font-mono ${inputClass}`}
                  />
                  <button
                    type="submit"
                    disabled={!canSubmitForm(state)}
                    className={primaryButtonClass}
                  >
                    {state.busy ? 'Saving…' : state.form.kind === 'add' ? 'Add it' : 'Rename'}
                  </button>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'formClosed' })}
                    className={secondaryButtonClass}
                  >
                    Cancel
                  </button>
                </div>
                <p
                  className={`text-xs ${problem ? 'text-red-600 dark:text-red-400' : 'text-gray-500'}`}
                >
                  {problem ??
                    (state.form.kind === 'add'
                      ? `Name it as ${HOST[host]} does or will: a deploy job names its environment, and its variables hang from that name.`
                      : 'A pipeline file names the environment it deploys: after renaming, open each branch’s pull request again so its file carries the new name. Deployments reported under the old name stay under it.')}
                </p>
              </form>
            ) : null}

            {state.error ? (
              <div role="alert" className="text-sm text-red-600 dark:text-red-400">
                <p>{state.error}</p>
                {state.problems.length > 1 ? (
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {state.problems.slice(1).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {environment ? (
              <section className={card} aria-labelledby="environment-heading">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 id="environment-heading" className="text-base font-semibold break-all">
                    {environment.name}
                  </h2>
                  {deployed ? (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${PILL[deployed.tone]}`}
                    >
                      {deployed.state}
                    </span>
                  ) : null}
                  {editable ? (
                    <span className="ml-auto flex items-center gap-3">
                      <button
                        type="button"
                        disabled={state.busy}
                        onClick={() => dispatch({ type: 'formOpened', kind: 'rename' })}
                        className={linkButtonClass}
                      >
                        Rename
                      </button>
                      {canRemove(state) ? (
                        <button
                          type="button"
                          disabled={state.busy}
                          onClick={() => {
                            if (window.confirm(removeQuestion(state))) {
                              void save(removeRequest(state), { environment: null, branch: null });
                            }
                          }}
                          className="text-xs font-medium whitespace-nowrap text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                        >
                          Remove
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">
                  {environment.production
                    ? 'The production environment: it deploys from one branch. Assigning another replaces it.'
                    : 'Any number of branches can deploy this environment; a branch deploys only one.'}
                </p>
                {deployed ? (
                  <p className="mt-2 text-sm">
                    <span className={deployed.tone === 'none' ? 'text-gray-500' : 'font-mono'}>
                      {deployed.line}
                    </span>
                    {deployed.runUrl ? (
                      <>
                        {' '}
                        <ExternalLink
                          href={deployed.runUrl}
                          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                        >
                          the run
                        </ExternalLink>
                      </>
                    ) : null}
                    {deployed.note ? (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-800 dark:bg-red-950 dark:text-red-300">
                        {deployed.note}
                      </span>
                    ) : null}
                  </p>
                ) : null}

                <HealthCheckins
                  key={`health-${environment.name}`}
                  projectId={projectId}
                  environment={environment.name}
                  health={environment.health ?? null}
                  canEdit={editable}
                  now={now}
                  onChanged={() => void load()}
                />

                <h3 className="mt-4 text-xs font-semibold tracking-wide text-gray-500 uppercase">
                  Branches
                </h3>
                {rows.length === 0 ? (
                  <p className="mt-1 text-sm text-gray-500">
                    No branch is assigned yet. Assign one to build its pipeline.
                  </p>
                ) : (
                  <ul
                    aria-label={`Branches of ${environment.name}`}
                    className="mt-1 divide-y divide-gray-200 dark:divide-gray-800"
                  >
                    {rows.map((row) => (
                      <li
                        key={row.name}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
                      >
                        <button
                          type="button"
                          aria-current={row.current ? 'true' : undefined}
                          onClick={() => dispatch({ type: 'branchPicked', branch: row.name })}
                          className={`inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-sm ${
                            row.current
                              ? 'border-blue-600 bg-blue-50 font-semibold dark:border-blue-500 dark:bg-blue-950/40'
                              : 'border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900'
                          }`}
                        >
                          <Icon path={ICONS.gitBranch} className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-mono break-all">{row.name}</span>
                        </button>
                        {row.pullRequestUrl ? (
                          <ExternalLink
                            href={row.pullRequestUrl}
                            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                          >
                            the pull request
                          </ExternalLink>
                        ) : null}
                        {row.gone ? (
                          <span className="text-xs text-amber-700 dark:text-amber-400">
                            {row.gone}
                          </span>
                        ) : null}
                        {editable ? (
                          <button
                            type="button"
                            disabled={state.busy}
                            onClick={() => {
                              if (window.confirm(unassignQuestion(state, row.name))) {
                                void save(unassignRequest(state, row.name), { branch: null });
                              }
                            }}
                            aria-label={`Take ${row.name} off ${environment.name}`}
                            className={`ml-auto ${linkButtonClass}`}
                          >
                            Take off
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {editable ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor="assign-branch">
                      A branch of the repository
                    </label>
                    <select
                      id="assign-branch"
                      value={state.picked}
                      disabled={state.busy || choices.length === 0}
                      onChange={(event) =>
                        dispatch({ type: 'assignPicked', branch: event.target.value })
                      }
                      className={`max-w-xs font-mono ${inputClass}`}
                    >
                      <option value="">
                        {choices.length === 0
                          ? 'No other branch on the remote'
                          : 'A branch on the remote…'}
                      </option>
                      {choices.map((choice) => (
                        <option key={choice.branch} value={choice.branch}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={state.busy || !state.picked}
                      onClick={assign}
                      className={secondaryButtonClass}
                    >
                      {assignLabel(state)}
                    </button>
                    {state.data.branchesError ? (
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        The branches could not be listed: {state.data.branchesError}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            {environment && branch ? (
              <section
                aria-label={`${branch.name}, deploying ${environment.name}`}
                className="space-y-4"
              >
                <div
                  role="tablist"
                  aria-label={`${branch.name}`}
                  className="flex items-end gap-4 overflow-x-auto border-b border-gray-200 dark:border-gray-800"
                >
                  <span className="flex items-center gap-1.5 pb-2 text-sm text-gray-500">
                    <Icon path={ICONS.gitBranch} className="h-3.5 w-3.5" />
                    <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">
                      {branch.name}
                    </span>
                  </span>
                  {TABS.map((tab) => {
                    const current = state.selection.tab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={current}
                        onClick={() => dispatch({ type: 'tabPicked', tab: tab.id })}
                        className={`-mb-px border-b-2 px-1 pb-2 text-sm font-semibold whitespace-nowrap ${
                          current
                            ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                            : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
                {state.selection.tab === 'pipeline' ? (
                  <PipelineBuilder
                    key={`pipeline-${branch.name}`}
                    projectId={projectId}
                    host={host}
                    branch={branch.name}
                    operator={operator}
                  />
                ) : state.selection.tab === 'runs' ? (
                  host === 'github' ? (
                    <ActionsPage
                      key={`runs-${branch.name}`}
                      projectId={projectId}
                      repoFullName={repoFullName}
                      branch={branch.name}
                      canEdit={editable}
                    />
                  ) : (
                    <PipelinesPage
                      key={`runs-${branch.name}`}
                      projectId={projectId}
                      repoFullName={repoFullName}
                      branch={branch.name}
                      canEdit={editable}
                    />
                  )
                ) : (
                  <VariablesEditor
                    key={`variables-${environment.name}`}
                    projectId={projectId}
                    environment={environment.name}
                    ask={ask}
                  />
                )}
              </section>
            ) : null}

            {environment && history.length > 0 ? (
              <section className={card} aria-labelledby="history-heading">
                <h2 id="history-heading" className="text-sm font-semibold">
                  Deployments of {environment.name}
                </h2>
                <ul className="mt-1 divide-y divide-gray-200 text-sm dark:divide-gray-800">
                  {history.map((row) => (
                    <li key={row.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                      <span className="text-xs text-gray-500">
                        <LocalTime at={row.at} />
                      </span>
                      <span className="font-mono text-xs">{row.commit}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${PILL[row.tone]}`}
                      >
                        {row.result}
                      </span>
                      {row.runUrl ? (
                        <ExternalLink
                          href={row.runUrl}
                          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {row.run}
                        </ExternalLink>
                      ) : (
                        <span className="text-xs text-gray-500">{row.run}</span>
                      )}
                      <span className="text-xs text-gray-500">{row.by}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
