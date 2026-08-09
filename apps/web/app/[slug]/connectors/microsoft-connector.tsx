'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ScopePicker from '@/components/scope-picker';
import { MICROSOFT_SCOPE_GROUPS, MICROSOFT_SCOPE_OPTIONS } from '@/lib/microsoft-scopes';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';

/**
 * The user's own Microsoft 365 grant: "Renkei reads my Outlook." Connection
 * state arrives server-rendered from the page (the grant row either exists
 * or not); this component carries the connect link — with the user's
 * optional scope narrowing, enforced server-side — and the disconnect
 * confirmation.
 */
export default function MicrosoftConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Only catalog options count as choices; required scopes (openid, profile,
  // email, offline_access, User.Read) ride along server-side and are not
  // offered here.
  const ceilingSet = new Set(ceiling);
  const pickable = MICROSOFT_SCOPE_OPTIONS.filter((option) => optionWithin(option, ceilingSet));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const prior = priorScopes === null ? null : new Set(priorScopes);
    const seed = prior
      ? pickable.filter((option) => optionWithin(option, prior)).map((option) => option.id)
      : [];
    return new Set(seed.length > 0 ? seed : pickable.map((option) => option.id));
  });

  function toggleOption(optionId: string, on: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (on) next.add(optionId);
      else next.delete(optionId);
      return next;
    });
  }

  const authorizeUrl = `/api/microsoft/${tenantId}/authorize?scopes=${encodeURIComponent(
    scopesOfOptions(MICROSOFT_SCOPE_OPTIONS, selectedIds).join(' ')
  )}`;

  async function disconnect() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/microsoft/${tenantId}/grant`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.error ?? 'Could not disconnect');
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setNotice('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold">Microsoft 365 (your account)</h2>
        {connected ? (
          <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
            Connected
          </span>
        ) : (
          <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
            Not connected
          </span>
        )}
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. MCP tools can read your Outlook mail,
            calendar events and To&nbsp;Do tasks, and ingest them into knowledge.
          </>
        ) : (
          'Grant Renkei read access to your own Microsoft 365: Outlook mail, calendar events and To Do tasks — searchable through the MCP tools and ingested into knowledge.'
        )}
      </p>

      {notice && (
        <p className="mt-3 rounded-md bg-gray-100 p-2 text-sm dark:bg-gray-900">{notice}</p>
      )}

      {!connected && (
        <div className="mt-3">
          <details className="mb-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
            <summary className="cursor-pointer text-sm font-medium">
              What Renkei may do ({selectedIds.size} of {pickable.length} capabilities)
            </summary>
            <div className="mt-3">
              <ScopePicker
                groups={MICROSOFT_SCOPE_GROUPS}
                options={MICROSOFT_SCOPE_OPTIONS}
                checked={selectedIds}
                onToggle={toggleOption}
                available={ceiling}
              />
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Your organization allows at most these. Uncheck anything you don&apos;t want Renkei
                to have — you can reconnect later to change it.
              </p>
            </div>
          </details>
          <a
            href={authorizeUrl}
            className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Connect Microsoft 365
          </a>
        </div>
      )}

      {connected &&
        (confirming ? (
          <div className="mt-3 rounded-lg border border-red-300 p-3 dark:border-red-800">
            <p className="mb-3 text-sm">
              Disconnect your Microsoft 365 account? The Outlook MCP tools stop working until you
              reconnect.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => void disconnect()}
                disabled={busy}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
              >
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="mt-3 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
          >
            Disconnect Microsoft 365
          </button>
        ))}
    </div>
  );
}
