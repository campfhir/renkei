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
 */

import { useEffect, useMemo, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { ChatNote } from '@/lib/code/note-text';
import DiffView, { Counts } from './diff-view';
import { LoadingLine } from '@/components/skeleton';
import type { ChangedFile } from './use-code-pane';

export const PUSH_AND_PR_ASK =
  'Push the current branch and open a pull request that says what changed and why.';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

interface Committed {
  branch: string;
  sha: string;
  subject: string;
}

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
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(changed.map((file) => file.path))
  );
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [newBranch, setNewBranch] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<Committed | null>(null);
  const [pushed, setPushed] = useState<{ remoteBranch: string } | null>(null);
  const [diffOpen, setDiffOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Files that arrive after the dialog opened (a save while it is up) start selected too.
  useEffect(() => {
    setSelected((current) => {
      const next = new Set(current);
      for (const file of changed) if (!current.has(file.path)) next.add(file.path);
      for (const path of current)
        if (!changed.some((file) => file.path === path)) next.delete(path);
      return next;
    });
  }, [changed]);

  const count = selected.size;
  const all = changed.length > 0 && count === changed.length;
  const totals = useMemo(
    () =>
      changed
        .filter((file) => selected.has(file.path))
        .reduce(
          (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
          { added: 0, deleted: 0 }
        ),
    [changed, selected]
  );

  const commit = async () => {
    const message = [subject.trim(), body.trim()].filter(Boolean).join('\n\n');
    if (!subject.trim()) {
      setError('Write a commit message.');
      return;
    }
    if (count === 0) {
      setError('Pick at least one file.');
      return;
    }
    if (newBranch && !branchName.trim()) {
      setError('Name the new branch.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<Committed>(`${base}/commit`, 'POST', {
      message,
      ...(all ? {} : { paths: [...selected] }),
      ...(newBranch ? { newBranch: branchName.trim() } : {}),
    });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'The commit failed.');
      return;
    }
    setCommitted(result.data);
    onNote({ type: 'commit', ...result.data });
  };

  const push = async () => {
    if (!committed) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ branch: string; remoteBranch: string }>(
      `${base}/push`,
      'POST',
      {}
    );
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'The push failed.');
      return;
    }
    setPushed({ remoteBranch: result.data.remoteBranch });
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
              {pushed
                ? 'Ask the chat to open a pull request'
                : 'Ask the chat to push and open a pull request'}
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
              onChange={(event) => setNewBranch(event.target.checked)}
            />
            Create a new branch first
          </label>
        </div>
        {newBranch ? (
          <input
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            placeholder="feature/what-this-changes"
            autoComplete="off"
            spellCheck={false}
            aria-label="New branch name"
            className={`font-mono ${inputClass}`}
          />
        ) : null}

        {dirtyPaths.length > 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="flex-1">
              {dirtyPaths.length === 1
                ? '1 file has unsaved edits, which are not part of a commit.'
                : `${dirtyPaths.length} files have unsaved edits, which are not part of a commit.`}
            </span>
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
              Files · {count} of {changed.length} selected
              {count > 0 ? (
                <>
                  {' '}
                  · <Counts added={totals.added} deleted={totals.deleted} />
                </>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set(changed.map((file) => file.path)))}
              className="hover:underline"
            >
              All
            </button>
            <span className="px-1.5">·</span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
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
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(file.path);
                        else next.delete(file.path);
                        return next;
                      })
                    }
                    aria-label={`Include ${file.path}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
                    {file.path}
                  </span>
                  {editedHere.has(file.path) ? (
                    <Tag>edited here</Tag>
                  ) : chatPaths.has(file.path) ? (
                    <Tag>by the chat</Tag>
                  ) : null}
                  {file.status === 'untracked' ? <Tag>new</Tag> : null}
                  <Counts added={file.added} deleted={file.deleted} />
                  <button
                    type="button"
                    onClick={() => setDiffOpen((open) => (open === file.path ? null : file.path))}
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
            onChange={(event) => setSubject(event.target.value)}
            placeholder="What this change does"
            maxLength={500}
            autoFocus
            className={inputClass}
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
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
              disabled={busy || count === 0}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Committing…' : `Commit ${count} file${count === 1 ? '' : 's'}`}
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
