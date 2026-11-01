'use client';

/**
 * Edit one ADManager Plus instance's connection details — no credentials
 * here: people connect the instance with their own authtoken from the
 * connectors page, which is also where a credential gets proven against
 * the live server. The reachability test here is unauthenticated.
 */

import { useCallback, useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';
import InstanceConfigFields from '../instance-config-fields';
import { draftPayload, probeBody, type ProbeResponse } from '../instance-list.model';
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';
import {
  DELETE_CONFIRMATION,
  initialInstanceForm,
  instanceFormReducer,
  type StoredInstance,
} from './instance-config-form.model';

export default function InstanceConfigForm({ instanceId }: { instanceId: string }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(instanceFormReducer, initialInstanceForm);
  const { draft, busy, status, insecure } = state;

  const load = useCallback(async () => {
    const { data, error } = await getJson<{ instance: StoredInstance }>(
      `/api/admin/admanager/${instanceId}`
    );
    if (error || !data) {
      dispatch({ type: 'load-failed', error: error ?? 'Could not load the instance' });
      return;
    }
    dispatch({ type: 'loaded', instance: data.instance });
  }, [instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!draft) {
    return (
      <LoadingRegion label="Loading instance settings…">
        <SkeletonForm fields={5} />
      </LoadingRegion>
    );
  }

  const save = async () => {
    dispatch({ type: 'sent' });
    const error = await sendJson(
      `/api/admin/admanager/${instanceId}`,
      'PATCH',
      draftPayload(draft)
    );
    if (error) {
      dispatch({ type: 'failed', error });
      return;
    }
    dispatch({ type: 'saved' });
    router.refresh();
    await load();
  };

  const test = async () => {
    dispatch({ type: 'sent' });
    const { data, error } = await sendJsonFull<ProbeResponse>(
      `/api/admin/admanager/probe`,
      'POST',
      probeBody(draft)
    );
    if (error || !data) {
      dispatch({ type: 'failed', error: error ?? 'The test did not answer.' });
      return;
    }
    dispatch({ type: 'tested', probe: data });
  };

  const remove = async () => {
    if (!window.confirm(DELETE_CONFIRMATION)) return;
    dispatch({ type: 'sent' });
    const error = await sendJson(`/api/admin/admanager/${instanceId}`, 'DELETE');
    if (error) {
      dispatch({ type: 'failed', error });
      return;
    }
    router.push(`/admin/admanager`);
  };

  return (
    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
      {insecure.length ? (
        <p
          role="alert"
          data-testid="insecure-transport-banner"
          className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <strong>Transport security is off for this instance</strong> ({insecure.join(', ')}):
          credentials and data travel where an intercepting party on the path could read them.
          Allowed only because this is a non-production instance on a private network; turn the
          protection back on as soon as the server supports it.
        </p>
      ) : null}
      <InstanceConfigFields draft={draft} onChange={(patch) => dispatch({ type: 'edit', patch })} />
      <label className="mt-3 flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => dispatch({ type: 'edit', patch: { enabled: event.target.checked } })}
        />
        Enabled — disabling hides the instance from everyone immediately
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
          onClick={() => void test()}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {busy ? 'Working…' : 'Test reachability'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void remove()}
          className="ml-auto rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
        >
          Delete instance
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
