'use client';

/**
 * Edit one Mirth instance's connection details — no credentials here:
 * people connect the instance with their own account from the connectors
 * page, which is also where a credential gets proven against the live
 * server. The reachability test here is unauthenticated.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';
import InstanceConfigFields, { draftPayload, emptyDraft } from '../instance-config-fields';
import type { InstanceDraft } from '../instance-config-fields';
import { probeText } from '../instance-list';
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';

interface InstanceResponse {
  instance: {
    id: string;
    name: string;
    environment: string;
    baseUrl: string;
    tlsVerify: boolean;
    hasCustomCa: boolean;
    allowInsecureHttp: boolean;
    enabled: boolean;
  };
}

export default function InstanceConfigForm({
  slug,
  instanceId,
}: {
  slug: string;
  instanceId: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<InstanceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await getJson<InstanceResponse>(
      `/api/admin/${slug}/mirth/${instanceId}`
    );
    if (error || !data) {
      setStatus({ kind: 'error', text: error ?? 'Could not load the instance' });
      return;
    }
    setDraft({
      ...emptyDraft(),
      name: data.instance.name,
      environment: data.instance.environment,
      baseUrl: data.instance.baseUrl,
      tlsVerify: data.instance.tlsVerify,
      hasCustomCa: data.instance.hasCustomCa,
      allowInsecureHttp: data.instance.allowInsecureHttp,
      enabled: data.instance.enabled,
    });
  }, [slug, instanceId]);

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
    setBusy(true);
    setStatus(null);
    const error = await sendJson(
      `/api/admin/${slug}/mirth/${instanceId}`,
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

  const test = async () => {
    setBusy(true);
    setStatus(null);
    const { data, error } = await sendJsonFull<{
      ok: boolean;
      status?: number;
      version: string | null;
      error?: string;
    }>(`/api/admin/${slug}/mirth/probe`, 'POST', {
      baseUrl: draft.baseUrl,
      tlsVerify: draft.tlsVerify,
      caPem: draft.caPem || undefined,
      allowInsecureHttp: draft.allowInsecureHttp,
    });
    setBusy(false);
    if (error || !data) {
      setStatus({ kind: 'error', text: error ?? 'The test did not answer.' });
      return;
    }
    setStatus({ kind: data.ok ? 'ok' : 'error', text: probeText(data) });
  };

  const remove = async () => {
    if (!window.confirm("Delete this instance? Everyone's stored connections to it go with it."))
      return;
    setBusy(true);
    const error = await sendJson(`/api/admin/${slug}/mirth/${instanceId}`, 'DELETE');
    setBusy(false);
    if (error) {
      setStatus({ kind: 'error', text: error });
      return;
    }
    router.push(`/${slug}/admin/mirth`);
  };

  return (
    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
      <InstanceConfigFields draft={draft} onChange={setDraft} />
      <label className="mt-3 flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
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
