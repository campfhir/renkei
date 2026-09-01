'use client';

/**
 * Browse a share and pick ONE folder — the same
 * /api/tenant/[tenantId]/fileshares/[shareId]/folder route the full file
 * manager (files-browser.tsx) uses, filtered client-side to directories.
 * That component is one large, tightly coupled file manager (upload,
 * rename, move, delete, sort) with nothing separately importable for "just
 * browse and pick," so this is a small purpose-built sibling rather than a
 * slice of it — replaces the free-text path input a batch's folder used to
 * need typed by hand.
 *
 * A batch's config carries one folder path (`document-ocr-pipeline`'s
 * `discover` lists it non-recursively), so this picks a single folder, not
 * a multi-select — starting more than one folder is two batches today.
 */

import { useEffect, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { getJson } from '@/lib/fetch-json';

interface EntryView {
  name: string;
  path: string;
  kind: 'file' | 'dir';
}

const primaryButton =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const secondaryButton =
  'rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-900';

interface Crumb {
  name: string;
  path: string;
}

function crumbsOf(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ name: 'Root', path: '/' }];
  if (path === '/' || !path) return crumbs;
  let acc = '';
  for (const part of path.split('/').filter(Boolean)) {
    acc += `/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

export default function FolderPicker({
  tenantId,
  shareId,
  shareName,
  initialPath,
  onCancel,
  onSelect,
}: {
  tenantId: string;
  shareId: string;
  shareName: string;
  initialPath: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}) {
  const [path, setPath] = useState(initialPath || '/');
  const [folders, setFolders] = useState<EntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFolders(null);
    setError(null);
    void (async () => {
      const { data, error: fetchError } = await getJson<{ entries: EntryView[] }>(
        `/api/tenant/${tenantId}/fileshares/${shareId}/folder?path=${encodeURIComponent(path)}`
      );
      if (cancelled) return;
      if (fetchError) {
        setError(fetchError);
        return;
      }
      setFolders((data?.entries ?? []).filter((entry) => entry.kind === 'dir'));
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, shareId, path]);

  const crumbs = crumbsOf(path);

  return (
    <Modal title={`Choose a folder in "${shareName}"`} onClose={onCancel}>
      <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPath(crumb.path)}
              className={
                index === crumbs.length - 1
                  ? 'font-medium'
                  : 'text-blue-600 hover:underline dark:text-blue-400'
              }
            >
              {crumb.name}
            </button>
            {index < crumbs.length - 1 ? <span className="text-gray-400">/</span> : null}
          </span>
        ))}
      </div>

      {error ? (
        <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
      ) : folders === null ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : folders.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No subfolders here.</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {folders.map((folder) => (
            <li key={folder.path}>
              <button
                type="button"
                onClick={() => setPath(folder.path)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <Icon path={ICONS.folder} className="h-4 w-4 shrink-0 text-gray-400" />
                <span className="truncate">{folder.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
        <p className="min-w-0 truncate font-mono text-xs text-gray-500 dark:text-gray-400" title={path}>
          {path}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={onCancel} className={secondaryButton}>
            Cancel
          </button>
          <button type="button" onClick={() => onSelect(path)} className={primaryButton}>
            Use this folder
          </button>
        </div>
      </div>
    </Modal>
  );
}
