'use client';

/**
 * Share → folder drill-down over the tenant REST routes. Everything runs
 * on the caller's OWN stored credentials, so the file server decides what
 * succeeds; the controls are always offered and a refusal reads back as
 * the server's answer.
 *
 * The folder view is a small file manager: a button-trail path bar that
 * truncates from the left and flips into a typed address bar (traversal
 * spellings refused client-side, and again by every route), a client-side
 * name filter, sortable name/size/modified columns with a folders-first
 * preference (kept in localStorage), file-type icons, and a details modal
 * per file carrying the metadata the protocol reports (created, owner,
 * group — null where it has nothing to say). Below `sm` the table gives
 * way to cards.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getJson, sendJson } from '@/lib/fetch-json';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
const primaryButton =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const dangerButton =
  'rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50';
const secondaryButton =
  'rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-900';

interface ShareView {
  id: string;
  name: string;
  protocol: 'smb' | 'sftp';
  host: string;
  connection: { username: string } | null;
}

interface EntryView {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number | null;
  modifiedAt: string | null;
}

type ModalState =
  | null
  | { kind: 'newFolder' }
  | { kind: 'upload' }
  | { kind: 'details'; entry: EntryView }
  | { kind: 'rename'; entry: EntryView }
  | { kind: 'move'; entry: EntryView }
  | { kind: 'delete'; entry: EntryView };

const SHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods', 'numbers']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'doc', 'docx', 'rtf', 'odt', 'pdf', 'log']);
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'svg',
  'webp',
  'heic',
  'heif',
  'tif',
  'tiff',
]);

function iconFor(entry: EntryView): string {
  if (entry.kind === 'dir') return ICONS.folder;
  const dot = entry.name.lastIndexOf('.');
  const extension = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '';
  if (SHEET_EXTENSIONS.has(extension)) return ICONS.fileSheet;
  if (TEXT_EXTENSIONS.has(extension)) return ICONS.fileText;
  if (IMAGE_EXTENSIONS.has(extension)) return ICONS.fileImage;
  return ICONS.file;
}

function formatSize(size: number | null): string {
  if (size === null) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Fixed-width local timestamp: 2026-08-27 14:03. */
function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function childOf(folder: string, name: string): string {
  return folder === '/' ? `/${name}` : `${folder}/${name}`;
}

function fileUrl(tenantId: string, shareId: string, path: string): string {
  return `/api/tenant/${tenantId}/fileshares/${shareId}/file?path=${encodeURIComponent(path)}`;
}

type SortKey = 'name' | 'size' | 'modified';

const FOLDERS_FIRST_KEY = 'files:folders-first';

// ---------------------------------------------------------------------------
// The path bar: a button trail that truncates from the left, with a toggle
// into a typed address input. '.' and '..' are refused here for a clear
// message; every route re-validates regardless.
// ---------------------------------------------------------------------------

const VISIBLE_CRUMBS = 4;

function PathBar({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const [error, setError] = useState<string | null>(null);

  const crumbs = path === '/' ? [] : path.slice(1).split('/');
  const hidden = crumbs.length > VISIBLE_CRUMBS ? crumbs.length - VISIBLE_CRUMBS : 0;

  const chip =
    'rounded-md px-1.5 py-0.5 font-mono text-xs hover:bg-gray-100 dark:hover:bg-gray-800';

  const go = () => {
    const segments = draft
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .filter((segment) => segment !== '');
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      setError('Cannot use "." or ".." in a path.');
      return;
    }
    setEditing(false);
    setError(null);
    onNavigate(`/${segments.join('/')}`);
  };

  if (editing) {
    return (
      <form
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          go();
        }}
      >
        <span className="relative min-w-0 flex-1">
          <input
            autoFocus
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setEditing(false);
                setError(null);
              }
            }}
            aria-label="Path"
            className={`${inputClass} py-1 pr-16 font-mono text-xs ${
              error ? 'border-red-400 dark:border-red-700' : ''
            }`}
          />
          <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            <button
              type="submit"
              className="rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
            >
              Go
            </button>
            <button
              type="button"
              aria-label="Cancel path entry"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <Icon path={ICONS.close} className="h-3.5 w-3.5" />
            </button>
          </span>
          {error ? (
            // Anchored popover, not inline text: the toolbar row must not
            // reflow around a validation message.
            <span
              role="alert"
              className="absolute left-2 top-full z-30 mt-1 w-max rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-600 shadow-lg dark:border-red-900 dark:bg-gray-950 dark:text-red-400"
            >
              {error}
            </span>
          ) : null}
        </span>
      </form>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden rounded-md border border-gray-200 px-1 py-0.5 dark:border-gray-800">
      <button
        type="button"
        aria-label="Share root"
        onClick={() => onNavigate('/')}
        className={chip}
      >
        /
      </button>
      {hidden > 0 ? (
        <span className="flex items-center gap-0.5">
          <Icon path={ICONS.chevron} className="h-3 w-3 shrink-0 text-gray-400" />
          <button
            type="button"
            title="Up to the hidden folders"
            onClick={() => onNavigate('/' + crumbs.slice(0, hidden).join('/'))}
            className={chip}
          >
            ..
          </button>
        </span>
      ) : null}
      {crumbs.slice(hidden).map((crumb, index) => (
        <span key={`${crumb}-${hidden + index}`} className="flex min-w-0 items-center gap-0.5">
          <Icon path={ICONS.chevron} className="h-3 w-3 shrink-0 text-gray-400" />
          <button
            type="button"
            title={crumb}
            onClick={() => onNavigate('/' + crumbs.slice(0, hidden + index + 1).join('/'))}
            className={`${chip} max-w-40 truncate`}
          >
            {crumb}
          </button>
        </span>
      ))}
      <span className="flex-1" />
      <button
        type="button"
        aria-label="Type a path"
        title="Type a path"
        onClick={() => {
          setDraft(path);
          setEditing(true);
        }}
        className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      >
        <Icon path={ICONS.pencil} className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function FilesBrowser({ tenantId }: { tenantId: string }) {
  const [shares, setShares] = useState<ShareView[] | null>(null);
  const [share, setShare] = useState<ShareView | null>(null);
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<EntryView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [foldersFirst, setFoldersFirst] = useState(true);

  useEffect(() => {
    try {
      setFoldersFirst(window.localStorage.getItem(FOLDERS_FIRST_KEY) !== 'off');
    } catch {
      // Storage can be unavailable; the default stands.
    }
  }, []);

  const toggleFoldersFirst = () => {
    setFoldersFirst((current) => {
      try {
        window.localStorage.setItem(FOLDERS_FIRST_KEY, current ? 'off' : 'on');
      } catch {
        // Preference just won't stick.
      }
      return !current;
    });
  };

  useEffect(() => {
    void (async () => {
      const { data, error: loadError } = await getJson<{ shares: ShareView[] }>(
        `/api/tenant/${tenantId}/fileshares`
      );
      if (loadError) setError(loadError);
      else setShares(data?.shares ?? []);
    })();
  }, [tenantId]);

  const loadFolder = useCallback(
    async (target: ShareView, folderPath: string) => {
      setLoading(true);
      setError(null);
      const { data, error: loadError } = await getJson<{ entries: EntryView[] }>(
        `/api/tenant/${tenantId}/fileshares/${target.id}/folder?path=${encodeURIComponent(folderPath)}`
      );
      setLoading(false);
      if (loadError || !data) {
        setError(loadError ?? 'Could not open the folder');
        setEntries([]);
        return;
      }
      setEntries(data.entries);
    },
    [tenantId]
  );

  const open = (target: ShareView, folderPath: string) => {
    setShare(target);
    setPath(folderPath);
    setFilter('');
    void loadFolder(target, folderPath);
  };

  /** A modal finished its mutation: close it and re-read the folder. */
  const done = async () => {
    setModal(null);
    if (share) await loadFolder(share, path);
  };

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      : [...entries];
    filtered.sort((a, b) => {
      if (foldersFirst && a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      if (sortKey === 'size') {
        return ((a.size ?? -1) - (b.size ?? -1)) * sortDir;
      }
      if (sortKey === 'modified') {
        const at = a.modifiedAt ? Date.parse(a.modifiedAt) : 0;
        const bt = b.modifiedAt ? Date.parse(b.modifiedAt) : 0;
        return (at - bt) * sortDir;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * sortDir;
    });
    return filtered;
  }, [entries, filter, foldersFirst, sortKey, sortDir]);

  const sortBy = (key: SortKey) => {
    if (sortKey === key) setSortDir((current) => (current === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };

  const activate = (entry: EntryView) => {
    if (!share) return;
    if (entry.kind === 'dir') open(share, entry.path);
    else setModal({ kind: 'details', entry });
  };

  if (shares === null) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  }
  if (shares.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-400">
        No file shares are registered for this org yet. An administrator can add them under
        Organization → File shares.
      </p>
    );
  }

  if (!share) {
    return (
      <ul className="space-y-2">
        {shares.map((row) => (
          <li key={row.id} className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{row.name}</p>
                <p className="truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                  {row.protocol}://{row.host}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {row.connection ? (
                  <>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      connected as <span className="font-mono">{row.connection.username}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => open(row, '/')}
                      className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Open
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    not connected — add your credentials on the Connectors page
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      </ul>
    );
  }

  const headerButton = (label: string, key: SortKey, extra = '') => (
    <button
      type="button"
      onClick={() => sortBy(key)}
      className={`flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 ${extra}`}
    >
      {label}
      {sortKey === key ? <span aria-hidden>{sortDir === 1 ? '▲' : '▼'}</span> : null}
    </button>
  );

  const rowGrid = 'grid grid-cols-[minmax(0,1fr)_5.5rem_9.5rem_2.25rem] items-center gap-2';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm">
          <span className="font-medium">{share.name}</span>
          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
            as <span className="font-mono">{share.connection?.username}</span>
          </span>
        </p>
        <button
          type="button"
          onClick={() => {
            setShare(null);
            setEntries([]);
            setPath('/');
          }}
          className="shrink-0 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          All shares
        </button>
      </div>

      <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <PathBar path={path} onNavigate={(target) => open(share, target)} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon
              path={ICONS.search}
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
            />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter this folder"
              aria-label="Filter this folder"
              className={`${inputClass} py-1 pl-7 text-xs`}
            />
          </div>
          <button
            type="button"
            aria-pressed={foldersFirst}
            title={foldersFirst ? 'Folders first: on' : 'Folders first: off'}
            aria-label="Folders first"
            onClick={toggleFoldersFirst}
            className={`rounded-md border p-1.5 ${
              foldersFirst
                ? 'border-blue-300 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400'
                : 'border-gray-200 text-gray-400 hover:text-gray-600 dark:border-gray-800 dark:hover:text-gray-300'
            }`}
          >
            <Icon path={ICONS.folder} className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={loading}
            title="New folder"
            aria-label="New folder"
            onClick={() => setModal({ kind: 'newFolder' })}
            className="rounded-md border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.folderPlus} className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={loading}
            title="Upload file"
            aria-label="Upload file"
            onClick={() => setModal({ kind: 'upload' })}
            className="rounded-md border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.upload} className="h-4 w-4" />
          </button>
        </div>

        {error ? <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}

        {loading ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        ) : shown.length === 0 && !error ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            {entries.length === 0 ? 'This folder is empty.' : 'Nothing matches the filter.'}
          </p>
        ) : (
          <>
            {/* Desktop: a sortable table. */}
            <div className="mt-2 hidden sm:block">
              <div
                className={`${rowGrid} border-b border-gray-200 px-2 pb-1.5 dark:border-gray-800`}
              >
                {headerButton('Name', 'name')}
                {headerButton('Size', 'size', 'justify-end')}
                {headerButton('Modified', 'modified')}
                <span />
              </div>
              <ul className="divide-y divide-gray-100 dark:divide-gray-900">
                {shown.map((entry) => (
                  <li key={entry.path} className={`${rowGrid} px-2 py-0.5`}>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => activate(entry)}
                      className="flex min-w-0 items-center gap-2 rounded-md py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
                    >
                      <Icon
                        path={iconFor(entry)}
                        className={`h-4 w-4 shrink-0 ${
                          entry.kind === 'dir'
                            ? 'text-amber-500 dark:text-amber-400'
                            : 'text-gray-400 dark:text-gray-500'
                        }`}
                      />
                      <span className="min-w-0 truncate text-sm" title={entry.name}>
                        {entry.name}
                      </span>
                    </button>
                    <span className="text-right text-xs tabular-nums text-gray-500 dark:text-gray-400">
                      {entry.kind === 'dir' ? '' : formatSize(entry.size)}
                    </span>
                    <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                      {formatWhen(entry.modifiedAt)}
                    </span>
                    <EntryMenu
                      entry={entry}
                      disabled={loading}
                      onAction={(kind) => setModal({ kind, entry })}
                    />
                  </li>
                ))}
              </ul>
            </div>

            {/* Phone: cards. */}
            <ul className="mt-2 space-y-1.5 sm:hidden">
              {shown.map((entry) => (
                <li
                  key={entry.path}
                  className="flex items-center gap-2 rounded-md border border-gray-200 px-2 py-1 dark:border-gray-800"
                >
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => activate(entry)}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
                  >
                    <Icon
                      path={iconFor(entry)}
                      className={`h-5 w-5 shrink-0 ${
                        entry.kind === 'dir'
                          ? 'text-amber-500 dark:text-amber-400'
                          : 'text-gray-400 dark:text-gray-500'
                      }`}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm" title={entry.name}>
                        {entry.name}
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {entry.kind === 'dir'
                          ? 'Folder'
                          : `${formatSize(entry.size)} · ${formatWhen(entry.modifiedAt)}`}
                      </span>
                    </span>
                  </button>
                  <EntryMenu
                    entry={entry}
                    disabled={loading}
                    onAction={(kind) => setModal({ kind, entry })}
                  />
                </li>
              ))}
            </ul>
          </>
        )}

        {modal?.kind === 'newFolder' ? (
          <NewFolderModal
            tenantId={tenantId}
            share={share}
            path={path}
            onClose={() => setModal(null)}
            onDone={done}
          />
        ) : null}
        {modal?.kind === 'upload' ? (
          <UploadModal
            tenantId={tenantId}
            share={share}
            path={path}
            onClose={() => setModal(null)}
            onDone={done}
          />
        ) : null}
        {modal?.kind === 'details' ? (
          <DetailsModal
            tenantId={tenantId}
            share={share}
            entry={modal.entry}
            onClose={() => setModal(null)}
          />
        ) : null}
        {modal?.kind === 'rename' ? (
          <RenameModal
            tenantId={tenantId}
            share={share}
            entry={modal.entry}
            onClose={() => setModal(null)}
            onDone={done}
          />
        ) : null}
        {modal?.kind === 'move' ? (
          <MoveModal
            tenantId={tenantId}
            share={share}
            entry={modal.entry}
            path={path}
            onClose={() => setModal(null)}
            onDone={done}
          />
        ) : null}
        {modal?.kind === 'delete' ? (
          <DeleteModal
            tenantId={tenantId}
            share={share}
            entry={modal.entry}
            onClose={() => setModal(null)}
            onDone={done}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The per-row "⋯" menu: rename, move, delete — the server decides. */
function EntryMenu({
  entry,
  disabled,
  onAction,
}: {
  entry: EntryView;
  disabled: boolean;
  onAction: (kind: 'rename' | 'move' | 'delete') => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(menuOpen, ref, () => setMenuOpen(false));

  const item = (
    label: string,
    icon: string,
    kind: 'rename' | 'move' | 'delete',
    danger = false
  ) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setMenuOpen(false);
        onAction(kind);
      }}
      className={`flex items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 ${
        danger ? 'text-red-600 dark:text-red-400' : ''
      }`}
    >
      <Icon path={icon} className={`h-4 w-4 ${danger ? '' : 'text-gray-400'}`} />
      {label}
    </button>
  );

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Actions for ${entry.name}`}
        disabled={disabled}
        onClick={() => setMenuOpen((current) => !current)}
        className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      >
        <Icon path={ICONS.more} />
      </button>
      {menuOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 flex w-max flex-col rounded-md border border-gray-200 bg-white py-1 text-left shadow-lg dark:border-gray-700 dark:bg-gray-950"
        >
          {item('Rename', ICONS.pencil, 'rename')}
          {item('Move', ICONS.arrowRight, 'move')}
          {item('Delete', ICONS.trash, 'delete', true)}
        </div>
      ) : null}
    </div>
  );
}

function ModalFooter({ onClose, action }: { onClose: () => void; action: ReactNode }) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" onClick={onClose} className={secondaryButton}>
        Cancel
      </button>
      {action}
    </div>
  );
}

function NewFolderModal({
  tenantId,
  share,
  path,
  onClose,
  onDone,
}: {
  tenantId: string;
  share: ShareView;
  path: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const createError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/folders`,
      'POST',
      { path: childOf(path, name.trim()) }
    );
    setBusy(false);
    if (createError) {
      setError(createError);
      return;
    }
    await onDone();
  };

  return (
    <Modal title="New folder" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600 dark:text-gray-400">
            Folder name, created in <span className="font-mono">{path}</span>
          </span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
            placeholder="e.g. 2026-planning"
          />
        </label>
        {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <ModalFooter
          onClose={onClose}
          action={
            <button type="submit" disabled={!name.trim() || busy} className={primaryButton}>
              {busy ? 'Creating…' : 'Create folder'}
            </button>
          }
        />
      </form>
    </Modal>
  );
}

function UploadModal({
  tenantId,
  share,
  path,
  onClose,
  onDone,
}: {
  tenantId: string;
  share: ShareView;
  path: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(fileUrl(tenantId, share.id, childOf(path, file.name)), {
        method: 'PUT',
        body: file,
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String(Reflect.get(body, 'error'))
            : `Upload failed (${response.status})`;
        setError(message);
        setBusy(false);
        return;
      }
    } catch {
      setError('Upload failed');
      setBusy(false);
      return;
    }
    setBusy(false);
    await onDone();
  };

  return (
    <Modal title="Upload file" onClose={onClose}>
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const dropped = event.dataTransfer.files?.[0];
          if (dropped) setFile(dropped);
        }}
        className={`flex w-full flex-col items-center gap-1 rounded-md border-2 border-dashed px-4 py-8 text-sm text-gray-600 dark:text-gray-400 ${
          dragOver
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
            : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600'
        }`}
      >
        <span>Drag a file here</span>
        <span>
          or <span className="font-medium text-blue-600 dark:text-blue-400">browse</span>
        </span>
      </button>
      <input
        ref={fileInput}
        type="file"
        className="hidden"
        onChange={(event) => {
          const picked = event.target.files?.[0];
          if (picked) setFile(picked);
          event.target.value = '';
        }}
      />
      {file ? (
        <p className="mt-2 truncate text-sm">
          <span className="font-medium">{file.name}</span>
          <span className="ml-2 text-gray-500 dark:text-gray-400">{formatSize(file.size)}</span>
        </p>
      ) : null}
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Uploads to <span className="font-mono">{path}</span> on “{share.name}”.
      </p>
      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <ModalFooter
        onClose={onClose}
        action={
          <button
            type="button"
            disabled={!file || busy}
            onClick={() => void upload()}
            className={primaryButton}
          >
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        }
      />
    </Modal>
  );
}

interface EntryMeta {
  kind: 'file' | 'dir';
  size: number | null;
  modifiedAt: string | null;
  createdAt: string | null;
  owner: string | null;
  group: string | null;
}

/**
 * A file's details, fetched fresh (the listing carries only name, size and
 * mtime): created time, owner and group where the protocol reports them,
 * plus the download action. This is also the click target for files — the
 * download no longer fires on a bare row click.
 */
function DetailsModal({
  tenantId,
  share,
  entry,
  onClose,
}: {
  tenantId: string;
  share: ShareView;
  entry: EntryView;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<EntryMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data, error: loadError } = await getJson<EntryMeta>(
        `/api/tenant/${tenantId}/fileshares/${share.id}/entry?path=${encodeURIComponent(entry.path)}`
      );
      if (loadError || !data) setError(loadError ?? 'Could not read the details');
      else setMeta(data);
    })();
  }, [tenantId, share.id, entry.path]);

  const row = (label: string, value: ReactNode) => (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="min-w-0 flex-1 truncate">{value}</dd>
    </div>
  );

  return (
    <Modal title={entry.name} onClose={onClose}>
      <dl className="space-y-1 text-sm">
        {row('Path', <span className="font-mono text-xs leading-5">{entry.path}</span>)}
        {row('Type', entry.kind === 'dir' ? 'Folder' : 'File')}
        {row('Size', meta ? formatSize(meta.size) : formatSize(entry.size))}
        {row('Modified', formatWhen(meta ? meta.modifiedAt : entry.modifiedAt))}
        {row('Created', meta ? formatWhen(meta.createdAt) : '…')}
        {row('Owner', meta ? (meta.owner ?? '—') : '…')}
        {row('Group', meta ? (meta.group ?? '—') : '…')}
      </dl>
      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <ModalFooter
        onClose={onClose}
        action={
          entry.kind === 'file' ? (
            <a
              href={fileUrl(tenantId, share.id, entry.path)}
              onClick={onClose}
              className={primaryButton}
            >
              Download
            </a>
          ) : null
        }
      />
    </Modal>
  );
}

function RenameModal({
  tenantId,
  share,
  entry,
  onClose,
  onDone,
}: {
  tenantId: string;
  share: ShareView;
  entry: EntryView;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === entry.name) return;
    setBusy(true);
    setError(null);
    const opError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/entries`,
      'POST',
      { op: 'rename', from: entry.path, newName: trimmed }
    );
    setBusy(false);
    if (opError) {
      setError(opError);
      return;
    }
    await onDone();
  };

  return (
    <Modal title={`Rename ${entry.kind === 'dir' ? 'folder' : 'file'}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600 dark:text-gray-400">
            New name for <span className="font-medium">{entry.name}</span>
          </span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </label>
        {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <ModalFooter
          onClose={onClose}
          action={
            <button
              type="submit"
              disabled={!name.trim() || name.trim() === entry.name || busy}
              className={primaryButton}
            >
              {busy ? 'Renaming…' : 'Rename'}
            </button>
          }
        />
      </form>
    </Modal>
  );
}

function MoveModal({
  tenantId,
  share,
  entry,
  path,
  onClose,
  onDone,
}: {
  tenantId: string;
  share: ShareView;
  entry: EntryView;
  path: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [toFolder, setToFolder] = useState(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = async () => {
    const trimmed = toFolder.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const opError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/entries`,
      'POST',
      { op: 'move', from: entry.path, toFolder: trimmed }
    );
    setBusy(false);
    if (opError) {
      setError(opError);
      return;
    }
    await onDone();
  };

  return (
    <Modal title={`Move ${entry.kind === 'dir' ? 'folder' : 'file'}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void move();
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600 dark:text-gray-400">
            Move <span className="font-medium">{entry.name}</span> to which folder? (path from the
            share root)
          </span>
          <input
            autoFocus
            value={toFolder}
            onChange={(event) => setToFolder(event.target.value)}
            className={`${inputClass} font-mono`}
            placeholder="/archive"
          />
        </label>
        {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <ModalFooter
          onClose={onClose}
          action={
            <button type="submit" disabled={!toFolder.trim() || busy} className={primaryButton}>
              {busy ? 'Moving…' : 'Move'}
            </button>
          }
        />
      </form>
    </Modal>
  );
}

function DeleteModal({
  tenantId,
  share,
  entry,
  onClose,
  onDone,
}: {
  tenantId: string;
  share: ShareView;
  entry: EntryView;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const opError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/entries?path=${encodeURIComponent(entry.path)}`,
      'DELETE'
    );
    setBusy(false);
    if (opError) {
      setError(opError);
      return;
    }
    await onDone();
  };

  return (
    <Modal title={entry.kind === 'dir' ? 'Delete folder' : 'Delete file'} onClose={onClose}>
      <p className="text-sm">
        Delete <span className="font-mono">{entry.path}</span> permanently?
      </p>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        Deletion on the file server is permanent — there is no recycle bin.
        {entry.kind === 'dir' ? ' Only empty folders can be deleted.' : ''}
      </p>
      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <ModalFooter
        onClose={onClose}
        action={
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className={dangerButton}
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        }
      />
    </Modal>
  );
}
