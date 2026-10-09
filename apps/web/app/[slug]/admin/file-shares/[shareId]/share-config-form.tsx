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
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';

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
    hostKeyFingerprint: string | null;
  };
}

export default function ShareConfigForm({ slug, shareId }: { slug: string; shareId: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<ShareDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  /** What the server has on file — shown so an admin can confirm a key recorded on first use. */
  const [recordedHostKey, setRecordedHostKey] = useState<string | null>(null);

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
      hostKeyFingerprint: data.share.hostKeyFingerprint ?? '',
    });
    setRecordedHostKey(data.share.hostKeyFingerprint);
  }, [slug, shareId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!draft) {
    return (
      <LoadingRegion label="Loading share settings…">
        <SkeletonForm fields={5} />
      </LoadingRegion>
    );
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
      {draft.protocol === 'sftp' ? (
        <p
          data-testid="host-key-status"
          className={`mb-3 rounded-md border px-3 py-2 text-sm ${
            recordedHostKey
              ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300'
              : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300'
          }`}
        >
          {recordedHostKey ? (
            <>
              SSH host key on file: <code className="font-mono">{recordedHostKey}</code>. Every
              connection is refused unless the server presents this key. Confirm it matches{' '}
              <code>ssh-keygen -lf</code> on the server, or replace it below after a key rotation.
            </>
          ) : (
            <>
              No SSH host key on file yet: the key the server presents on the first successful
              connection will be recorded here. Pin it below now to refuse any other key from the
              start.
            </>
          )}
        </p>
      ) : null}
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
