'use client';

/**
 * Share registry list plus one draft form for creation — the rule-forms
 * shape. Editing an existing share happens on its own page (the drill-down
 * rules editor needs the room), so the draft here only ever creates.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getJson, sendJson } from '@/lib/fetch-json';
import ShareConfigFields, { draftPayload, emptyDraft } from './share-config-fields';
import type { ShareDraft } from './share-config-fields';

interface ShareRow {
  id: string;
  name: string;
  protocol: 'smb' | 'sftp';
  host: string;
  shareName: string | null;
  rootPath: string;
  maxAccess: 'read' | 'read_write';
  enabled: boolean;
  hasCredentials: boolean;
}

function targetOf(share: ShareRow): string {
  return share.protocol === 'smb'
    ? `\\\\${share.host}\\${share.shareName ?? ''}${share.rootPath === '/' ? '' : share.rootPath.replace(/\//g, '\\')}`
    : `sftp://${share.host}${share.rootPath}`;
}

export default function ShareList({ slug }: { slug: string }) {
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [draft, setDraft] = useState<ShareDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ shares: ShareRow[] }>(
      `/api/admin/${slug}/file-shares`
    );
    if (loadError) setError(loadError);
    else setShares(data?.shares ?? []);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const saveError = await sendJson(`/api/admin/${slug}/file-shares`, 'POST', draftPayload(draft));
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setDraft(null);
    await load();
  };

  return (
    <div className="space-y-4">
      {shares.length === 0 && !draft ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">No shares registered yet.</p>
      ) : null}

      <ul className="space-y-2">
        {shares.map((share) => (
          <li key={share.id} className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {share.name}
                  {!share.enabled ? (
                    <span className="ml-2 rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                      disabled
                    </span>
                  ) : null}
                  {!share.hasCredentials ? (
                    <span className="ml-2 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      no credentials
                    </span>
                  ) : null}
                </p>
                <p className="mt-1 truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                  {targetOf(share)}
                </p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Ceiling: {share.maxAccess === 'read_write' ? 'read/write' : 'read only'}
                </p>
              </div>
              <Link
                href={`/${slug}/admin/file-shares/${share.id}`}
                className="shrink-0 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Manage
              </Link>
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <p className="mb-3 text-sm font-medium">New share</p>
          <ShareConfigFields draft={draft} onChange={setDraft} hasStoredCredentials={false} />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || !draft.name.trim() || !draft.host.trim()}
              onClick={() => void create()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Create share
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setDraft(emptyDraft())}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + New share
        </button>
      )}

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
