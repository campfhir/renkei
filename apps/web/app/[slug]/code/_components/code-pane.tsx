'use client';

/**
 * The code pane: the repository's checkout beside the chat (a column
 * about 70% of the chat page's main column) or under its title bar as
 * the Code tab on a narrow one — the same pane in two layouts, its
 * state in use-code-pane.ts so it survives the move between them.
 *
 * Beside the chat: a header with the file tree's toggle, the open files
 * as tabs, Save, Commit with the count of changed files, and a close;
 * a rail with the working tree's **Changed** files above the tree; the
 * editor; and a status line saying the one thing that matters — saved
 * to the checkout but not committed, or unsaved. As a tab: the rail's
 * content full width with Commit along the bottom, and a file opened
 * over it with Save above the keyboard. Every read and write goes
 * through the same routes the chat's tools' work is seen through, so
 * what is here is what the chat sees.
 */

import { useEffect, useMemo, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { LoadingLine } from '@/components/skeleton';
import type { ChatNote } from '@/lib/code/note-text';
import { unifiedDiff } from '@/lib/code/text-diff';
import CodeEditor from './code-editor';
import CommitDialog, { FileDiffInline } from './commit-dialog';
import DiffView, { Counts } from './diff-view';
import RepoTree, { type FileMark } from './repo-tree';
import type { CodePaneFile, CodePaneHandle } from './use-code-pane';

const TREE_KEY = 'code-pane:tree';

function nameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function folderOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

const headerButton =
  'flex h-8 items-center gap-1.5 rounded-md border border-gray-300 px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900';
const primaryButton =
  'flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const iconButton =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-900 dark:hover:text-gray-200';

export default function CodePane({
  tenantId,
  projectId,
  pane,
  layout,
  touch,
  canEdit,
  chatPaths,
  personName,
  refreshKey,
  onNote,
  onAsk,
  onClose,
}: {
  tenantId: string;
  projectId: string;
  pane: CodePaneHandle;
  /** Beside the chat, or the Code tab. */
  layout: 'split' | 'tab';
  /** A touch screen: the text area instead of Monaco, taller rows. */
  touch: boolean;
  /** The person may save and commit (the chat's owner and an editor of the project). */
  canEdit: boolean;
  /** Files the chat's tools wrote in this chat, for the commit dialog's tags. */
  chatPaths: ReadonlySet<string>;
  personName: string | null;
  /** Bumped when a turn ends; the tree reads its open folders again. */
  refreshKey: number;
  onNote: (note: ChatNote) => void;
  onAsk: ((text: string) => Promise<boolean>) | null;
  /** Close the pane (beside the chat only). */
  onClose: () => void;
}) {
  const base = `/api/tenant/${tenantId}/code/projects/${projectId}`;
  const [treeOpen, setTreeOpen] = useState(true);
  const [showList, setShowList] = useState(pane.active === null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [compareFor, setCompareFor] = useState<string | null>(null);

  useEffect(() => {
    try {
      setTreeOpen(localStorage.getItem(TREE_KEY) !== 'closed');
    } catch {
      // Left open.
    }
  }, []);
  const toggleTree = () => {
    setTreeOpen((open) => {
      try {
        localStorage.setItem(TREE_KEY, open ? 'closed' : 'open');
      } catch {
        // Not remembered, then.
      }
      return !open;
    });
  };

  const marks = useMemo(() => {
    const map = new Map<string, FileMark>();
    for (const file of pane.changed) map.set(file.path, file.status === 'untracked' ? 'A' : 'M');
    return map;
  }, [pane.changed]);

  const active = pane.active ? (pane.files[pane.active] ?? null) : null;
  const dirty = new Set(pane.dirtyPaths);
  const activeDirty = active ? dirty.has(active.path) : false;
  const totals = pane.changed.reduce(
    (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
    { added: 0, deleted: 0 }
  );

  const openFile = (path: string) => {
    pane.open(path);
    setShowList(false);
  };

  const commitButton = (
    <button
      type="button"
      onClick={() => setCommitOpen(true)}
      disabled={!canEdit || !pane.available || pane.changed.length === 0}
      title={
        !pane.available
          ? 'There is no checkout to commit in yet.'
          : pane.changed.length === 0
            ? 'The working tree is clean.'
            : 'Commit the working tree’s changes'
      }
      className={
        layout === 'tab' ? `${primaryButton} h-11 flex-1 justify-center text-sm` : headerButton
      }
    >
      <Icon path={ICONS.gitCommit} className="h-4 w-4" />
      Commit
      {pane.changed.length > 0 ? (
        <span className="rounded-full bg-gray-900 px-1.5 text-[10px] leading-4 text-white dark:bg-gray-100 dark:text-gray-900">
          {pane.changed.length}
        </span>
      ) : null}
    </button>
  );

  const saveButtons = active && active.state === 'ready' && active.editable && canEdit && (
    <>
      <button
        type="button"
        onClick={() => pane.discard(active.path)}
        disabled={!activeDirty || active.saving}
        className={layout === 'tab' ? `${headerButton} h-11 px-4 text-sm` : headerButton}
      >
        Discard
      </button>
      <button
        type="button"
        onClick={() => void pane.save(active.path)}
        disabled={!activeDirty || active.saving}
        title="Save to the checkout (⌘S)"
        className={
          layout === 'tab' ? `${primaryButton} h-11 flex-1 justify-center text-sm` : primaryButton
        }
      >
        {active.saving ? 'Saving…' : layout === 'tab' ? 'Save to checkout' : 'Save'}
      </button>
    </>
  );

  const rail = (
    <div className={layout === 'tab' ? 'px-2 py-3' : 'p-2'}>
      {pane.changed.length > 0 ? (
        <section className="mb-3">
          <h3 className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <span className="flex-1">Changed · not committed</span>
            <Counts added={totals.added} deleted={totals.deleted} />
          </h3>
          <ul className="font-mono">
            {pane.changed.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => openFile(file.path)}
                  aria-current={pane.active === file.path ? 'true' : undefined}
                  title={file.path}
                  className={`flex w-full items-center gap-1.5 rounded px-1 text-left text-xs ${touch ? 'min-h-10 py-1.5' : 'py-0.5'} ${
                    pane.active === file.path
                      ? 'bg-blue-50 dark:bg-blue-950/40'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-900'
                  }`}
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      dirty.has(file.path)
                        ? 'bg-amber-500'
                        : file.status === 'untracked'
                          ? 'bg-green-500'
                          : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                    title={
                      dirty.has(file.path)
                        ? 'Unsaved edits here'
                        : file.status === 'untracked'
                          ? 'New file'
                          : 'Changed'
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  <Counts added={file.added} deleted={file.deleted} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <h3 className="mb-1 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        <span className="flex-1">Files</span>
        {pane.branch ? (
          <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] normal-case tracking-normal text-gray-500">
            <Icon path={ICONS.gitBranch} className="h-3 w-3 shrink-0" />
            <span className="truncate">{pane.branch}</span>
          </span>
        ) : null}
      </h3>
      <RepoTree
        tenantId={tenantId}
        projectId={projectId}
        onOpen={openFile}
        selected={pane.active}
        marks={marks}
        refreshKey={refreshKey}
        touch={touch}
        showBranch={false}
      />
    </div>
  );

  const editor = active ? (
    <FileBody
      file={active}
      touch={touch}
      canEdit={canEdit}
      onChange={(text) => pane.setText(active.path, text)}
      onSave={() => void pane.save(active.path)}
      onCompare={() => setCompareFor(active.path)}
      onReloadTheirs={() => pane.reloadTheirs(active.path)}
      onKeepMine={() => void pane.save(active.path, { force: true })}
    />
  ) : (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500">
      <p>
        Pick a file to read it here.
        {canEdit ? ' Edit it, save to the checkout, and commit when it is ready.' : ''}
      </p>
    </div>
  );

  const modals = (
    <>
      {commitOpen ? (
        <CommitDialog
          base={base}
          changed={pane.changed}
          branch={pane.branch}
          dirtyPaths={pane.dirtyPaths}
          editedHere={pane.editedHere}
          chatPaths={chatPaths}
          personName={personName}
          onClose={() => {
            setCommitOpen(false);
            pane.refresh();
          }}
          onSaveAll={pane.saveAll}
          onNote={onNote}
          onAsk={onAsk}
        />
      ) : null}
      {diffFor ? (
        <Modal title={`Changes to ${nameOf(diffFor)}`} onClose={() => setDiffFor(null)} size="wide">
          <p className="mb-2 truncate font-mono text-xs text-gray-500">{diffFor}</p>
          <div className="max-h-[70vh] overflow-y-auto">
            <FileDiffInline base={base} path={diffFor} />
          </div>
        </Modal>
      ) : null}
      {compareFor && pane.files[compareFor]?.conflict ? (
        <CompareModal file={pane.files[compareFor]} onClose={() => setCompareFor(null)} />
      ) : null}
    </>
  );

  if (layout === 'tab') {
    if (showList || !active) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">{rail}</div>
          {canEdit ? (
            <div className="flex gap-2 border-t border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-900">
              {commitButton}
            </div>
          ) : null}
          {modals}
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-gray-200 bg-gray-50 pr-2 dark:border-gray-800 dark:bg-gray-900">
          <button
            type="button"
            onClick={() => setShowList(true)}
            aria-label="Back to files"
            className={`${iconButton} h-10 w-10`}
          >
            <Icon path={ICONS.chevronLeft} className="h-5 w-5" />
          </button>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs">
            {activeDirty ? <Dot /> : null}
            <span className="truncate">
              <span className="text-gray-400">
                {folderOf(active.path) ? `${folderOf(active.path)}/` : ''}
              </span>
              {nameOf(active.path)}
            </span>
          </span>
          {marks.has(active.path) ? (
            <button type="button" onClick={() => setDiffFor(active.path)} className={headerButton}>
              Diff
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">{editor}</div>
        {active.state === 'ready' && active.editable && canEdit ? (
          <div className="flex gap-2 border-t border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-900">
            {saveButtons}
          </div>
        ) : null}
        {modals}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-stretch border-b border-gray-200 dark:border-gray-800">
        <button
          type="button"
          onClick={toggleTree}
          aria-label={treeOpen ? 'Hide the file tree' : 'Show the file tree'}
          aria-pressed={treeOpen}
          className="flex w-10 shrink-0 items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-900 dark:hover:text-gray-200"
        >
          <Icon path={ICONS.layers} className="h-4 w-4" />
        </button>
        <div role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 overflow-x-auto">
          {pane.tabs.map((path) => {
            const isActive = pane.active === path;
            return (
              <div
                key={path}
                role="tab"
                aria-selected={isActive}
                className={`flex shrink-0 items-center gap-1.5 border-r border-gray-200 pl-3 pr-1 font-mono text-xs dark:border-gray-800 ${
                  isActive
                    ? 'border-b-2 border-b-blue-600 text-gray-900 dark:text-gray-100'
                    : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-900'
                }`}
              >
                <button
                  type="button"
                  onClick={() => pane.activate(path)}
                  title={path}
                  className="flex h-full items-center gap-1.5"
                >
                  {dirty.has(path) ? <Dot /> : null}
                  <span>{nameOf(path)}</span>
                  {folderOf(path) ? (
                    <span className="max-w-32 truncate text-gray-400">{folderOf(path)}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => pane.close(path)}
                  aria-label={`Close ${nameOf(path)}`}
                  className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                >
                  <Icon path={ICONS.close} className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2 px-2">
          {pane.dirtyPaths.length > 0 ? (
            <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
              {pane.dirtyPaths.length} unsaved
            </span>
          ) : null}
          {active && marks.has(active.path) ? (
            <button type="button" onClick={() => setDiffFor(active.path)} className={headerButton}>
              <Icon path={ICONS.diff} className="h-3.5 w-3.5" />
              Diff
            </button>
          ) : null}
          {saveButtons}
          {canEdit ? commitButton : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the code pane"
            className={iconButton}
          >
            <Icon path={ICONS.close} className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {treeOpen ? (
          <div className="w-56 shrink-0 overflow-y-auto border-r border-gray-200 dark:border-gray-800">
            {rail}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">{editor}</div>
          <div className="flex h-7 shrink-0 items-center gap-4 border-t border-gray-200 bg-gray-50 px-3 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-gray-900">
            {active ? (
              <>
                <span className="truncate font-mono">{active.path}</span>
                <span className="shrink-0">{active.language}</span>
                <span className="ml-auto shrink-0">{statusWord(active, activeDirty, canEdit)}</span>
              </>
            ) : (
              <span className="ml-auto" />
            )}
            {pane.changed.length > 0 ? (
              <span className="shrink-0">
                <Counts added={totals.added} deleted={totals.deleted} /> in {pane.changed.length}{' '}
                file{pane.changed.length === 1 ? '' : 's'}
              </span>
            ) : pane.available ? (
              <span className="shrink-0">Working tree clean</span>
            ) : null}
          </div>
        </div>
      </div>
      {modals}
    </div>
  );
}

function Dot() {
  return <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" title="Unsaved edits" />;
}

/** The repository's host, for a file read before any chat has cloned. */
function fileHostLabel(source: CodePaneFile['source']): string {
  return source === 'github' ? 'GitHub' : 'Bitbucket';
}

function statusWord(file: CodePaneFile, dirty: boolean, canEdit: boolean): string {
  if (file.state !== 'ready') return '';
  if (file.conflict) return 'Changed in the checkout while you were editing';
  if (dirty) return 'Unsaved edits · Save writes to the checkout';
  if (file.binary) return 'Binary file';
  if (file.source !== 'checkout') return `From ${fileHostLabel(file.source)} · nothing is cloned yet`;
  if (!canEdit) return 'Read-only · only the chat’s owner edits here';
  if (!file.editable) return file.truncated ? 'Too long to edit here' : 'Read-only';
  return 'Saved to the checkout · not committed until you commit';
}

/** The editor with the file's own messages around it: loading, errors, read-only reasons, the conflict banner. */
function FileBody({
  file,
  touch,
  canEdit,
  onChange,
  onSave,
  onCompare,
  onReloadTheirs,
  onKeepMine,
}: {
  file: CodePaneFile;
  touch: boolean;
  canEdit: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onCompare: () => void;
  onReloadTheirs: () => void;
  onKeepMine: () => void;
}) {
  if (file.state === 'loading') {
    return <LoadingLine size="xs" className="p-3" label="Reading the file…" />;
  }
  if (file.state === 'error') {
    return (
      <p role="alert" className="p-3 text-sm text-red-600 dark:text-red-400">
        {file.error ?? 'The file could not be read.'}
      </p>
    );
  }
  if (file.binary) {
    return (
      <p className="p-3 text-sm text-gray-500">This is a binary file; there is no text to show.</p>
    );
  }
  const readOnly = !file.editable || !canEdit;
  const reason = !canEdit
    ? 'Only the chat’s owner edits here.'
    : file.source !== 'checkout'
      ? `Read from ${fileHostLabel(file.source)} — send a message so a chat clones the repository, then edit.`
      : file.truncated
        ? 'Cut short: the file is too long to show whole, so it is read-only here.'
        : !file.editable
          ? 'Too long to edit here.'
          : null;
  const linkClass = 'font-medium hover:underline';
  return (
    <div className="flex h-full min-h-0 flex-col">
      {file.conflict ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <span className="flex-1">
            {file.conflict.text === null
              ? 'This file is no longer in the checkout as it was. Your edits are still here.'
              : 'The checkout’s copy of this file changed while you were editing it — the chat’s turn, most likely. Your edits are still here.'}
          </span>
          {file.conflict.text !== null ? (
            <button type="button" onClick={onCompare} className={linkClass}>
              Compare
            </button>
          ) : null}
          <button type="button" onClick={onReloadTheirs} className={linkClass}>
            Reload theirs
          </button>
          <button type="button" onClick={onKeepMine} className={linkClass}>
            Keep mine
          </button>
        </div>
      ) : null}
      {file.error ? (
        <p
          role="alert"
          className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          {file.error}
        </p>
      ) : null}
      {reason ? (
        <p className="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900">
          {reason}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <CodeEditor
          path={file.path}
          language={file.language}
          value={file.text}
          readOnly={readOnly}
          touch={touch}
          onChange={onChange}
          onSave={onSave}
        />
      </div>
    </div>
  );
}

/** The checkout's text against the person's unsaved edits. */
function CompareModal({ file, onClose }: { file: CodePaneFile; onClose: () => void }) {
  const theirs = file.conflict?.text ?? '';
  const diff = useMemo(
    () => unifiedDiff(file.path, theirs, file.text),
    [file.path, theirs, file.text]
  );
  return (
    <Modal title={`Compare ${nameOf(file.path)}`} onClose={onClose} size="wide">
      <p className="mb-2 text-xs text-gray-500">
        The checkout’s copy on the left (− lines), your unsaved edits on the right (+ lines).
      </p>
      <div className="max-h-[70vh] overflow-y-auto">
        {diff === null ? (
          <div className="grid grid-cols-2 gap-2 font-mono text-xs">
            <pre className="chat-pre max-h-[65vh] overflow-auto">{theirs}</pre>
            <pre className="chat-pre max-h-[65vh] overflow-auto">{file.text}</pre>
          </div>
        ) : diff === '' ? (
          <p className="text-xs text-gray-500">The two are the same now.</p>
        ) : (
          <DiffView diff={diff} openAll />
        )}
      </div>
    </Modal>
  );
}
