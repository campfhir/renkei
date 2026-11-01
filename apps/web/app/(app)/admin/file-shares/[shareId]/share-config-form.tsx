'use client';

/**
 * Edit one share's connection details — no credentials here: people
 * connect the share with their own account from the connectors page, which
 * is also where a connection gets proven against the live server.
 */

import { useCallback, useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { getJson, sendJson } from '@/lib/fetch-json';
import ShareConfigFields from '../share-config-fields';
import { draftPayload } from '../share-config-fields.model';
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';
import {
  DELETE_CONFIRMATION,
  hostKeyStatus,
  initialShareForm,
  shareFormReducer,
  type StoredShare,
} from './share-config-form.model';

export default function ShareConfigForm({ shareId }: { shareId: string }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(shareFormReducer, initialShareForm);
  const { draft, busy, status } = state;
  const hostKey = hostKeyStatus(state);

  const load = useCallback(async () => {
    const { data, error } = await getJson<{ share: StoredShare }>(
      `/api/admin/file-shares/${shareId}`
    );
    if (error || !data) {
      dispatch({ type: 'load-failed', error: error ?? 'Could not load the share' });
      return;
    }
    dispatch({ type: 'loaded', share: data.share });
  }, [shareId]);

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
    dispatch({ type: 'sent' });
    const error = await sendJson(`/api/admin/file-shares/${shareId}`, 'PATCH', draftPayload(draft));
    if (error) {
      dispatch({ type: 'failed', error });
      return;
    }
    dispatch({ type: 'saved' });
    router.refresh();
    await load();
  };

  const remove = async () => {
    if (!window.confirm(DELETE_CONFIRMATION)) return;
    dispatch({ type: 'sent' });
    const error = await sendJson(`/api/admin/file-shares/${shareId}`, 'DELETE');
    if (error) {
      dispatch({ type: 'failed', error });
      return;
    }
    router.push(`/admin/file-shares`);
  };

  return (
    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
      {hostKey ? (
        <p
          data-testid="host-key-status"
          className={`mb-3 rounded-md border px-3 py-2 text-sm ${
            hostKey.kind === 'on-file'
              ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300'
              : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300'
          }`}
        >
          {hostKey.kind === 'on-file' ? (
            <>
              SSH host key on file: <code className="font-mono">{hostKey.fingerprint}</code>. Every
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
      <ShareConfigFields draft={draft} onChange={(patch) => dispatch({ type: 'edit', patch })} />
      <label className="mt-3 flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => dispatch({ type: 'edit', patch: { enabled: event.target.checked } })}
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
