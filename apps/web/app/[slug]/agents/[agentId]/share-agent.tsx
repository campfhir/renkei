'use client';

import { useState } from 'react';

/**
 * The owner's sharing control: mint a copy link, show it (re-displayable
 * — that's why the token is stored, not digested), regenerate to
 * invalidate what's out there, or stop sharing. The link only works for
 * people signed into this same organization.
 */
export default function ShareAgent({
  slug,
  tenantId,
  agentId,
  initialToken,
}: {
  slug: string;
  tenantId: string;
  agentId: string;
  initialToken: string | null;
}) {
  const [token, setToken] = useState<string | null>(initialToken);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shareUrl = token
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/${slug}/agents/shared/${token}`
    : null;

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/agents/${agentId}/share`, {
        method: 'POST',
      });
      const body: { token?: string; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok || !body.token) {
        setError(body.error ?? 'Sharing could not be enabled');
        return;
      }
      setToken(body.token);
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/tenant/${tenantId}/agents/${agentId}/share`, { method: 'DELETE' });
      setToken(null);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setError('Could not reach the clipboard — copy the link text by hand');
    }
  };

  return (
    <section className="mb-4">
      <h2 className="mb-2 text-sm font-semibold">Sharing</h2>
      {token ? (
        <div className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800">
          <p className="text-gray-600 dark:text-gray-400">
            Anyone signed into this organization with the link can copy this agent&apos;s
            configuration — knowledge notes included — and make it their own. Copies run on THEIR
            connections and start switched off; your agent and its memory stay yours.
          </p>
          <p className="my-2 break-all rounded-md bg-gray-50 p-2 text-xs dark:bg-gray-900">
            {shareUrl}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copyLink()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void mint()}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Regenerate (invalidates the old link)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void stop()}
              className="text-sm text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
            >
              Stop sharing
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void mint()}
          className="text-sm font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
        >
          Share this agent (create a copy link)
        </button>
      )}
      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </section>
  );
}
