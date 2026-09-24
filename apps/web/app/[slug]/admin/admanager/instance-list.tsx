'use client';

/**
 * ADManager Plus instance registry list plus one draft form for creation,
 * with a reachability test that runs BEFORE anything is saved. Editing
 * an existing instance happens on its own page; the draft here only ever
 * creates.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';
import InstanceConfigFields, { draftPayload, emptyDraft } from './instance-config-fields';
import type { InstanceDraft } from './instance-config-fields';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

interface InstanceRow {
  id: string;
  name: string;
  environment: string;
  baseUrl: string;
  tlsVerify: boolean;
  enabled: boolean;
}

interface ProbeResponse {
  ok: boolean;
  status?: number;
  error?: string;
}

export function probeText(probe: ProbeResponse): string {
  if (!probe.ok) return probe.error ?? 'The server could not be reached.';
  if (probe.status === 401) return 'Reachable — an ADManager Plus REST API is listening (it asked for a token, as expected).';
  return `Reachable — the server answered ${probe.status}.`;
}

export default function InstanceList({ slug }: { slug: string }) {
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [draft, setDraft] = useState<InstanceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ instances: InstanceRow[] }>(
      `/api/admin/${slug}/admanager`
    );
    if (loadError) setError(loadError);
    else setInstances(data?.instances ?? []);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const test = async () => {
    if (!draft) return;
    setBusy(true);
    setProbe(null);
    setError(null);
    const { data, error: probeError } = await sendJsonFull<ProbeResponse>(
      `/api/admin/${slug}/admanager/probe`,
      'POST',
      {
        baseUrl: draft.baseUrl,
        tlsVerify: draft.tlsVerify,
        caPem: draft.caPem || undefined,
        allowInsecureHttp: draft.allowInsecureHttp,
      }
    );
    setBusy(false);
    if (probeError || !data) {
      setError(probeError ?? 'The test did not answer.');
      return;
    }
    setProbe(probeText(data));
  };

  const create = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const saveError = await sendJson(`/api/admin/${slug}/admanager`, 'POST', draftPayload(draft));
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setDraft(null);
    setProbe(null);
    await load();
  };

  const listAnchor = useCoachAnchor('admin-admanager-list');
  const newAnchor = useCoachAnchor('admin-admanager-new');

  return (
    <div className="space-y-4">
      {/* The tour's anchor covers the note too, so the step has a target while the list is empty. */}
      <div {...listAnchor} className="space-y-4">
        {instances.length === 0 && !draft ? (
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
                  href={`/${slug}/admin/admanager/${instance.id}`}
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
          <InstanceConfigFields draft={draft} onChange={setDraft} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()}
              onClick={() => void create()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Create instance
            </button>
            <button
              type="button"
              disabled={busy || !draft.baseUrl.trim()}
              onClick={() => void test()}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              {busy ? 'Testing…' : 'Test reachability'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setProbe(null);
              }}
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
          onClick={() => setDraft(emptyDraft())}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + New instance
        </button>
      )}

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
