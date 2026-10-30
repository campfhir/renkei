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
 * The code pane is its only caller: `onOpen` makes every file a button,
 * `selected` marks the one open, `marks` puts an M, A or D beside files
 * the working tree has changed, and a change of `refreshKey` (a turn
 * ended) reads every open folder again, since that is when the checkout
 * changes. A file the working tree no longer has (`marks` says D) does
 * not vanish from the tree — a live directory listing can only show
 * what is still on disk — it is drawn in as a struck-through "ghost" row
 * alongside whatever the listing did return, so a folder with a lot of
 * uncommitted change still reads as one tree rather than a diff to
 * puzzle over separately; the pane wires `onDeletedClick` so clicking one
 * opens its diff, the only thing left to look at once a file is gone. An
 * entry the host reports as gitignored is drawn dimmed for the same
 * reason: still there, never hidden, but visually out of the way.
 *
 * Every row has a "⋯" once there is a checkout: Download (a file as
 * itself, a folder as a zip of everything in it, ignored files too,
 * from …/code/projects/[id]/archive) for anyone who can see the tree;
 * `canEdit` adds New file (folders)/Rename/Delete
 * against …/code/projects/[id]/files (POST create, PATCH rename, DELETE
 * remove) — only once there is a checkout to edit (`source ===
 * 'checkout'`; before a clone the tree is the git host's own read-only
 * view, nothing here to change). Renaming or deleting the file open in
 * the pane needs the pane's own tab state updated too, so those two
 * ride up through `onRenamed`/`onDeleted` rather than being handled
 * here alone. The root-level "New file" action has no button of its
 * own here — the pane puts one inline with its "Files" heading instead
 * — so it rides a ref handle (`newFile()`) rather than a prop.
 *
 * With a checkout to edit the tree also takes drops. Files from the
 * desktop dropped on a folder (or on a file: its folder) land there,
 * sent through the app's upload queue (components/uploads) so the
 * title bar shows their progress; dropped anywhere else in the tree
 * they land at the root. A row dragged inside the tree moves: onto a
 * folder puts the file or folder in it, onto the root area puts it at
 * the top (PATCH …/files, the same move a rename is). Each lands as
 * the checkout's uncommitted change, like everything else here; the
 * folders concerned are read again and `onChanged` tells the pane to
 * refresh its marks.
 */

import { codeProjectUrl } from '@/lib/code/urls';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { Icon, ICONS } from '@/components/icons';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { LoadingLine } from '@/components/skeleton';
import Modal from '@/components/modal';
import { useOptionalUploadQueue } from '@/components/uploads/upload-queue';
import { DialogFooter } from '../../chat/_components/chat-nav';
import OverflowMenu from '../../chat/_components/overflow-menu';
import { checkoutSender } from './add-files-modal';

interface Entry {
  path: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  sizeBytes: number | null;
  ignored?: boolean;
}

type Listing =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; entries: Entry[] };

type Source = 'checkout' | 'bitbucket' | 'github';

/** How the working tree has a file: modified against HEAD, added (untracked), or gone. */
export type FileMark = 'M' | 'A' | 'D';

export interface RepoTreeHandle {
  /** Opens the "New file" dialog for the root folder — the pane's own
   * header button triggers this rather than rendering a button here. */
  newFile: () => void;
}

type Dialog =
  | { kind: 'new-file'; folder: string; name: string }
  | { kind: 'rename'; path: string; name: string };

/** The drag's own data type: a path inside this tree. */
const TREE_PATH_TYPE = 'application/x-renkei-tree-path';

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

/** The drag carries files from outside the page (the desktop, another app). */
function carriesFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files');
}

/** The drag carries a row of this tree. */
function carriesTreePath(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(TREE_PATH_TYPE);
}

/** `path` may move into `folder`: not into itself, under itself, or where it already is. */
export function canMoveInto(path: string, folder: string): boolean {
  if (folderOf(path) === folder) return false;
  if (folder === path || folder.startsWith(`${path}/`)) return false;
  return true;
}

const RepoTree = forwardRef<
  RepoTreeHandle,
  {
    projectId: string;
    /** A chat's worktree to show instead of the project's base clone. */
    chatId?: string | null;
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
    /** New file / rename / delete / drops, once there is a checkout to edit. */
    canEdit?: boolean;
    /** The open file was renamed — old path, new path. A folder's move
     * comes through too, with the folder's paths; the pane re-points
     * tabs under it. */
    onRenamed?: (from: string, to: string) => void;
    /** The open file was deleted. */
    onDeleted?: (path: string) => void;
    /** A ghost (deleted, uncommitted) row was clicked — there is nothing
     * left to open, so the pane shows its diff instead. */
    onDeletedClick?: (path: string) => void;
    /** The checkout changed from here (a drop, a move): the pane reads its marks again. */
    onChanged?: () => void;
  }
>(function RepoTree(
  {
    projectId,
    chatId = null,
    onOpen = null,
    selected = null,
    marks,
    refreshKey = 0,
    touch = false,
    canEdit = false,
    onRenamed,
    onDeleted,
    onDeletedClick,
    onChanged,
  },
  ref
) {
  const base = `${codeProjectUrl(projectId, chatId)}/tree`;
  const filesBase = `${codeProjectUrl(projectId, chatId)}/files`;
  const archiveBase = `${codeProjectUrl(projectId, chatId)}/archive`;
  const queue = useOptionalUploadQueue();
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [source, setSource] = useState<Source | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  /** The folder a drag is over ('' for the root), highlighted. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** The row being dragged inside the tree, while it is. */
  const [dragging, setDragging] = useState<{ path: string; kind: Entry['kind'] } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
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
      if (result.data) setSource(result.data.source);
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

  /** Shows a folder's contents, reading them if they were never read. */
  const reveal = useCallback(
    (folder: string) => {
      if (!folder) return;
      if (!openRef.current[folder]) setOpen((current) => ({ ...current, [folder]: true }));
      void load(folder, true);
    },
    [load]
  );

  const canWrite = canEdit && source === 'checkout';
  // A download is a read of the checkout: anyone who can see the tree may,
  // once there is a checkout (the git host's own view has no zip to give).
  const canDownload = source === 'checkout';
  const downloadItem = (path: string, kind: 'file' | 'dir') => ({
    label: kind === 'dir' ? 'Download as zip' : 'Download',
    icon: ICONS.download,
    href: `${archiveBase}?path=${encodeURIComponent(path)}`,
    filename: kind === 'dir' ? `${nameOf(path)}.zip` : nameOf(path),
  });

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

  useImperativeHandle(ref, () => ({ newFile: () => openNewFileDialog('') }));

  const submitDialog = async () => {
    if (!dialog) return;
    const trimmed = dialog.name.trim();
    if (!trimmed) {
      setDialogError(dialog.kind === 'new-file' ? 'Say what to call it.' : 'Say the new name.');
      return;
    }
    // The server rejects ".." too (validateWorkspacePath) — this is just
    // the immediate, no-round-trip version of the same rule.
    if (trimmed.split('/').some((part) => part === '..')) {
      setDialogError('A path cannot leave the workspace ("..").');
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

  /** Files from outside the page, dropped on `folder`: each lands at its name there. */
  const uploadInto = (folder: string, files: File[]) => {
    if (!queue || files.length === 0) return;
    queue.enqueue({
      title: `Add files to ${folder || 'the repository root'}`,
      destination: 'checkout',
      items: files.map((file) => {
        const path = folder ? `${folder}/${file.name}` : file.name;
        return { file, label: path, send: checkoutSender(filesBase, path) };
      }),
      onItem: (job) => {
        if (job.status !== 'done') return;
        if (folder) reveal(folder);
        else void load('', true);
        onChanged?.();
      },
    });
  };

  /** A row of the tree dropped on `folder`: moved there, under its own name. */
  const moveInto = async (path: string, kind: Entry['kind'], folder: string) => {
    if (!canMoveInto(path, folder)) return;
    const to = folder ? `${folder}/${nameOf(path)}` : nameOf(path);
    setMoveError(null);
    const result = await sendJsonFull<{ from: string; to: string }>(filesBase, 'PATCH', {
      from: path,
      to,
    });
    if (result.error) {
      setMoveError(`${nameOf(path)}: ${result.error}`);
      return;
    }
    void load(folderOf(path), true);
    if (folder) reveal(folder);
    else void load('', true);
    onRenamed?.(path, to);
    onChanged?.();
    void kind;
  };

  /** The drop handlers for a target folder ('' is the root). */
  const dropProps = (folder: string) => {
    if (!canWrite) return {};
    const accepts = (transfer: DataTransfer) =>
      carriesFiles(transfer) ||
      (carriesTreePath(transfer) && dragging !== null && canMoveInto(dragging.path, folder));
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!accepts(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = carriesFiles(event.dataTransfer) ? 'copy' : 'move';
        if (dropTarget !== folder) setDropTarget(folder);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        // Leaving for a child element is not leaving the target.
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related)) return;
        if (dropTarget === folder) setDropTarget(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const files = Array.from(event.dataTransfer.files);
        const path = event.dataTransfer.getData(TREE_PATH_TYPE) || dragging?.path || '';
        // A row let go over where it already is (or over itself) is not
        // this folder's drop: left alone, it reaches the box around the
        // tree, whose target is the root.
        if (files.length === 0 && (!path || !canMoveInto(path, folder))) return;
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(null);
        if (files.length > 0) {
          uploadInto(folder, files);
          return;
        }
        const kind = dragging?.kind ?? 'file';
        setDragging(null);
        void moveInto(path, kind, folder);
      },
    };
  };

  /** What makes a row draggable inside the tree. */
  const dragProps = (entry: Entry) => {
    if (!canWrite || (entry.kind !== 'file' && entry.kind !== 'dir')) return {};
    return {
      draggable: true,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.dataTransfer.setData(TREE_PATH_TYPE, entry.path);
        event.dataTransfer.setData('text/plain', entry.path);
        event.dataTransfer.effectAllowed = 'move';
        setDragging({ path: entry.path, kind: entry.kind });
      },
      onDragEnd: () => {
        setDragging(null);
        setDropTarget(null);
      },
    };
  };

  const rowClass = touch ? 'min-h-10 py-1.5' : 'py-0.5';
  const dropHighlight = 'bg-blue-50 ring-1 ring-inset ring-blue-500 dark:bg-blue-950/40';

  const renderGhost = (path: string, depth: number) => {
    const indent = { paddingLeft: `${depth * 12 + 4}px` };
    const body = (
      <>
        <span className="inline-block h-3 w-3 shrink-0" />
        <Icon path={ICONS.file} className="h-3.5 w-3.5 shrink-0 text-gray-300 dark:text-gray-700" />
        <span className="min-w-0 flex-1 truncate line-through">{nameOf(path)}</span>
        <span
          className="shrink-0 text-[10px] font-semibold text-red-500 dark:text-red-400"
          title="Deleted, not committed"
        >
          D
        </span>
      </>
    );
    if (onDeletedClick) {
      return (
        <li key={`ghost:${path}`}>
          <button
            type="button"
            onClick={() => onDeletedClick(path)}
            style={indent}
            title={`${path} — deleted, not committed. See its diff.`}
            className={`flex w-full items-center gap-1.5 rounded pr-2 text-left text-xs text-gray-400 hover:bg-gray-100 dark:text-gray-600 dark:hover:bg-gray-900 ${rowClass}`}
          >
            {body}
          </button>
        </li>
      );
    }
    return (
      <li
        key={`ghost:${path}`}
        style={indent}
        title={`${path} — deleted, not committed`}
        className={`flex items-center gap-1.5 pr-2 text-xs text-gray-400 dark:text-gray-600 ${rowClass}`}
      >
        {body}
      </li>
    );
  };

  const renderEntry = (entry: Entry, depth: number, inheritedIgnored: boolean) => {
    const name = nameOf(entry.path);
    const indent = { paddingLeft: `${depth * 12 + 4}px` };
    // A directory's own listing only reports its own children's ignored
    // status — an ignored ancestor's subtree, once expanded, is not
    // guaranteed to have every descendant re-flagged by the host's git
    // query. Inheriting from the parent here is what makes the whole
    // subtree read as ghosted, regardless of that per-directory quirk.
    const ignored = inheritedIgnored || entry.ignored === true;
    const dimmed = ignored ? 'opacity-50' : '';
    const beingDragged = dragging?.path === entry.path ? 'opacity-40' : '';

    if (entry.kind === 'dir') {
      const expanded = open[entry.path] === true;
      const isTarget = dropTarget === entry.path;
      const menu = canDownload ? (
        <OverflowMenu
          label={`More for ${name}`}
          anchored={false}
          compact
          items={[
            ...(canWrite
              ? [
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
                ]
              : []),
            downloadItem(entry.path, 'dir'),
            ...(canWrite
              ? [
                  {
                    label: 'Delete',
                    icon: ICONS.trash,
                    danger: true,
                    onSelect: () => void deleteEntry(entry.path, 'dir'),
                  },
                ]
              : []),
          ]}
        />
      ) : null;
      return (
        <li key={entry.path}>
          <div
            {...dropProps(entry.path)}
            {...dragProps(entry)}
            data-drop-target={isTarget ? 'true' : undefined}
            className={`flex w-full items-center gap-0.5 rounded pr-1 hover:bg-gray-100 dark:hover:bg-gray-900 ${rowClass} ${dimmed} ${beingDragged} ${isTarget ? dropHighlight : ''}`}
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
          {expanded ? <ul>{renderDir(entry.path, depth + 1, ignored)}</ul> : null}
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
    const menu =
      canDownload && entry.kind === 'file' ? (
        <OverflowMenu
          label={`More for ${name}`}
          anchored={false}
          compact
          items={[
            ...(canWrite
              ? [
                  {
                    label: 'Rename',
                    icon: ICONS.pencil,
                    onSelect: () => openRenameDialog(entry.path),
                  },
                ]
              : []),
            downloadItem(entry.path, 'file'),
            ...(canWrite
              ? [
                  {
                    label: 'Delete',
                    icon: ICONS.trash,
                    danger: true,
                    onSelect: () => void deleteEntry(entry.path, 'file'),
                  },
                ]
              : []),
          ]}
        />
      ) : null;
    // A drop on a file goes to the folder the file is in.
    const fileDrop = dropProps(folderOf(entry.path));

    if (onOpen && entry.kind === 'file') {
      return (
        <li key={entry.path}>
          <div
            {...fileDrop}
            {...dragProps(entry)}
            className={`flex w-full items-center gap-0.5 rounded pr-1 ${dimmed} ${beingDragged}`}
          >
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
        {...fileDrop}
        {...dragProps(entry)}
        className={`flex items-center gap-0.5 pr-1 text-xs text-gray-700 dark:text-gray-300 ${dimmed} ${beingDragged}`}
      >
        <span
          style={indent}
          className={`flex min-w-0 flex-1 items-center gap-1.5 ${rowClass}`}
          title={entry.path}
        >
          {body}
        </span>
        {menu}
      </li>
    );
  };

  const renderDir = (path: string, depth: number, inheritedIgnored = false) => {
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
        {listing.entries.map((entry) => renderEntry(entry, depth, inheritedIgnored))}
        {ghosts.map((path) => renderGhost(path, depth))}
      </>
    );
  };

  const rootIsTarget = dropTarget === '';

  return (
    <div
      {...dropProps('')}
      data-drop-target={rootIsTarget ? 'true' : undefined}
      // The root takes drops anywhere in the tree's box, including the
      // empty space under the last row.
      className={`min-h-16 rounded pb-4 ${rootIsTarget ? dropHighlight : ''}`}
    >
      <ul role="tree" aria-label="Files" className="font-mono">
        {renderDir('', 0)}
      </ul>
      {canWrite && dragging ? (
        <p className="px-2 pt-1 text-[11px] text-gray-500" role="status">
          Drop on a folder to move it there, or here for the top level.
        </p>
      ) : null}
      {moveError ? (
        <p role="alert" className="px-2 pt-1 text-xs text-red-600 dark:text-red-400">
          {moveError}
        </p>
      ) : null}
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
                setDialog((current) =>
                  current ? { ...current, name: event.target.value } : current
                )
              }
              maxLength={255}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            {dialog.kind === 'new-file' ? (
              <p className="text-xs text-gray-500">
                Missing folders in the path are created for you. End the name with “/” to create a
                folder instead of a file — e.g. “some_dir/”.
              </p>
            ) : null}
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
});

export default RepoTree;
