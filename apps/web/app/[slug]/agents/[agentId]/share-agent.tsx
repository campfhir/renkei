'use client';

import { useEffect, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';

/**
 * The owner's sharing control, opened from the overview header's Share
 * button: mint a copy link, show it (re-displayable — that's why the token
 * is stored, not digested), regenerate to invalidate what's out there, or
 * stop sharing. The link only works for people signed into this same
 * organization.
 */
export default function ShareAgentButton({
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
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(initialToken);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
      >
        <Icon path={ICONS.share} />
        Share
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Share this agent"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-950"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Sharing</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                <Icon path={ICONS.close} />
              </button>
            </div>

            {token ? (
              <div className="text-sm">
                <p className="text-gray-600 dark:text-gray-400">
                  Anyone signed into this organization with the link can copy this agent&apos;s
                  configuration — knowledge notes included — and make it their own. Copies run on
                  THEIR connections and start switched off; your agent and its memory stay yours.
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
              <div className="text-sm">
                <p className="mb-3 text-gray-600 dark:text-gray-400">
                  Create a link that lets colleagues in this organization copy this agent as a
                  starting point of their own. Nothing is shared until you create it.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void mint()}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Share this agent (create a copy link)
                </button>
              </div>
            )}
            {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
