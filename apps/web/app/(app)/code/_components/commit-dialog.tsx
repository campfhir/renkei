'use client';

/**
 * Commit from the code pane: the working tree's changed files — the
 * person's and the chat's alike, since the checkout is one — with
 * checkboxes, a message, and the branch it lands on or a new one first
 * (`POST …/commit`, authored as the person like the chat's own tool).
 * Then what the same dialog becomes: the hash on its branch, a Push
 * button (`POST …/push`, the person's own grant on the project's git
 * host), and the ask
 * that has the chat push and open the pull request. Files this browser
 * saved are tagged "edited here", files the chat's tools wrote in this
 * chat "by the chat"; git cannot say who changed a file in a shared
 * working tree, so the tags are what the page knows, never a claim.
 * Unsaved edits are not on disk and so not in the commit: the dialog
 * says so and offers to save them first.
 *
 * What a commit sends or refuses, how the ticks follow the working tree,
 * the tags and the buttons' words are commit-dialog.model.ts.
 */

import { useEffect, useReducer, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { ChatNote } from '@/lib/code/note-text';
import DiffView, { Counts } from './diff-view';
import { LoadingLine } from '@/components/skeleton';
import type { ChangedFile } from './use-code-pane';
import {
  askLabel,
  commitButton,
  commitReducer,
  commitRequest,
  filesHeading,
  initialCommit,
  selectedTotals,
  unsavedNotice,
  whoTag,
  type Committed,
} from './commit-dialog.model';

export const PUSH_AND_PR_ASK =
  'Push the current branch and open a pull request that says what changed and why.';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function CommitDialog({
  base,
  changed,
  branch,
  dirtyPaths,
  editedHere,
  chatPaths,
  personName,
  onClose,
  onSaveAll,
  onNote,
  onAsk,
}: {
  base: string;
  changed: ChangedFile[];
  branch: string | null;
  dirtyPaths: string[];
  editedHere: ReadonlySet<string>;
  chatPaths: ReadonlySet<string>;
  personName: string | null;
  onClose: () => void;
  onSaveAll: () => Promise<boolean>;
  /** The commit, then the push, for the chat's transcript. */
  onNote: (note: ChatNote) => void;
  /** Send the chat the push-and-pull-request ask; null when the person cannot. */
  onAsk: ((text: string) => Promise<boolean>) | null;
}) {
  const [state, dispatch] = useReducer(commitReducer, changed, initialCommit);
  const {
    selected,
    subject,
    body,
    newBranch,
    branchName,
    busy,
    error,
    committed,
    pushed,
    diffOpen,
  } = state;
  const [saving, setSaving] = useState(false);

  // Files that arrive after the dialog opened (a save while it is up) start selected too.
  useEffect(() => dispatch({ type: 'changed', files: changed }), [changed]);

  const count = selected.size;
  const totals = selectedTotals(state, changed);
  const button = commitButton(state);
  const unsaved = unsavedNotice(dirtyPaths);

  const commit = async () => {
    const plan = commitRequest(state, changed);
    if (!plan.ok) {
      dispatch({ type: 'refused', error: plan.error });
      return;
    }
    dispatch({ type: 'sent' });
    const result = await sendJsonFull<Committed>(`${base}/commit`, 'POST', plan.body);
    if (result.error || !result.data) {
      dispatch({ type: 'failed', error: result.error ?? 'The commit failed.' });
      return;
    }
    dispatch({ type: 'committed', commit: result.data });
    onNote({ type: 'commit', ...result.data });
  };

  const push = async () => {
    if (!committed) return;
    dispatch({ type: 'sent' });
    const result = await sendJsonFull<{ branch: string; remoteBranch: string }>(
      `${base}/push`,
      'POST',
      {}
    );
    if (result.error || !result.data) {
      dispatch({ type: 'failed', error: result.error ?? 'The push failed.' });
      return;
    }
    dispatch({ type: 'pushed', remoteBranch: result.data.remoteBranch });
    onNote({ type: 'push', branch: result.data.branch, remoteBranch: result.data.remoteBranch });
  };

  if (committed) {
    return (
      <Modal title="Committed" onClose={onClose}>
        <p className="flex items-start gap-2 text-sm">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300">
            <Icon path={ICONS.check} className="h-3.5 w-3.5" />
          </span>
          <span>
            Committed <span className="font-mono">{committed.sha}</span> on{' '}
            <span className="font-mono">{committed.branch}</span>
            {pushed ? (
              <span className="text-gray-500">
                {' '}
                · pushed to <span className="font-mono">origin/{pushed.remoteBranch}</span>
              </span>
            ) : (
              <span className="text-gray-500"> · not pushed</span>
            )}
          </span>
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!pushed ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void push()}
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Icon path={ICONS.gitPush} className="h-4 w-4" />
              {busy ? 'Pushing…' : 'Push branch'}
            </button>
          ) : null}
          {onAsk ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void onAsk(PUSH_AND_PR_ASK).then((sent) => {
                  if (sent) onClose();
                });
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              {askLabel(state)}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900"
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Commit changes" onClose={onClose} size="lg">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
        className="space-y-4"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
            <Icon path={ICONS.gitBranch} className="h-4 w-4 text-gray-400" />
            On <span className="font-mono text-gray-900 dark:text-gray-100">{branch ?? '…'}</span>
          </span>
          <label className="ml-auto flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={newBranch}
              onChange={(event) => dispatch({ type: 'newBranch', on: event.target.checked })}
            />
            Create a new branch first
          </label>
        </div>
        {newBranch ? (
          <input
            value={branchName}
            onChange={(event) => dispatch({ type: 'branchName', value: event.target.value })}
            placeholder="feature/what-this-changes"
            autoComplete="off"
            spellCheck={false}
            aria-label="New branch name"
            className={`font-mono ${inputClass}`}
          />
        ) : null}

        {unsaved ? (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="flex-1">{unsaved}</span>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void onSaveAll().finally(() => setSaving(false));
              }}
              className="rounded-md border border-amber-300 bg-white px-2 py-1 font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-gray-950 dark:hover:bg-amber-950"
            >
              {saving ? 'Saving…' : 'Save them first'}
            </button>
          </div>
        ) : null}

        <div>
          <div className="mb-1 flex items-center text-xs text-gray-500">
            <span className="flex-1">
              {filesHeading(state, changed)}
              {count > 0 ? (
                <>
                  {' '}
                  · <Counts added={totals.added} deleted={totals.deleted} />
                </>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => dispatch({ type: 'all', files: changed })}
              className="hover:underline"
            >
              All
            </button>
            <span className="px-1.5">·</span>
            <button
              type="button"
              onClick={() => dispatch({ type: 'none' })}
              className="hover:underline"
            >
              None
            </button>
          </div>
          <ul className="max-h-60 divide-y divide-gray-200 overflow-y-auto rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            {changed.length === 0 ? (
              <li className="px-3 py-2 text-xs text-gray-500">The working tree is clean.</li>
            ) : null}
            {changed.map((file) => (
              <li key={file.path} className="text-sm">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={selected.has(file.path)}
                    onChange={(event) =>
                      dispatch({ type: 'toggle', path: file.path, on: event.target.checked })
                    }
                    aria-label={`Include ${file.path}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
                    {file.path}
                  </span>
                  {(() => {
                    const who = whoTag(file.path, editedHere, chatPaths);
                    return who ? <Tag>{who}</Tag> : null;
                  })()}
                  {file.status === 'untracked' ? <Tag>new</Tag> : null}
                  <Counts added={file.added} deleted={file.deleted} />
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'diff', path: file.path })}
                    aria-label={`Show the diff of ${file.path}`}
                    aria-expanded={diffOpen === file.path}
                    className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-900 dark:hover:text-gray-200"
                  >
                    <Icon path={ICONS.diff} className="h-3.5 w-3.5" />
                  </button>
                </div>
                {diffOpen === file.path ? (
                  <div className="border-t border-gray-200 px-2 py-2 dark:border-gray-800">
                    <FileDiffInline base={base} path={file.path} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-gray-500" htmlFor="commit-subject">
            Message
          </label>
          <input
            id="commit-subject"
            value={subject}
            onChange={(event) => dispatch({ type: 'subject', value: event.target.value })}
            placeholder="What this change does"
            maxLength={500}
            autoFocus
            className={inputClass}
          />
          <textarea
            value={body}
            onChange={(event) => dispatch({ type: 'body', value: event.target.value })}
            placeholder="Why, if it is not obvious (optional)"
            rows={3}
            maxLength={3_400}
            aria-label="Description"
            className={inputClass}
          />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">
            Authored as {personName ?? 'you'}. Nothing leaves the sandbox until you push.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={button.disabled}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {button.label}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function Tag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded bg-gray-100 px-1.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
      {children}
    </span>
  );
}

/** One file's working-tree diff against HEAD, fetched when its fold opens. */
export function FileDiffInline({ base, path }: { base: string; path: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    void getJson<{ diff: string; available: boolean }>(
      `${base}/diff?context=3&path=${encodeURIComponent(path)}`
    ).then((result) => {
      if (cancelled) return;
      if (result.data) setDiff(result.data.available ? result.data.diff : '');
      else setError(result.error ?? 'The diff could not be read.');
    });
    return () => {
      cancelled = true;
    };
  }, [base, path]);
  if (error) return <p className="text-xs text-red-600 dark:text-red-400">{error}</p>;
  if (diff === null) return <LoadingLine size="xs" label="Reading the diff…" />;
  return <DiffView diff={diff} openAll layout="stacked" />;
}
