'use client';

/**
 * Share → folder drill-down over the tenant REST routes (the SitePicker
 * idiom: per-level loading/error/empty states, breadcrumb back-navigation).
 * Rows are fully clickable — a folder opens, a file asks before
 * downloading — and every mutation (new folder, upload, rename, move,
 * delete) runs through a modal that shows its own errors. Write controls
 * appear only where the caller's effective access is read/write — the
 * buttons mirror the ACL, and the routes re-check it.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
  defaultAccess: 'none' | 'read' | 'read_write';
  hasRules: boolean;
  hasCredentials: boolean;
}

interface EntryView {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number | null;
  modifiedAt: string | null;
  access: 'read' | 'read_write' | 'traverse';
}

type ModalState =
  | null
  | { kind: 'newFolder' }
  | { kind: 'upload' }
  | { kind: 'download'; entry: EntryView }
  | { kind: 'rename'; entry: EntryView }
  | { kind: 'move'; entry: EntryView }
  | { kind: 'delete'; entry: EntryView };

const ACCESS_BADGE: Record<EntryView['access'], string> = {
  read: 'read',
  read_write: 'read/write',
  traverse: 'folders below',
};

function formatSize(size: number | null): string {
  if (size === null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function childOf(folder: string, name: string): string {
  return folder === '/' ? `/${name}` : `${folder}/${name}`;
}

function fileUrl(tenantId: string, shareId: string, path: string): string {
  return `/api/tenant/${tenantId}/fileshares/${shareId}/file?path=${encodeURIComponent(path)}`;
}

export default function FilesBrowser({ tenantId }: { tenantId: string }) {
  const [shares, setShares] = useState<ShareView[] | null>(null);
  const [share, setShare] = useState<ShareView | null>(null);
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<EntryView[]>([]);
  const [canWriteHere, setCanWriteHere] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

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
      const { data, error: loadError } = await getJson<{
        entries: EntryView[];
        access: 'none' | 'read' | 'read_write';
      }>(
        `/api/tenant/${tenantId}/fileshares/${target.id}/folder?path=${encodeURIComponent(folderPath)}`
      );
      setLoading(false);
      if (loadError || !data) {
        setError(loadError ?? 'Could not open the folder');
        setEntries([]);
        setCanWriteHere(false);
        return;
      }
      setEntries(data.entries);
      setCanWriteHere(data.access === 'read_write');
    },
    [tenantId]
  );

  const open = (target: ShareView, folderPath: string) => {
    setShare(target);
    setPath(folderPath);
    void loadFolder(target, folderPath);
  };

  /** A modal finished its mutation: close it and re-read the folder. */
  const done = async () => {
    setModal(null);
    if (share) await loadFolder(share, path);
  };

  if (shares === null) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  }
  if (shares.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-400">
        You have not been granted access to any file shares. An administrator can grant it under
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
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {row.defaultAccess === 'none'
                    ? 'specific folders'
                    : row.defaultAccess === 'read_write'
                      ? 'read/write'
                      : 'read'}
                  {row.hasRules ? ' · rules apply' : ''}
                </span>
                <button
                  type="button"
                  onClick={() => open(row, '/')}
                  className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Open
                </button>
              </div>
            </div>
          </li>
        ))}
        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      </ul>
    );
  }

  const crumbs = path === '/' ? [] : path.slice(1).split('/');

  return (
    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <button
          type="button"
          onClick={() => {
            setShare(null);
            setEntries([]);
            setPath('/');
          }}
          className="mr-1 text-blue-600 hover:underline dark:text-blue-400"
        >
          ← Shares
        </button>
        <span className="font-medium">{share.name}</span>
        <button
          type="button"
          onClick={() => open(share, '/')}
          className="ml-1 font-mono text-blue-600 hover:underline dark:text-blue-400"
        >
          /
        </button>
        {crumbs.map((crumb, index) => (
          <span key={`${crumb}-${index}`} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => open(share, '/' + crumbs.slice(0, index + 1).join('/'))}
              className="font-mono text-blue-600 hover:underline dark:text-blue-400"
            >
              {crumb}
            </button>
            {index < crumbs.length - 1 ? <span className="text-gray-400">/</span> : null}
          </span>
        ))}
      </div>

      {error ? <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      {loading ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : entries.length === 0 && !error ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Nothing you can access in this folder.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-900">
          {entries.map((entry) => (
            <li key={entry.path} className="flex items-center gap-1 py-0.5">
              <button
                type="button"
                disabled={loading || (entry.kind === 'file' && entry.access === 'traverse')}
                onClick={() =>
                  entry.kind === 'dir'
                    ? open(share, entry.path)
                    : setModal({ kind: 'download', entry })
                }
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-gray-900"
              >
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${
                    entry.kind === 'dir' ? 'font-medium text-blue-600 dark:text-blue-400' : ''
                  }`}
                >
                  {entry.name}
                  {entry.kind === 'dir' ? '/' : ''}
                </span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                  {formatSize(entry.size)}
                </span>
                <span className="shrink-0 rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
                  {ACCESS_BADGE[entry.access]}
                </span>
              </button>
              {entry.access === 'read_write' ? (
                <EntryMenu
                  entry={entry}
                  disabled={loading}
                  onAction={(kind) => setModal({ kind, entry })}
                />
              ) : (
                // Keeps rows with and without a menu aligned.
                <span className="w-7 shrink-0" />
              )}
            </li>
          ))}
        </ul>
      )}

      {canWriteHere ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
          <button
            type="button"
            disabled={loading}
            onClick={() => setModal({ kind: 'upload' })}
            className={secondaryButton}
          >
            Upload file
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => setModal({ kind: 'newFolder' })}
            className={secondaryButton}
          >
            New folder
          </button>
        </div>
      ) : null}

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
      {modal?.kind === 'download' ? (
        <DownloadModal
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
  );
}

/** The per-row "⋯" menu: rename, move, delete — only rendered at read/write. */
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

  const item = (label: string, kind: 'rename' | 'move' | 'delete', danger = false) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setMenuOpen(false);
        onAction(kind);
      }}
      className={`whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 ${
        danger ? 'text-red-600 dark:text-red-400' : ''
      }`}
    >
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
          {item('Rename', 'rename')}
          {item('Move', 'move')}
          {item('Delete', 'delete', true)}
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

function DownloadModal({
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
  return (
    <Modal title="Download file" onClose={onClose}>
      <p className="truncate text-sm font-medium">{entry.name}</p>
      <dl className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0">Path</dt>
          <dd className="min-w-0 truncate font-mono text-xs leading-5">{entry.path}</dd>
        </div>
        {entry.size !== null ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0">Size</dt>
            <dd>{formatSize(entry.size)}</dd>
          </div>
        ) : null}
        {entry.modifiedAt ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0">Modified</dt>
            <dd>{new Date(entry.modifiedAt).toLocaleString()}</dd>
          </div>
        ) : null}
      </dl>
      <ModalFooter
        onClose={onClose}
        action={
          <a
            href={fileUrl(tenantId, share.id, entry.path)}
            onClick={onClose}
            className={primaryButton}
          >
            Download
          </a>
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
            New name for <span className="font-mono">{entry.path}</span>
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
            Move <span className="font-mono">{entry.path}</span> to which folder? (path from the
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
    <Modal
      title={entry.kind === 'dir' ? 'Delete folder' : 'Delete file'}
      onClose={onClose}
    >
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
          <button type="button" disabled={busy} onClick={() => void remove()} className={dangerButton}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        }
      />
    </Modal>
  );
}
