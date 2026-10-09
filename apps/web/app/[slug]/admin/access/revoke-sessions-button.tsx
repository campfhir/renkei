'use client';

import { useState } from 'react';
import { useRefresh } from '@/lib/use-refresh';

/**
 * The administrator's non-destructive containment on the Access page: end
 * every browser session and MCP client token a person holds, now. Nothing
 * of theirs is removed — they sign in again — so one confirmation is
 * enough, unlike the key shred beside it.
 */
export default function RevokeSessionsButton({
  slug,
  subject,
  displayName,
}: {
  slug: string;
  subject: string;
  displayName: string;
}) {
  const { refresh, pending } = useRefresh();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function revoke() {
    if (
      !window.confirm(
        `Sign ${displayName} out everywhere? Their browser sessions and MCP client connections end now; they can sign in again at any time.`
      )
    ) {
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const response = await fetch(
        `/api/admin/${slug}/access/${encodeURIComponent(subject)}/revoke-sessions`,
        { method: 'POST' }
      );
      const data: {
        success?: unknown;
        error?: unknown;
        revoked?: { sessions?: number; accessTokens?: number; refreshTokens?: number };
      } = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) {
        setOutcome({
          kind: 'error',
          text: typeof data.error === 'string' ? data.error : 'Could not sign them out',
        });
        return;
      }
      const sessions = data.revoked?.sessions ?? 0;
      const tokens = (data.revoked?.accessTokens ?? 0) + (data.revoked?.refreshTokens ?? 0);
      setOutcome({
        kind: 'ok',
        text: `Signed out: ${sessions} session${sessions === 1 ? '' : 's'}, ${tokens} token${tokens === 1 ? '' : 's'}`,
      });
      refresh();
    } catch {
      setOutcome({ kind: 'error', text: 'Could not reach the server' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => void revoke()}
        disabled={busy || pending}
        className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
        title="End every browser session and MCP client token this person holds"
        data-testid={`revoke-sessions-${subject}`}
      >
        {busy ? 'Signing out…' : 'Sign out everywhere'}
      </button>
      {outcome ? (
        <span
          className={`text-xs ${outcome.kind === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}
          data-testid={`revoke-sessions-outcome-${subject}`}
        >
          {outcome.text}
        </span>
      ) : null}
    </span>
  );
}
