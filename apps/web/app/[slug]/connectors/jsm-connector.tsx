'use client';

import ConnectorIcon from '@/components/connector-icon';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ScopePicker from '@/components/scope-picker';
import AuthorizedPermissions from '@/components/authorized-permissions';
import { ATLASSIAN_JSM_SCOPE_GROUPS, ATLASSIAN_JSM_SCOPE_OPTIONS } from '@/lib/atlassian-scopes';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';

/**
 * The user's grant on the second Atlassian app ("Renkei JSM": Service
 * Management + Operations scopes on their own grant — the split exists
 * because Atlassian's all-of scope enforcement times its consent-URL length
 * cliff makes the combined scope union unfittable on one app). Same shape as
 * the WebEx card: connection state server-rendered, connect link with scope
 * narrowing, confirm-gated disconnect.
 */
export default function JsmConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
  nested = false,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
  /**
   * Rendered inside the Atlassian suite card rather than as a card of its
   * own. Affects presentation only: these are three separate OAuth apps with
   * three separate grants, so the connect and disconnect controls stay here,
   * on the product they act on.
   */
  nested?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ceilingSet = new Set(ceiling);
  const pickable = ATLASSIAN_JSM_SCOPE_OPTIONS.filter((option) => optionWithin(option, ceilingSet));
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

  const authorizeUrl = `/api/atlassian-jsm/${tenantId}/authorize?scopes=${encodeURIComponent(
    scopesOfOptions(ATLASSIAN_JSM_SCOPE_OPTIONS, selectedIds).join(' ')
  )}`;

  async function disconnect() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/atlassian-jsm/${tenantId}/grant`, { method: 'DELETE' });
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
    <ConnectorShell nested={nested}>
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading nested={nested}>
          {/* Its own mark, though it shares Jira's capability key. */}
          <ConnectorIcon
            capabilityKey="jira"
            logo="jira-jsm"
            label="Jira Service Management"
            size={20}
          />
          Service Management &amp; Ops
        </ConnectorHeading>
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
            Connected as <strong>{displayName}</strong>. Service desk request and Operations
            (alerts, schedules, on-call) tools run on this grant.
          </>
        ) : (
          'A separate Atlassian consent for Jira Service Management and Operations — service desk requests, alerts, schedules, on-call. Atlassian cannot fit these scopes on the Jira consent, so they live on their own connection.'
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
                groups={ATLASSIAN_JSM_SCOPE_GROUPS}
                options={ATLASSIAN_JSM_SCOPE_OPTIONS}
                checked={selectedIds}
                onToggle={toggleOption}
                available={ceiling}
                audience="user"
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
            Connect Service Management
          </a>
        </div>
      )}

      {connected && (
        <AuthorizedPermissions
          options={ATLASSIAN_JSM_SCOPE_OPTIONS}
          authorized={priorScopes}
          connectorLabel="Jira Service Management"
        >
          <ScopePicker
            groups={ATLASSIAN_JSM_SCOPE_GROUPS}
            options={ATLASSIAN_JSM_SCOPE_OPTIONS}
            checked={selectedIds}
            onToggle={toggleOption}
            available={ceiling}
            audience="user"
          />
          <a
            href={authorizeUrl}
            className="mt-3 inline-block rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            Approve updated permissions
          </a>
        </AuthorizedPermissions>
      )}

      {connected &&
        (confirming ? (
          <div className="mt-3 rounded-lg border border-red-300 p-3 dark:border-red-800">
            <p className="mb-3 text-sm">
              Disconnect Service Management? The JSM and Operations tools stop working until you
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
            Disconnect Service Management
          </button>
        ))}
    </ConnectorShell>
  );
}
