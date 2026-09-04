'use client';

/**
 * "Import" beside "New agent": paste a document exported by the agent
 * page's "Copy as Markdown" and get it back as a NEW, disabled agent —
 * the definition block does the round trip, the server re-validates
 * through the same save path as every other create.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ImportAgentButton({ slug, tenantId }: { slug: string; tenantId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [markdown, setMarkdown] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/agents/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown }),
      });
      const body: { agentId?: string; error?: string; issues?: { message: string }[] } =
        await response.json().catch(() => ({}));
      if (!response.ok || !body.agentId) {
        setError(
          body.issues?.length
            ? `${body.error ?? 'Invalid definition.'} ${body.issues.map((issue) => issue.message).join(' ')}`
            : (body.error ?? 'Import failed.')
        );
        return;
      }
      router.push(`/${slug}/agents/${body.agentId}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
      >
        Import
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => (busy ? null : setOpen(false))}
        >
          <div
            className="w-full max-w-2xl rounded-lg bg-white p-4 shadow-xl dark:bg-gray-950"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold">Import an agent</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Paste a document exported with “Copy as Markdown”. The definition block at its end is
              what imports — the agent is created off, under a new name if the old one is taken, for
              you to review and turn on.
            </p>
            <textarea
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
              rows={12}
              placeholder="# My agent … ```json renkei-agent … ```"
              className="mt-3 w-full rounded-md border border-gray-300 bg-white p-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
            />
            {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !markdown.trim()}
                onClick={submit}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
