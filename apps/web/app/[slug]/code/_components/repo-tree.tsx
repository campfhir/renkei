'use client';

/**
 * The repository's folders and files as a tree, one directory fetched as
 * it is opened (`…/code/projects/[id]/tree?path=`), directories first —
 * from the checkout on the sandbox once a chat has made one, and from
 * the repository's git host (Bitbucket or GitHub) on the project's
 * branch before that, so the shape of the repository is there to look
 * at without cloning anything. `.git` itself is never listed — the
 * checkout's own bookkeeping, not something to browse or edit here.
 *
 * On the project page it is a look. In the code pane it is the way to a
 * file: `onOpen` makes every file a button, `selected` marks the one
 * open, `marks` puts an M, A or D beside files the working tree has
 * changed, and a change of `refreshKey` (a turn ended) reads every open
 * folder again, since that is when the checkout changes. A file the
 * working tree no longer has (`marks` says D) does not vanish from the
 * tree — a live directory listing can only show what is still on disk —
 * it is drawn in as a struck-through "ghost" row alongside whatever the
 * listing did return, so a folder with a lot of uncommitted change
 * still reads as one tree rather than a diff to puzzle over separately.
 * An entry the host reports as gitignored is drawn dimmed for the same
 * reason: still there, never hidden, but visually out of the way.
 *
 * `canEdit` (the code pane only — the project page's read-only look
 * never passes it) adds a per-row "⋯" for New file (folders)/Rename/
 * Delete, plus a "New file" at the root, against
 * …/code/projects/[id]/files (POST create, PATCH rename, DELETE
 * remove) — only once there is a checkout to edit (`source ===
 * 'checkout'`; before a clone the tree is the git host's own read-only
 * view, nothing here to change). Renaming or deleting the file open in
 * the pane needs the pane's own tab state updated too, so those two
 * ride up through `onRenamed`/`onDeleted` rather than being handled
 * here alone.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { LoadingLine } from '@/components/skeleton';
import Modal from '@/components/modal';
import { DialogFooter } from '../../chat/_components/chat-nav';
import OverflowMenu from '../../chat/_components/overflow-menu';

interface Entry {
  path: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  sizeBytes: number | null;
  ignored?: boolean;
}

type Listing =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; entries: Entry[] };

type Source = 'checkout' | 'bitbucket' | 'github';

/** The repository's host, for the source-not-cloned copy below. */
function hostLabel(source: Source | null): string {
  return source === 'github' ? 'GitHub' : 'Bitbucket';
}

/** How the working tree has a file: modified against HEAD, added (untracked), or gone. */
export type FileMark = 'M' | 'A' | 'D';

type Dialog =
  | { kind: 'new-file'; folder: string; name: string }
  | { kind: 'rename'; path: string; name: string };

function nameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function folderOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function size(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

export default function RepoTree({
  tenantId,
  projectId,
  onOpen = null,
  selected = null,
  marks,
  refreshKey = 0,
  touch = false,
  showBranch = true,
  canEdit = false,
  onRenamed,
  onDeleted,
}: {
  tenantId: string;
  projectId: string;
  /** Open a file; without it the tree is a look. */
  onOpen?: ((path: string) => void) | null;
  /** The file open in the pane, highlighted. */
  selected?: string | null;
  /** Files the working tree has changed, by path. */
  marks?: ReadonlyMap<string, FileMark>;
  /** Read every open folder again when this changes. */
  refreshKey?: number;
  /** Taller rows for a finger. */
  touch?: boolean;
  showBranch?: boolean;
  /** New file / rename / delete, once there is a checkout to edit. */
  canEdit?: boolean;
  /** The open file was renamed — old path, new path. */
  onRenamed?: (from: string, to: string) => void;
  /** The open file was deleted. */
  onDeleted?: (path: string) => void;
}) {
  const base = `/api/tenant/${tenantId}/code/projects/${projectId}/tree`;
  const filesBase = `/api/tenant/${tenantId}/code/projects/${projectId}/files`;
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [source, setSource] = useState<Source | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback(
    async (path: string, quiet = false) => {
      if (!quiet) setListings((current) => ({ ...current, [path]: { state: 'loading' } }));
      const result = await getJson<{
        path: string;
        entries: Entry[];
        source: Source;
        branch: string;
      }>(`${base}?path=${encodeURIComponent(path)}`);
      if (result.data) {
        setSource(result.data.source);
        setBranch(result.data.branch);
      }
      setListings((current) => ({
        ...current,
        [path]: result.data
          ? { state: 'ready', entries: result.data.entries }
          : { state: 'error', message: result.error ?? 'Could not list the folder.' },
      }));
    },
    [base]
  );

  useEffect(() => {
    void load('');
  }, [load]);

  // A turn ended: the folders on screen may have new files. Read them
  // again in place, without a loading flash.
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    void load('', true);
    for (const [path, expanded] of Object.entries(openRef.current)) {
      if (expanded) void load(path, true);
    }
  }, [refreshKey, load]);

  const toggle = (path: string) => {
    const next = !open[path];
    setOpen((current) => ({ ...current, [path]: next }));
    if (next && !listings[path]) void load(path);
  };

  const canWrite = canEdit && source === 'checkout';

  const ghostsFor = (path: string): string[] => {
    if (!marks) return [];
    const result: string[] = [];
    for (const [entryPath, mark] of marks) {
      if (mark === 'D' && folderOf(entryPath) === path) result.push(entryPath);
    }
    return result.sort((a, b) => a.localeCompare(b));
  };

  const openNewFileDialog = (folder: string) => {
    setDialogError(null);
    setDialog({ kind: 'new-file', folder, name: '' });
  };
  const openRenameDialog = (path: string) => {
    setDialogError(null);
    setDialog({ kind: 'rename', path, name: nameOf(path) });
  };

  const submitDialog = async () => {
    if (!dialog) return;
    const trimmed = dialog.name.trim();
    if (!trimmed) {
      setDialogError(dialog.kind === 'new-file' ? 'Say what to call it.' : 'Say the new name.');
      return;
    }
    setBusy(true);
    setDialogError(null);
    if (dialog.kind === 'new-file') {
      const path = dialog.folder ? `${dialog.folder}/${trimmed}` : trimmed;
      const result = await sendJsonFull<{ path: string }>(filesBase, 'POST', { path });
      setBusy(false);
      if (result.error) {
        setDialogError(result.error);
        return;
      }
      setDialog(null);
      void load(dialog.folder, true);
      if (dialog.folder && !open[dialog.folder]) {
        setOpen((current) => ({ ...current, [dialog.folder]: true }));
      }
    } else {
      const folder = folderOf(dialog.path);
      const to = folder ? `${folder}/${trimmed}` : trimmed;
      if (to === dialog.path) {
        setBusy(false);
        setDialog(null);
        return;
      }
      const result = await sendJsonFull<{ from: string; to: string }>(filesBase, 'PATCH', {
        from: dialog.path,
        to,
      });
      setBusy(false);
      if (result.error) {
        setDialogError(result.error);
        return;
      }
      setDialog(null);
      void load(folder, true);
      onRenamed?.(dialog.path, to);
    }
  };

  const deleteEntry = async (path: string, kind: Entry['kind']) => {
    const label = kind === 'dir' ? `“${nameOf(path)}” and everything in it` : `“${nameOf(path)}”`;
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    const result = await sendJsonFull(`${filesBase}?path=${encodeURIComponent(path)}`, 'DELETE');
    if (result.error) {
      window.alert(result.error);
      return;
    }
    void load(folderOf(path), true);
    if (kind === 'file') onDeleted?.(path);
  };

  const rowClass = touch ? 'min-h-10 py-1.5' : 'py-0.5';

  const renderGhost = (path: string, depth: number) => {
    const indent = { paddingLeft: `${depth * 12 + 4}px` };
    return (
      <li
        key={`ghost:${path}`}
        style={indent}
        title={`${path} — deleted, not committed`}
        className={`flex items-center gap-1.5 pr-2 text-xs text-gray-400 dark:text-gray-600 ${rowClass}`}
      >
        <span className="inline-block h-3 w-3 shrink-0" />
        <Icon path={ICONS.file} className="h-3.5 w-3.5 shrink-0 text-gray-300 dark:text-gray-700" />
        <span className="min-w-0 flex-1 truncate line-through">{nameOf(path)}</span>
        <span
          className="shrink-0 text-[10px] font-semibold text-red-500 dark:text-red-400"
          title="Deleted, not committed"
        >
          D
        </span>
      </li>
    );
  };

  const renderEntry = (entry: Entry, depth: number) => {
    const name = nameOf(entry.path);
    const indent = { paddingLeft: `${depth * 12 + 4}px` };
    const dimmed = entry.ignored ? 'opacity-50' : '';

    if (entry.kind === 'dir') {
      const expanded = open[entry.path] === true;
      const menu = canWrite ? (
        <OverflowMenu
          label={`More for ${name}`}
          anchored={false}
          items={[
            {
              label: 'New file',
              icon: ICONS.folderPlus,
              onSelect: () => openNewFileDialog(entry.path),
            },
            {
              label: 'Rename',
              icon: ICONS.pencil,
              onSelect: () => openRenameDialog(entry.path),
            },
            {
              label: 'Delete',
              icon: ICONS.trash,
              danger: true,
              onSelect: () => void deleteEntry(entry.path, 'dir'),
            },
          ]}
        />
      ) : null;
      return (
        <li key={entry.path}>
          <div
            className={`flex w-full items-center gap-0.5 rounded pr-1 hover:bg-gray-100 dark:hover:bg-gray-900 ${rowClass} ${dimmed}`}
          >
            <button
              type="button"
              onClick={() => toggle(entry.path)}
              aria-expanded={expanded}
              style={indent}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs"
            >
              <Icon
                path={ICONS.chevron}
                className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
              />
              <Icon path={ICONS.folder} className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="truncate">{name}</span>
            </button>
            {menu}
          </div>
          {expanded ? <ul>{renderDir(entry.path, depth + 1)}</ul> : null}
        </li>
      );
    }

    const mark = marks?.get(entry.path) ?? null;
    const isSelected = selected === entry.path;
    const body = (
      <>
        <span className="inline-block h-3 w-3 shrink-0" />
        <Icon path={ICONS.file} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        <span className="min-w-0 flex-1 truncate">
          {name}
          {entry.kind === 'link' ? ' →' : ''}
        </span>
        {mark ? (
          <span
            className={`shrink-0 text-[10px] font-semibold ${
              mark === 'A'
                ? 'text-green-600 dark:text-green-400'
                : mark === 'D'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-amber-600 dark:text-amber-400'
            }`}
            title={
              mark === 'A'
                ? 'Added, not committed'
                : mark === 'D'
                  ? 'Deleted, not committed'
                  : 'Changed, not committed'
            }
          >
            {mark}
          </span>
        ) : entry.sizeBytes !== null ? (
          <span className="shrink-0 text-[10px] text-gray-400">{size(entry.sizeBytes)}</span>
        ) : null}
      </>
    );
    const menu = canWrite ? (
      <OverflowMenu
        label={`More for ${name}`}
        anchored={false}
        items={[
          {
            label: 'Rename',
            icon: ICONS.pencil,
            onSelect: () => openRenameDialog(entry.path),
          },
          {
            label: 'Delete',
            icon: ICONS.trash,
            danger: true,
            onSelect: () => void deleteEntry(entry.path, 'file'),
          },
        ]}
      />
    ) : null;

    if (onOpen && entry.kind === 'file') {
      return (
        <li key={entry.path}>
          <div className={`flex w-full items-center gap-0.5 rounded pr-1 ${dimmed}`}>
            <button
              type="button"
              onClick={() => onOpen(entry.path)}
              aria-current={isSelected ? 'true' : undefined}
              style={indent}
              title={entry.path}
              className={`flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs ${rowClass} ${
                isSelected
                  ? 'bg-blue-50 text-gray-900 dark:bg-blue-950/40 dark:text-gray-100'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'
              }`}
            >
              {body}
            </button>
            {menu}
          </div>
        </li>
      );
    }
    return (
      <li
        key={entry.path}
        className={`flex items-center gap-0.5 pr-1 text-xs text-gray-700 dark:text-gray-300 ${dimmed}`}
      >
        <span style={indent} className={`flex min-w-0 flex-1 items-center gap-1.5 ${rowClass}`} title={entry.path}>
          {body}
        </span>
        {menu}
      </li>
    );
  };

  const renderDir = (path: string, depth: number) => {
    const listing = listings[path];
    const ghosts = ghostsFor(path);
    if (!listing || listing.state === 'loading') {
      return (
        <li className="py-1 pl-2">
          <LoadingLine size="xs" />
        </li>
      );
    }
    if (listing.state === 'error') {
      return (
        <>
          <li className="py-1 pl-2 text-xs text-red-600 dark:text-red-400">{listing.message}</li>
          {ghosts.map((path) => renderGhost(path, depth))}
        </>
      );
    }
    if (listing.entries.length === 0 && ghosts.length === 0) {
      return <li className="py-1 pl-2 text-xs text-gray-400">Empty.</li>;
    }
    return (
      <>
        {listing.entries.map((entry) => renderEntry(entry, depth))}
        {ghosts.map((path) => renderGhost(path, depth))}
      </>
    );
  };

  // The branch the tree shows: the checkout's working branch once a chat
  // has cloned; before that the branch the project was pointed at, as it
  // is on the repository's host — origin/<branch>.
  const branchLine =
    showBranch && branch ? (
      <p
        className="mb-2 flex items-center gap-1.5 text-xs text-gray-500"
        title={
          source === 'checkout'
            ? 'The working branch of the checkout on the sandbox, uncommitted changes included.'
            : `As it is on ${hostLabel(source)} — nothing is cloned yet.`
        }
      >
        <Icon path={ICONS.gitBranch} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        <span className="truncate font-mono">
          {source === 'checkout' ? branch : `origin/${branch}`}
        </span>
        <span className="shrink-0 text-[11px] text-gray-400">
          {source === 'checkout' ? 'working branch' : 'not cloned yet'}
        </span>
      </p>
    ) : null;

  return (
    <div>
      {branchLine}
      {canWrite ? (
        <button
          type="button"
          onClick={() => openNewFileDialog('')}
          className="mb-1.5 flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
        >
          <Icon path={ICONS.plus} className="h-3 w-3" />
          New file
        </button>
      ) : null}
      <ul role="tree" aria-label="Files" className="font-mono">
        {renderDir('', 0)}
      </ul>
      {dialog ? (
        <Modal
          title={dialog.kind === 'new-file' ? 'New file' : 'Rename'}
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitDialog();
            }}
            className="space-y-3"
          >
            {dialog.kind === 'new-file' && dialog.folder ? (
              <p className="truncate font-mono text-xs text-gray-500">{dialog.folder}/</p>
            ) : null}
            <input
              autoFocus
              aria-label={dialog.kind === 'new-file' ? 'File name' : 'New name'}
              value={dialog.name}
              onChange={(event) =>
                setDialog((current) => (current ? { ...current, name: event.target.value } : current))
              }
              maxLength={255}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <DialogFooter
              busy={busy}
              error={dialogError}
              label={dialog.kind === 'new-file' ? 'Create' : 'Rename'}
              onCancel={() => setDialog(null)}
            />
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
