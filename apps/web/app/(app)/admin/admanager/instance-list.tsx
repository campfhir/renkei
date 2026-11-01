'use client';

/**
 * ADManager Plus instance registry list plus one draft form for creation,
 * with a reachability test that runs BEFORE anything is saved. Editing
 * an existing instance happens on its own page; the draft here only ever
 * creates.
 */

import { useCallback, useEffect, useReducer } from 'react';
import Link from 'next/link';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';
import InstanceConfigFields from './instance-config-fields';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import {
  canCreate,
  canTest,
  draftPayload,
  initialInstanceList,
  instanceListReducer,
  probeBody,
  showsEmpty,
  type InstanceRow,
  type ProbeResponse,
} from './instance-list.model';

export default function InstanceList() {
  const [state, dispatch] = useReducer(instanceListReducer, initialInstanceList);
  const { instances, draft, busy, error, probe } = state;

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ instances: InstanceRow[] }>(
      `/api/admin/admanager`
    );
    if (loadError) dispatch({ type: 'load-failed', error: loadError });
    else dispatch({ type: 'loaded', instances: data?.instances ?? [] });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const test = async () => {
    if (!draft) return;
    dispatch({ type: 'testing' });
    const { data, error: probeError } = await sendJsonFull<ProbeResponse>(
      `/api/admin/admanager/probe`,
      'POST',
      probeBody(draft)
    );
    if (probeError || !data) {
      dispatch({ type: 'test-failed', error: probeError ?? 'The test did not answer.' });
      return;
    }
    dispatch({ type: 'tested', probe: data });
  };

  const create = async () => {
    if (!draft) return;
    dispatch({ type: 'creating' });
    const saveError = await sendJson(`/api/admin/admanager`, 'POST', draftPayload(draft));
    if (saveError) {
      dispatch({ type: 'create-failed', error: saveError });
      return;
    }
    dispatch({ type: 'created' });
    await load();
  };

  const listAnchor = useCoachAnchor('admin-admanager-list');
  const newAnchor = useCoachAnchor('admin-admanager-new');

  return (
    <div className="space-y-4">
      {/* The tour's anchor covers the note too, so the step has a target while the list is empty. */}
      <div {...listAnchor} className="space-y-4">
        {showsEmpty(state) ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">No instances registered yet.</p>
        ) : null}

        <ul className="space-y-2">
          {instances.map((instance) => (
            <li
              key={instance.id}
              className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {instance.name}
                    <span className="ml-2 rounded-full border border-gray-300 px-2 py-0.5 text-xs font-normal text-gray-600 dark:border-gray-700 dark:text-gray-400">
                      {instance.environment}
                    </span>
                    {!instance.enabled ? (
                      <span className="ml-2 rounded-full border border-gray-300 px-2 py-0.5 text-xs font-normal text-gray-500 dark:border-gray-700 dark:text-gray-400">
                        disabled
                      </span>
                    ) : null}
                    {!instance.tlsVerify ? (
                      <span className="ml-2 rounded-full border border-amber-300 px-2 py-0.5 text-xs font-normal text-amber-700 dark:border-amber-800 dark:text-amber-400">
                        TLS unverified
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                    {instance.baseUrl}
                  </p>
                </div>
                <Link
                  href={`/admin/admanager/${instance.id}`}
                  className="shrink-0 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Manage
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {draft ? (
        <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <p className="mb-3 text-sm font-medium">New instance</p>
          <InstanceConfigFields
            draft={draft}
            onChange={(patch) => dispatch({ type: 'edit', patch })}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canCreate(state)}
              onClick={() => void create()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Create instance
            </button>
            <button
              type="button"
              disabled={!canTest(state)}
              onClick={() => void test()}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              {busy ? 'Testing…' : 'Test reachability'}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'cancel' })}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
          </div>
          {probe ? <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{probe}</p> : null}
        </div>
      ) : (
        <button
          {...newAnchor}
          type="button"
          onClick={() => dispatch({ type: 'new' })}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + New instance
        </button>
      )}

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
