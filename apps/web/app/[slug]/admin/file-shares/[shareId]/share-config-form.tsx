'use client';

/**
 * Edit one share's connection details — no credentials here: people
 * connect the share with their own account from the connectors page, which
 * is also where a connection gets proven against the live server.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getJson, sendJson } from '@/lib/fetch-json';
import ShareConfigFields, { draftPayload, emptyDraft } from '../share-config-fields';
import type { ShareDraft } from '../share-config-fields';

interface ShareResponse {
  share: {
    id: string;
    name: string;
    protocol: 'smb' | 'sftp';
    host: string;
    port: number | null;
    shareName: string | null;
    rootPath: string;
    caseInsensitive: boolean;
    enabled: boolean;
  };
}

export default function ShareConfigForm({ slug, shareId }: { slug: string; shareId: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<ShareDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await getJson<ShareResponse>(
      `/api/admin/${slug}/file-shares/${shareId}`
    );
    if (error || !data) {
      setStatus({ kind: 'error', text: error ?? 'Could not load the share' });
      return;
    }
    setDraft({
      ...emptyDraft(),
      name: data.share.name,
      protocol: data.share.protocol,
      host: data.share.host,
      port: data.share.port === null ? '' : String(data.share.port),
      shareName: data.share.shareName ?? '',
      rootPath: data.share.rootPath,
      caseInsensitive: data.share.caseInsensitive,
      enabled: data.share.enabled,
    });
  }, [slug, shareId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!draft) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  }

  const save = async () => {
    setBusy(true);
    setStatus(null);
    const error = await sendJson(
      `/api/admin/${slug}/file-shares/${shareId}`,
      'PATCH',
      draftPayload(draft)
    );
    setBusy(false);
    if (error) {
      setStatus({ kind: 'error', text: error });
      return;
    }
    setStatus({ kind: 'ok', text: 'Saved.' });
    router.refresh();
    await load();
  };

  const remove = async () => {
    if (!window.confirm("Delete this share? Everyone's stored connections to it go with it."))
      return;
    setBusy(true);
    const error = await sendJson(`/api/admin/${slug}/file-shares/${shareId}`, 'DELETE');
    setBusy(false);
    if (error) {
      setStatus({ kind: 'error', text: error });
      return;
    }
    router.push(`/${slug}/admin/file-shares`);
  };

  return (
    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
      <ShareConfigFields draft={draft} onChange={setDraft} />
      <label className="mt-3 flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        Enabled — disabling hides the share from everyone immediately
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void remove()}
          className="ml-auto rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
        >
          Delete share
        </button>
      </div>
      {status ? (
        <p
          className={`mt-2 text-sm ${status.kind === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
        >
          {status.text}
        </p>
      ) : null}
    </div>
  );
}
