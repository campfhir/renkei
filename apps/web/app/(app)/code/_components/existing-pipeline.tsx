'use client';

/**
 * A branch's pipeline that was not built here — a
 * `bitbucket-pipelines.yml` or GitHub workflows written in another editor,
 * or before the project came to Renkei — as the Pipeline tab opens on it
 * (pipeline-builder.tsx decides when; existing-pipeline.model.ts holds
 * what this shows and sends).
 *
 * The file as it is on the branch, read with the person's own grant; an
 * editor that commits straight to the branch, by hand or with the
 * assistant's proposal put into it (the assistant in the dock works on
 * this file, as text); a block of YAML ready to copy into it, which lets
 * Renkei record its deployments; and, said plainly, what building
 * from blocks instead would do to the file.
 */

import { useEffect, type Dispatch } from 'react';
import ExternalLink from '@/components/external-link';
import { Icon, ICONS } from '@/components/icons';
import { LoadingLine } from '@/components/skeleton';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import {
  buildLabel,
  buildWarning,
  canCommit,
  commitRequest,
  filePath,
  fileUrl,
  isEdited,
  textRows,
  type ExistingAction,
  type ExistingHost,
  type ExistingState,
  type ReportStep,
} from './existing-pipeline.model';
import {
  cardClass,
  inputClass,
  linkButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './pipeline-parts';

const HOST = { bitbucket: 'Bitbucket', github: 'GitHub' } as const;

export default function ExistingPipeline({
  state,
  dispatch,
  projectId,
  host,
  branch,
  environment,
  canEdit,
  onBuild,
  onAskAssistant,
}: {
  state: ExistingState;
  dispatch: Dispatch<ExistingAction>;
  projectId: string;
  host: ExistingHost;
  branch: string;
  /** The environment the branch is assigned to. */
  environment: string;
  canEdit: boolean;
  /** Build from blocks instead. */
  onBuild: () => void;
  /** Open the assistant, which works on the file open here. */
  onAskAssistant: () => void;
}) {
  const selected = state.selected;
  const url = selected ? fileUrl(host, projectId, branch, selected) : null;

  // The file open, as it is on the branch.
  useEffect(() => {
    if (!selected || !url) return;
    let live = true;
    void (async () => {
      const result = await getJson<{ text: string | null }>(url);
      if (!live) return;
      if (result.error || !result.data) {
        dispatch({
          type: 'readFailed',
          name: selected,
          error: result.error ?? 'The file could not be read.',
        });
      } else dispatch({ type: 'read', name: selected, text: result.data.text ?? '' });
    })();
    return () => {
      live = false;
    };
  }, [selected, url, dispatch]);

  const commit = async () => {
    const body = commitRequest(state, host);
    if (!body || !url) return;
    dispatch({ type: 'sent' });
    const result = await sendJsonFull<{ ref: string; url: string }>(url, 'PUT', body);
    if (result.error || !result.data) {
      dispatch({ type: 'failed', error: result.error ?? 'The file was not committed.' });
      return;
    }
    dispatch({ type: 'committed', ref: result.data.ref, url: result.data.url });
  };

  const takeReportStep = async () => {
    dispatch({ type: 'reportAsked' });
    const result = await sendJsonFull<ReportStep>(
      `/api/code/projects/${projectId}/report-step?branch=${encodeURIComponent(branch)}`,
      'POST'
    );
    if (result.error || !result.data) {
      dispatch({
        type: 'reportFailed',
        error: result.error ?? 'The report step could not be prepared.',
      });
      return;
    }
    dispatch({ type: 'reportRead', step: result.data });
  };

  // The block is there to copy as soon as the file is: preparing it also
  // tells Renkei which repository's reports are this project's.
  const wanted = canEdit && !state.report && !state.reportBusy && !state.reportError;
  useEffect(() => {
    if (wanted) void takeReportStep();
    // Asked once, when first wanted.
  }, [wanted]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      dispatch({ type: 'copied' });
    } catch {
      // No clipboard here: the text is on screen to select.
    }
  };

  const draft = state.draft;
  return (
    <div className="space-y-4" data-testid="existing-pipeline">
      <section aria-labelledby="existing-heading" className={`${cardClass} space-y-3`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="existing-heading" className="text-sm font-semibold">
            The pipeline on <span className="font-mono">{branch}</span>
          </h2>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            Not built in Renkei
          </span>
          {canEdit && !draft && state.text !== null ? (
            <span className="ml-auto flex items-center gap-3">
              <button type="button" onClick={onAskAssistant} className={linkButtonClass}>
                Ask the assistant to change it
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: 'editStarted' })}
                className={linkButtonClass}
              >
                Edit
              </button>
            </span>
          ) : null}
        </div>
        <p className="text-xs text-gray-500">
          This branch already has a pipeline, written outside Renkei. It is shown as it is and left
          as it is: {HOST[host]} runs it, its runs are on the Runs tab, and what it reads is on the
          Variables tab. Edits here are committed to <span className="font-mono">{branch}</span>{' '}
          with your own {HOST[host]} access.
        </p>

        {state.files.length > 1 ? (
          <div role="tablist" aria-label="Pipeline files" className="flex flex-wrap gap-2">
            {state.files.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={name === selected}
                disabled={state.busy}
                onClick={() => {
                  if (
                    !isEdited(state) ||
                    window.confirm(`Leave ${selected}? What you changed in it is not committed.`)
                  ) {
                    dispatch({ type: 'picked', name });
                  }
                }}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${
                  name === selected
                    ? 'border-blue-600 bg-blue-50 font-semibold dark:border-blue-500 dark:bg-blue-950/40'
                    : 'border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}

        {selected ? (
          <p className="flex items-center gap-1.5 font-mono text-xs text-gray-600 dark:text-gray-400">
            <Icon path={ICONS.fileText} className="h-3.5 w-3.5" />
            {filePath(host, selected)}
          </p>
        ) : null}

        {state.loading ? <LoadingLine size="xs" label="Reading the file…" /> : null}

        {draft ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void commit();
            }}
            aria-label="Edit the pipeline file"
            className="space-y-2"
          >
            <textarea
              value={draft.text}
              onChange={(event) =>
                dispatch({ type: 'draftChanged', field: 'text', value: event.target.value })
              }
              rows={textRows(draft.text)}
              spellCheck={false}
              aria-label={selected ?? 'Pipeline file'}
              className={`font-mono ${inputClass}`}
            />
            <label className="block text-xs">
              <span className="text-gray-500">Commit message</span>
              <input
                value={draft.message}
                onChange={(event) =>
                  dispatch({ type: 'draftChanged', field: 'message', value: event.target.value })
                }
                maxLength={500}
                className={`mt-0.5 ${inputClass}`}
              />
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <p className="mr-auto text-xs text-gray-500">
                Commit goes straight to <span className="font-mono">{branch}</span>: what is in the
                box is what lands, and {HOST[host]} runs it from the next push.
              </p>
              <button
                type="button"
                onClick={onAskAssistant}
                className={`inline-flex items-center gap-1 ${secondaryButtonClass}`}
              >
                <Icon path={ICONS.sparkles} className="h-3.5 w-3.5" />
                Assistant
              </button>
              <button
                type="button"
                disabled={state.busy}
                onClick={() => dispatch({ type: 'editCancelled' })}
                className={secondaryButtonClass}
              >
                Cancel
              </button>
              <button type="submit" disabled={!canCommit(state)} className={primaryButtonClass}>
                {state.busy ? 'Committing…' : 'Commit'}
              </button>
            </div>
          </form>
        ) : state.text !== null ? (
          <pre
            aria-label={`${selected ?? 'The pipeline file'} as it is on ${branch}`}
            className="max-h-[32rem] overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs leading-relaxed dark:border-gray-800 dark:bg-gray-900/60"
          >
            {state.text || '(empty)'}
          </pre>
        ) : null}

        {state.error ? (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {state.error}
          </p>
        ) : null}
        {state.committed ? (
          <p role="status" className="text-xs text-green-700 dark:text-green-400">
            Committed {selected} to {state.committed.ref}.{' '}
            {state.committed.url ? (
              <ExternalLink href={state.committed.url} className="underline">
                See it on {HOST[host]}
              </ExternalLink>
            ) : null}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="report-heading" className={`${cardClass} space-y-2`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="report-heading" className="text-sm font-semibold">
            Record deployments in Renkei
          </h2>
          {state.report ? (
            <button
              type="button"
              onClick={() => void copy(state.report?.snippet ?? '')}
              className={`ml-auto inline-flex items-center gap-1 ${secondaryButtonClass}`}
            >
              <Icon path={state.copied ? ICONS.check : ICONS.copy} className="h-3.5 w-3.5" />
              {state.copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </div>
        <p className="text-xs text-gray-500">
          Adding this to the pipeline lets Renkei record each deployment of {environment}: the
          commit, when, and whether it worked. No secret is involved: {HOST[host]} signs a
          short-lived token for the step, and Renkei checks it.
        </p>
        {state.reportBusy ? <LoadingLine size="xs" label="Writing the block…" /> : null}
        {state.reportError ? (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {state.reportError}
          </p>
        ) : null}
        {state.report ? (
          <>
            <pre
              aria-label={`What records deployments of ${state.report.environment}`}
              className="max-h-80 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs leading-relaxed dark:border-gray-800 dark:bg-gray-900/60"
            >
              {state.report.snippet}
            </pre>
            <p className="text-xs text-gray-500">{state.report.where}</p>
          </>
        ) : !canEdit ? (
          <p className="text-xs text-gray-500">An editor of the project gets the block here.</p>
        ) : null}
      </section>

      {canEdit ? (
        <section aria-labelledby="build-heading" className={`${cardClass} space-y-2`}>
          <h2 id="build-heading" className="text-sm font-semibold">
            Or build it from blocks
          </h2>
          <p className="text-xs text-gray-500">{buildWarning(host, state, branch)}</p>
          <p className="text-xs text-gray-500">
            Nothing changes until that pull request is opened and merged; you can look at the
            builder and come back to the file.
          </p>
          <button type="button" onClick={onBuild} className={secondaryButtonClass}>
            {buildLabel(host)}
          </button>
        </section>
      ) : null}
    </div>
  );
}
