'use client';

/**
 * The Atlassian API token beside the Jira Administration grant: the one
 * credential Renkei takes typed in, because Jira's Automation API refuses
 * every OAuth app. Saved → who it belongs to and a confirm-then-remove
 * pair; not saved → an email and a token, posted once to the token route,
 * which keeps it only if Atlassian accepts it. Owns its own notice, like
 * DisconnectControl.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { reportFetchFailure } from '@/lib/fetch-json';

export default function ApiTokenControl({ savedFor }: { savedFor: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/atlassian-admin/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, token }),
      });
      const data: unknown = await response.json().catch(() => ({}));
      const body: Record<string, unknown> =
        typeof data === 'object' && data !== null ? Object.fromEntries(Object.entries(data)) : {};
      if (!response.ok) {
        const text =
          typeof body.error === 'string' && body.error ? body.error : 'Could not save the token';
        reportFetchFailure('POST', '/api/atlassian-admin/token', response.status, text);
        setNotice({ tone: 'error', text });
        return;
      }
      setToken('');
      if (typeof body.note === 'string' && body.note) setNotice({ tone: 'info', text: body.note });
      router.refresh();
    } catch (error) {
      reportFetchFailure(
        'POST',
        '/api/atlassian-admin/token',
        0,
        'Could not reach the server',
        error
      );
      setNotice({ tone: 'error', text: 'Could not reach the server' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/atlassian-admin/token`, { method: 'DELETE' });
      if (!response.ok) {
        reportFetchFailure(
          'DELETE',
          '/api/atlassian-admin/token',
          response.status,
          'Could not remove the token'
        );
        setNotice({ tone: 'error', text: 'Could not remove the token' });
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch (error) {
      reportFetchFailure(
        'DELETE',
        '/api/atlassian-admin/token',
        0,
        'Could not reach the server',
        error
      );
      setNotice({ tone: 'error', text: 'Could not reach the server' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mt-3 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
      data-testid="jira-admin-api-token"
    >
      <p className="font-medium">Automation rules: an Atlassian API token</p>
      <p className="mt-1 text-gray-600 dark:text-gray-400">
        Jira’s Automation API refuses every OAuth app, so listing, enabling, disabling, changing and
        running automation rules take your own API token (Atlassian account → Security → API
        tokens). It is kept sealed beside this connection, sent only to api.atlassian.com, and every
        change is still proposed first and applied by you.
      </p>
      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={
            notice.tone === 'error'
              ? 'mt-2 rounded-md bg-red-50 p-2 text-red-800 dark:bg-red-950 dark:text-red-300'
              : 'mt-2 rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
          }
        >
          {notice.text}
        </p>
      )}
      {savedFor ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span data-testid="jira-admin-api-token-saved">
            API token saved for <strong>{savedFor}</strong>.
          </span>
          {confirming ? (
            <>
              <button
                onClick={() => void remove()}
                disabled={busy}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? 'Removing…' : 'Yes, remove it'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              Remove API token
            </button>
          )}
        </div>
      ) : (
        <form
          onSubmit={(event) => void save(event)}
          className="mt-2 flex flex-wrap items-end gap-3"
        >
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-gray-600 dark:text-gray-400">
              Atlassian account email
            </span>
            <input
              type="email"
              name="email"
              required
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-64 max-w-full rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-gray-600 dark:text-gray-400">API token</span>
            <input
              type="password"
              name="token"
              required
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="w-64 max-w-full rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Save API token'}
          </button>
        </form>
      )}
    </div>
  );
}
