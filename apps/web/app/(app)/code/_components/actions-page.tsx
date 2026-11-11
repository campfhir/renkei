'use client';

/**
 * A GitHub code project's Actions page — the Bitbucket Pipelines page
 * (pipelines-page.tsx) for GitHub, drawn from the same parts
 * (pipeline-parts.tsx): the recent runs; the setup — whether GitHub runs
 * Actions for the repository at all, and the workflow files on the
 * branch, each editable, with a way to start a new one from the org's
 * pipeline templates — and the variables runs get, the repository's and
 * each deployment environment's, each set edited as one text box,
 * `KEY=value` a line, applied as a difference. Read on open and after
 * every change, with the person's own GitHub grant. Its summary card on
 * the project page is actions-summary.tsx.
 *
 * Secrets are the one thing that differs: GitHub takes them only sealed
 * to a repository key, so they are listed by name, read-only, shown as
 * secured, with a link to where a person adds one. A chat reads and sets
 * the plain variables itself (lib/code/pipeline-tools.ts) and can write a
 * workflow file; the switch and secrets are the person's.
 *
 * The same body opens as a modal from a code chat's overflow menu
 * (`presentation="modal"`, via pipelines-modal.tsx). What the page
 * decides — the requests, when Commit can be pressed, the words after a
 * change — is actions-page.model.ts.
 */

import { useCallback, useEffect, useReducer } from 'react';
import BackLink from '@/components/back-link';
import ExternalLink from '@/components/external-link';
import LocalTime from '@/components/local-time';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { VariablesApplied } from '@/lib/code/bitbucket-pipelines';
import { actionsSecretsUrl, actionsUrl } from '@/lib/code/github-actions-urls';
import type { HostPipelineRun } from '@/lib/code/repo-host';
import type { PipelineTemplate } from '@/lib/code/pipeline-templates';
import Pill, { type PillTone } from './pill';
import VariableGroup, {
  StatusPill,
  cardClass,
  inputClass,
  linkButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
  type VariableWords,
} from './pipeline-parts';
import {
  actionsReducer,
  branchLabel as labelOfBranch,
  canCommitWorkflow,
  canConfigure,
  committedReminder,
  environmentHint,
  initialActions,
  secretsNote,
  workflowNameProblem,
  workflowRequest,
  workflowsLine,
  type ActionsAction,
  type ActionsPageSetup,
} from './actions-page.model';
import {
  draftFor,
  outcomeFor,
  outcomeOf,
  removalQuestion,
  templateBlankOption,
  templateOptionLabel,
  textRows,
  variablesGoing,
  variablesRequest,
  type Committed,
  type Outcome,
} from './pipelines-page.model';

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

const GITHUB_WORDS: VariableWords = {
  placeholder: 'API_BASE_URL=https://api.example.test\nREGION=eu-west-1',
  help: (
    <>
      One <span className="font-mono">KEY=value</span> a line, as a .env. These are Actions
      variables: plain values a workflow reads as <span className="font-mono">vars.NAME</span>.
      Anything secret is a secret, added on GitHub. A line taken out removes the variable.
    </>
  ),
};

export default function ActionsPage({
  projectId,
  projectName,
  repoFullName,
  branch,
  canEdit,
  presentation = 'page',
}: {
  projectId: string;
  projectName: string;
  repoFullName: string;
  /** The project's branch; empty for the repository's default. */
  branch: string;
  canEdit: boolean;
  /** A page of its own, or the body of a modal (no back link or page header). */
  presentation?: 'page' | 'modal';
}) {
  const url = `/api/code/projects/${projectId}/actions`;
  const [state, dispatch] = useReducer(actionsReducer, initialActions);
  const { setup, loadError, error, busy, draft, fileDraft, templates, committed } = state;

  const reload = useCallback(async () => {
    const result = await getJson<ActionsPageSetup>(url);
    if (result.data) dispatch({ type: 'loaded', setup: result.data });
    else
      dispatch({
        type: 'loadFailed',
        error: result.error ?? 'The Actions setup could not be read.',
      });
  }, [url]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Send a change; on success read the setup again before saying it is done. */
  const act = async (
    what: 'flip' | 'variables' | 'file',
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

  const saveVariables = async (current: ActionsPageSetup['variables']) => {
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

  /** Open the editor: a workflow as it is on the branch, or an empty one for a template to fill. */
  const openFile = async (name: string | null) => {
    dispatch({ type: 'fileOpening' });
    const [file, catalog] = await Promise.all([
      name
        ? getJson<{ text: string | null }>(`${url}/workflow-file?name=${encodeURIComponent(name)}`)
        : Promise.resolve({ data: { text: null }, error: null }),
      templates
        ? Promise.resolve({ data: { templates }, error: null })
        : getJson<{ templates: PipelineTemplate[] }>(
            `/api/code/pipeline-templates?provider=github`
          ),
    ]);
    if (file.error) {
      dispatch({ type: 'fileOpenFailed', error: file.error });
      return;
    }
    dispatch({
      type: 'fileOpened',
      name,
      text: file.data?.text ?? null,
      templates: catalog.data?.templates ?? [],
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
          `${url}/workflow-file`,
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
  const secretsUrl = actionsSecretsUrl(repoFullName);
  const branchLabel = labelOfBranch(branch);
  const canSet = canConfigure(state, canEdit);
  const modal = presentation === 'modal';

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

  const secretsFor = (names: ActionsPageSetup['secrets']) => ({
    secrets: names,
    secretsNote: (
      <>
        {secretsNote(names.length)}{' '}
        {secretsUrl ? (
          <ExternalLink href={secretsUrl} className="underline">
            Open secrets on GitHub
          </ExternalLink>
        ) : null}
      </>
    ),
  });

  return (
    <div className={modal ? '' : 'min-h-0 flex-1 overflow-y-auto'}>
      {modal ? (
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <p className="min-w-0 flex-1 truncate text-xs text-gray-500">
            <span className="font-mono">{repoFullName}</span>
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
      ) : (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
          <BackLink href={`/code/${projectId}`} label={projectName} />
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-sm font-semibold">
              <span className="truncate">Actions</span>
              {setup ? <StatusPill enabled={setup.enabled} /> : null}
            </h1>
            <p className="truncate text-xs text-gray-500">
              {projectName} · <span className="font-mono">{repoFullName}</span>
            </p>
          </div>
          {refreshButton}
          {hostLink}
        </header>
      )}

      <div className={`mx-auto space-y-4 p-4 ${modal ? 'max-w-none' : 'max-w-6xl'}`}>
        <p className="text-xs text-gray-500">
          How GitHub builds and deploys this repository. A chat in the project can write workflow
          files, run or cancel workflows, and read and set the plain variables; the switch and
          secrets are set here and on GitHub, by you, and a chat never sees a secret.
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
            className={`grid grid-cols-[minmax(0,1fr)] gap-4 lg:items-start ${modal ? 'xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'}`}
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
                      {canEdit && !fileDraft ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void openFile(null)}
                          className={linkButtonClass}
                        >
                          {setup.workflows && setup.workflows.length > 0
                            ? 'New workflow'
                            : 'Start from a template'}
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
                    {templates && templates.length > 0 ? (
                      <label className="block text-xs">
                        <span className="text-gray-500">Start from a template</span>
                        <select
                          value={fileDraft.templateId}
                          onChange={(event) =>
                            dispatch({ type: 'templatePicked', templateId: event.target.value })
                          }
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
                        Commit goes straight to {branchLabel}, with your GitHub access. The picked
                        template is a starting point; what is in the box is what lands.
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

              <VariableGroup
                title="Repository variables"
                hint="Every workflow run gets these."
                variables={setup.variables}
                {...secretsFor(setup.secrets)}
                error={setup.variablesError}
                scopeId="repository"
                canEdit={canSet}
                needs={canEdit ? setup.access.configureNeeds : null}
                busy={busy}
                open={draftFor(state, {})}
                last={outcomeFor(state, {})}
                words={GITHUB_WORDS}
                onOpen={() =>
                  dispatch({ type: 'variablesOpened', scope: {}, variables: setup.variables })
                }
                onChange={(text) => dispatch({ type: 'variablesChanged', text })}
                onCancel={() => dispatch({ type: 'variablesCancelled' })}
                onSave={() => void saveVariables(setup.variables)}
              />
              {setup.environments.map((environment) => (
                <VariableGroup
                  key={environment.uuid}
                  title={environment.name}
                  hint={environmentHint()}
                  variables={environment.variables}
                  {...secretsFor(environment.secrets)}
                  error={environment.error}
                  scopeId={environment.uuid}
                  canEdit={canSet}
                  needs={null}
                  busy={busy}
                  open={draftFor(state, { environmentUuid: environment.uuid })}
                  last={outcomeFor(state, { environmentUuid: environment.uuid })}
                  words={GITHUB_WORDS}
                  onOpen={() =>
                    dispatch({
                      type: 'variablesOpened',
                      scope: { environmentUuid: environment.uuid },
                      variables: environment.variables,
                    })
                  }
                  onChange={(text) => dispatch({ type: 'variablesChanged', text })}
                  onCancel={() => dispatch({ type: 'variablesCancelled' })}
                  onSave={() => void saveVariables(environment.variables)}
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
