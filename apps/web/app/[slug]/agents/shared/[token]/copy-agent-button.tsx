'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';

/**
 * "Copy to my agents". API-trigger keys are minted fresh for the copy and
 * shown HERE, once — navigating away loses them (the builder's rule), so
 * on a copy that minted keys the button holds the page until the person
 * says they've saved them.
 */
export default function CopyAgentButton({
  slug,
  tenantId,
  token,
}: {
  slug: string;
  tenantId: string;
  token: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ agentId: string; keys: string[] } | null>(null);

  const copy = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ agentId?: string; apiKeys?: { key: string }[] }>(
      `/api/tenant/${tenantId}/agents/copy`,
      'POST',
      { token }
    );
    setBusy(false);
    if (result.error || !result.data?.agentId) {
      setError(result.error ?? 'The agent could not be copied');
      return;
    }
    const keys = (result.data.apiKeys ?? []).map((entry) => entry.key);
    if (keys.length > 0) {
      setMinted({ agentId: result.data.agentId, keys });
      return;
    }
    router.push(`/${slug}/agents/${result.data.agentId}`);
  };

  if (minted) {
    return (
      <div className="max-w-sm rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
        <p className="font-medium text-amber-800 dark:text-amber-200">
          Copied. Your API trigger key{minted.keys.length > 1 ? 's' : ''} — shown once:
        </p>
        <ul className="my-2 space-y-1">
          {minted.keys.map((key) => (
            <li key={key}>
              <code className="break-all text-xs">{key}</code>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => router.push(`/${slug}/agents/${minted.agentId}`)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          I saved them — open my copy
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        disabled={busy}
        onClick={() => void copy()}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Copy to my agents
      </button>
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
