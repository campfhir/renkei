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
 * from its own reader.
 */

import { useCallback, useEffect, useState } from 'react';
import BackLink from '@/components/back-link';
import ExternalLink from '@/components/external-link';
import LocalTime from '@/components/local-time';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type {
  PipelineRun,
  PipelineSetup,
  PipelineVariable,
  VariablesApplied,
} from '@/lib/code/bitbucket-pipelines';
import { renderVariableText } from '@/lib/code/pipeline-variables-text';
import type { PipelineTemplate } from '@/lib/code/pipeline-templates';
import Pill from './pill';

const cardClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';
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

/** Which set a box writes to: the repository's, or one environment's. */
type Scope = { environmentUuid?: string };

/** One set being edited as text. */
interface Draft extends Scope {
  text: string;
}

/** What the last save of a set did, shown under it until the next edit. */
interface Outcome extends Scope, VariablesApplied {
  problems: string[];
}

/** The pipeline file being written: its text, the commit message, and which template filled it. */
interface FileDraft {
  text: string;
  message: string;
  templateId: string;
}

/** The "Run pipeline" form: where, and which pipeline. */
interface RunDraft {
  ref: string;
  refType: 'branch' | 'tag';
  pattern: string;
}

export default function PipelinesPage({
  slug,
  tenantId,
  projectId,
  projectName,
  repoFullName,
  branch,
  canEdit,
}: {
  slug: string;
  tenantId: string;
  projectId: string;
  projectName: string;
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
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [runDraft, setRunDraft] = useState<RunDraft | null>(null);
  /** The run just started from here, named until the next change. */
  const [started, setStarted] = useState<PipelineRun | null>(null);
  const [fileDraft, setFileDraft] = useState<FileDraft | null>(null);
  const [templates, setTemplates] = useState<PipelineTemplate[] | null>(null);
  /** Where the file just committed from here went, until the next change. */
  const [committed, setCommitted] = useState<{ ref: string; url: string } | null>(null);

  const reload = useCallback(async () => {
    const result = await getJson<Setup>(url);
    if (result.data) {
      setSetup(result.data);
      setLoadError(null);
    } else setLoadError(result.error ?? 'The pipelines could not be read.');
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

  /**
   * Save one set from its text. Keys about to disappear are named first:
   * a secured value cannot be brought back once its line is gone.
   */
  const saveVariables = async (current: PipelineVariable[]) => {
    if (!draft) return;
    const keysInText = new Set(
      draft.text
        .split(/\r?\n/)
        .map(
          (line) =>
            /^\s*(?:secret|secured)?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/i.exec(
              line
            )?.[1]
        )
        .filter((key): key is string => Boolean(key))
    );
    const going = current.filter((variable) => !keysInText.has(variable.key));
    if (
      going.length > 0 &&
      !window.confirm(
        `Remove ${going.map((variable) => variable.key).join(', ')}? Pipeline runs will no longer see ${going.length === 1 ? 'it' : 'them'}.`
      )
    ) {
      return;
    }
    setOutcome(null);
    let result: Outcome | null = null;
    const saved = await act(async () => {
      const response = await sendJsonFull<VariablesApplied & { problems: string[] }>(
        `${url}/variables`,
        'PUT',
        {
          text: draft.text,
          ...(draft.environmentUuid ? { environmentUuid: draft.environmentUuid } : {}),
        }
      );
      if (response.data && !response.error) {
        result = {
          ...response.data,
          ...(draft.environmentUuid ? { environmentUuid: draft.environmentUuid } : {}),
        };
      }
      return response;
    });
    if (saved) {
      setDraft(null);
      setOutcome(result);
    }
  };

  /** Open the file editor: the file as it is on the branch, or empty for a template to fill. */
  const openFile = async () => {
    setError(null);
    setCommitted(null);
    setBusy(true);
    const [file, catalog] = await Promise.all([
      getJson<{ ref: string; text: string | null }>(`${url}/config-file`),
      templates
        ? Promise.resolve({ data: { templates }, error: null })
        : getJson<{ templates: PipelineTemplate[] }>(
            `/api/tenant/${tenantId}/code/pipeline-templates?provider=atlassian-bitbucket`
          ),
    ]);
    setBusy(false);
    if (file.error) {
      setError(file.error);
      return;
    }
    setTemplates(catalog.data?.templates ?? []);
    const existing = file.data?.text ?? null;
    setFileDraft({
      text: existing ?? '',
      message: existing === null ? 'Add bitbucket-pipelines.yml' : 'Update bitbucket-pipelines.yml',
      templateId: '',
    });
  };

  const commitFile = async () => {
    if (!fileDraft) return;
    let result: { ref: string; url: string } | null = null;
    const ok = await act(async () => {
      const response = await sendJsonFull<{ ref: string; url: string }>(
        `${url}/config-file`,
        'PUT',
        { text: fileDraft.text, message: fileDraft.message.trim() }
      );
      result = response.data && !response.error ? response.data : null;
      return response;
    });
    if (ok) {
      setFileDraft(null);
      setCommitted(result);
    }
  };

  const startRun = async () => {
    if (!runDraft) return;
    setStarted(null);
    let run: PipelineRun | null = null;
    const ok = await act(async () => {
      const result = await sendJsonFull<{ run: PipelineRun }>(`${url}/runs`, 'POST', {
        ref: runDraft.ref.trim(),
        refType: runDraft.refType,
        pattern: runDraft.pattern.trim(),
      });
      run = result.data?.run ?? null;
      return result;
    });
    if (ok) {
      setRunDraft(null);
      setStarted(run);
    }
  };

  const [workspace, repoSlug] = repoFullName.split('/');
  const pipelinesUrl =
    workspace && repoSlug
      ? `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pipelines`
      : null;
  const branchLabel = branch || 'the default branch';
  const canSetVariables = canEdit && setup?.access.variablesNeeds === null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <BackLink href={`/${slug}/code/${projectId}`} label={projectName} />
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
                canRun={canEdit && setup.enabled !== false}
                busy={busy}
                draft={runDraft}
                setDraft={setRunDraft}
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
                            const next = event.target.value;
                            const template = templates.find((entry) => entry.id === next);
                            setFileDraft({
                              ...fileDraft,
                              templateId: next,
                              ...(template ? { text: template.body } : {}),
                            });
                          }}
                          className={`mt-0.5 ${inputClass}`}
                        >
                          <option value="">
                            {fileDraft.text ? 'Keep what is here' : 'Pick a template…'}
                          </option>
                          {templates.map((template) => (
                            <option key={template.id} value={template.id}>
                              {template.name}
                              {template.description ? ` — ${template.description}` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <textarea
                      value={fileDraft.text}
                      onChange={(event) => setFileDraft({ ...fileDraft, text: event.target.value })}
                      rows={Math.max(8, Math.min(28, fileDraft.text.split('\n').length + 1))}
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
                          setFileDraft({ ...fileDraft, message: event.target.value })
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
                        onClick={() => setFileDraft(null)}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={busy || !fileDraft.text.trim()}
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
                    {setup.enabled === false ? ' Turn Pipelines on above to run it.' : ''}
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
                draft={draft}
                setDraft={setDraft}
                outcome={outcome}
                onSave={saveVariables}
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
                  outcome={outcome}
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
  busy,
  draft,
  setDraft,
  defaultRef,
  onStart,
  started,
}: {
  runs: PipelineRun[];
  error: string | null;
  /** An editor, with Pipelines not known to be off. */
  canRun: boolean;
  busy: boolean;
  draft: RunDraft | null;
  setDraft: (draft: RunDraft | null) => void;
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
            onClick={() => setDraft({ ref: defaultRef, refType: 'branch', pattern: '' })}
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
                onChange={(event) => setDraft({ ...draft, ref: event.target.value })}
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
                  setDraft({ ...draft, refType: event.target.value === 'tag' ? 'tag' : 'branch' })
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
                onChange={(event) => setDraft({ ...draft, pattern: event.target.value })}
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
              onClick={() => setDraft(null)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !draft.ref.trim()}
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

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A run's state as a pill: green when it passed, red when it failed, blue while it runs. */
export function RunStatePill({ state }: { state: string }) {
  const upper = state.toUpperCase();
  const tone =
    upper === 'SUCCESSFUL' || upper === 'PASSED'
      ? 'green'
      : upper === 'FAILED' || upper === 'ERROR'
        ? 'red'
        : upper === 'IN_PROGRESS' || upper === 'RUNNING' || upper === 'PENDING'
          ? 'blue'
          : 'gray';
  const label = state
    ? state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, ' ')
    : 'Unknown';
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
  draft,
  setDraft,
  outcome,
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
  draft: Draft | null;
  setDraft: (draft: Draft | null) => void;
  outcome: Outcome | null;
  onSave: (current: PipelineVariable[]) => Promise<void>;
}) {
  const here = <T extends Scope>(candidate: T | null): candidate is T =>
    candidate !== null && (candidate.environmentUuid ?? '') === (scope.environmentUuid ?? '');
  const open = here(draft) ? draft : null;
  const last = here(outcome) ? outcome : null;
  const groupId = `pipeline-variables-${scope.environmentUuid ?? 'repository'}`;
  const summary = last
    ? [
        last.added.length ? `added ${last.added.join(', ')}` : '',
        last.changed.length ? `changed ${last.changed.join(', ')}` : '',
        last.removed.length ? `removed ${last.removed.join(', ')}` : '',
      ].filter(Boolean)
    : [];
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
            onClick={() => setDraft({ ...scope, text: renderVariableText(variables) })}
            className={`ml-auto ${linkButtonClass}`}
          >
            {variables.length ? 'Edit variables' : 'Add variables'}
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
            </li>
          ))}
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
            onChange={(event) => setDraft({ ...open, text: event.target.value })}
            rows={Math.max(4, Math.min(16, open.text.split('\n').length + 1))}
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
              onClick={() => setDraft(null)}
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
      {last ? (
        <div className="mt-2 space-y-1 text-xs">
          {summary.length ? (
            <p role="status" className="text-green-700 dark:text-green-400">
              {summary.join(' · ')}.
            </p>
          ) : last.errors.length === 0 && last.problems.length === 0 ? (
            <p role="status" className="text-gray-500">
              Nothing changed.
            </p>
          ) : null}
          {last.errors.length ? (
            <p role="alert" className="text-red-600 dark:text-red-400">
              Not applied: {last.errors.join('; ')}
            </p>
          ) : null}
          {last.problems.length ? (
            <p className="text-amber-700 dark:text-amber-400">
              Not read as variables: {last.problems.join('; ')}.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
