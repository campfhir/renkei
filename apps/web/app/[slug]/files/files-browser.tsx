'use client';

/**
 * Share → folder drill-down over the tenant REST routes (the SitePicker
 * idiom: per-level loading/error/empty states, breadcrumb back-navigation).
 * Uploads and new folders appear only where the caller's effective access
 * is read/write — the buttons mirror the ACL, and the routes re-check it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, sendJson } from '@/lib/fetch-json';

const inputClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

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

export default function FilesBrowser({ tenantId }: { tenantId: string }) {
  const [shares, setShares] = useState<ShareView[] | null>(null);
  const [share, setShare] = useState<ShareView | null>(null);
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<EntryView[]>([]);
  const [canWriteHere, setCanWriteHere] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

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

  const createFolder = async () => {
    if (!share || !newFolder.trim()) return;
    const target = path === '/' ? `/${newFolder.trim()}` : `${path}/${newFolder.trim()}`;
    const createError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/folders`,
      'POST',
      { path: target }
    );
    if (createError) {
      setError(createError);
      return;
    }
    setNewFolder('');
    await loadFolder(share, path);
  };

  const upload = async (file: File) => {
    if (!share) return;
    const target = path === '/' ? `/${file.name}` : `${path}/${file.name}`;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/tenant/${tenantId}/fileshares/${share.id}/file?path=${encodeURIComponent(target)}`,
        { method: 'PUT', body: file }
      );
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String(Reflect.get(body, 'error'))
            : `Upload failed (${response.status})`;
        setError(message);
      }
    } catch {
      setError('Upload failed');
    }
    setLoading(false);
    await loadFolder(share, path);
  };

  const renameEntry = async (entry: EntryView) => {
    if (!share) return;
    const newName = window.prompt(`New name for ${entry.name}:`, entry.name)?.trim();
    if (!newName || newName === entry.name) return;
    const opError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/entries`,
      'POST',
      { op: 'rename', from: entry.path, newName }
    );
    if (opError) setError(opError);
    await loadFolder(share, path);
  };

  const moveEntry = async (entry: EntryView) => {
    if (!share) return;
    const toFolder = window
      .prompt(`Move ${entry.name} to which folder? (path from the share root)`, path)
      ?.trim();
    if (toFolder === undefined || toFolder === null || toFolder === '') return;
    const opError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/entries`,
      'POST',
      { op: 'move', from: entry.path, toFolder }
    );
    if (opError) setError(opError);
    await loadFolder(share, path);
  };

  const deleteEntry = async (entry: EntryView) => {
    if (!share) return;
    const what = entry.kind === 'dir' ? 'folder (must be empty)' : 'file';
    if (!window.confirm(`Delete this ${what} permanently? ${entry.path}`)) return;
    const opError = await sendJson(
      `/api/tenant/${tenantId}/fileshares/${share.id}/entries?path=${encodeURIComponent(entry.path)}`,
      'DELETE'
    );
    if (opError) setError(opError);
    await loadFolder(share, path);
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

      {loading ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : entries.length === 0 && !error ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Nothing you can access in this folder.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-900">
          {entries.map((entry) => (
            <li key={entry.path} className="flex items-center justify-between gap-2 py-1.5">
              <div className="min-w-0 flex-1">
                {entry.kind === 'dir' ? (
                  <button
                    type="button"
                    onClick={() => open(share, entry.path)}
                    className="truncate text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {entry.name}/
                  </button>
                ) : entry.access !== 'traverse' ? (
                  <a
                    href={`/api/tenant/${tenantId}/fileshares/${share.id}/file?path=${encodeURIComponent(entry.path)}`}
                    className="truncate text-sm hover:underline"
                  >
                    {entry.name}
                  </a>
                ) : (
                  <span className="truncate text-sm">{entry.name}</span>
                )}
              </div>
              <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                {formatSize(entry.size)}
              </span>
              <span className="shrink-0 rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
                {ACCESS_BADGE[entry.access]}
              </span>
              {entry.access === 'read_write' ? (
                <span className="flex shrink-0 gap-2 text-xs">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void renameEntry(entry)}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void moveEntry(entry)}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Move
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void deleteEntry(entry)}
                    className="text-red-600 hover:underline dark:text-red-400"
                  >
                    Delete
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWriteHere ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => fileInput.current?.click()}
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Upload file
          </button>
          <span className="text-gray-300 dark:text-gray-700">·</span>
          <input
            aria-label="New folder name"
            className={inputClass}
            placeholder="New folder name"
            value={newFolder}
            onChange={(event) => setNewFolder(event.target.value)}
          />
          <button
            type="button"
            disabled={loading || !newFolder.trim()}
            onClick={() => void createFolder()}
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Create folder
          </button>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
