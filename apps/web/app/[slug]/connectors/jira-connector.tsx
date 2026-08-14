'use client';

import ConnectorIcon from '@/components/connector-icon';
import { useEffect, useState } from 'react';
import ScopePicker from '@/components/scope-picker';
import AuthorizedPermissions from '@/components/authorized-permissions';
import { ATLASSIAN_SCOPE_GROUPS, ATLASSIAN_SCOPE_OPTIONS } from '@/lib/atlassian-scopes';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';
import WatchManager from './watch-manager';

interface JiraStatus {
  connected: boolean;
  accountId?: string;
  displayName?: string;
}

/**
 * The user's Jira grant: status, connect, disconnect. Talks to the existing
 * /api/mcp/[tenantId] routes — the page around it has already established a
 * session, so a 401 here means it died mid-visit and a refresh re-guards.
 *
 * Before connecting, the user may narrow the org's scope ceiling — hide the
 * capabilities they don't want Renkei to have. The authorize route enforces
 * the subset server-side; this picker is the honest UI over that rule.
 */
export default function JiraConnector({
  tenantId,
  ceiling,
  priorScopes,
}: {
  tenantId: string;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  // Only catalog options count as choices; required scopes (offline_access,
  // kms, people_read) ride along server-side and are not offered here. An
  // option is pickable when the ceiling covers every scope it bundles.
  const ceilingSet = new Set(ceiling);
  const pickable = ATLASSIAN_SCOPE_OPTIONS.filter((option) => optionWithin(option, ceilingSet));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    // Reconnect seeding: an option is pre-checked when the prior grant
    // carried its whole bundle. A prior grant from before the granular
    // migration matches nothing → fall back to everything pickable.
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

  const selectedScopeString = scopesOfOptions(ATLASSIAN_SCOPE_OPTIONS, selectedIds).join(' ');
  const authorizeUrl = `/api/mcp/${tenantId}/authorize?scopes=${encodeURIComponent(selectedScopeString)}`;
  // Atlassian enforces every documented granular scope per endpoint AND its
  // CDN 414s when the consent redirect chain re-encodes a long authorize URL
  // (observed cliff ≈ 3.1k chars). Some checkbox combinations cannot satisfy
  // both — warn before the user finds out as a CloudFront error page.
  const estimatedUrlLength = 250 + encodeURIComponent(selectedScopeString).length;
  const overUrlBudget = estimatedUrlLength > 2900;
  const [status, setStatus] = useState<JiraStatus | null>(null);
  // Disconnecting is not reversible without re-authorising Jira, so it asks
  // first rather than acting on one click.
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/mcp/${tenantId}/status`)
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  async function disconnect() {
    setDisconnecting(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/mcp/${tenantId}/grant`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.message || data.error || 'Could not disconnect');
        return;
      }
      setStatus({ connected: false });
      setConfirming(false);
      setNotice(data.message ?? 'Disconnected');
    } catch {
      setNotice('Could not reach the server');
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <ConnectorIcon capabilityKey="jira" label="Jira" size={20} />
          Jira
        </h2>
        {status === null ? (
          <span className="text-sm text-gray-500">Checking…</span>
        ) : status.connected ? (
          <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
            Connected
          </span>
        ) : (
          <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
            Not connected
          </span>
        )}
      </div>

      {status?.connected && status.displayName && (
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Connected as <strong>{status.displayName}</strong>
        </p>
      )}

      {notice && (
        <p className="mt-3 rounded-md bg-gray-100 p-2 text-sm dark:bg-gray-900">{notice}</p>
      )}

      {status?.connected && (
        <AuthorizedPermissions
          options={ATLASSIAN_SCOPE_OPTIONS}
          authorized={priorScopes}
          connectorLabel="Jira"
        >
          <ScopePicker
            groups={ATLASSIAN_SCOPE_GROUPS}
            options={ATLASSIAN_SCOPE_OPTIONS}
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

      {status !== null && !status.connected && (
        <div className="mt-3">
          <details className="mb-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
            <summary className="cursor-pointer text-sm font-medium">
              What Renkei may do ({selectedIds.size} of {pickable.length} capabilities)
            </summary>
            <div className="mt-3">
              <ScopePicker
                groups={ATLASSIAN_SCOPE_GROUPS}
                options={ATLASSIAN_SCOPE_OPTIONS}
                checked={selectedIds}
                onToggle={toggleOption}
                available={ceiling}
                audience="user"
              />
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Your organization allows at most these. Uncheck anything you don&apos;t want Renkei
                to have — you can reconnect later to change it.
              </p>
              {overUrlBudget && (
                <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                  This combination likely exceeds Atlassian&apos;s consent-URL limit (their CDN
                  answers 414). Uncheck a group you don&apos;t need right now — e.g. Service
                  Management or Operations — and reconnect later with a different set.
                </p>
              )}
            </div>
          </details>
          <a
            href={authorizeUrl}
            className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Connect Jira
          </a>
        </div>
      )}

      {status?.connected &&
        (confirming ? (
          <div className="mt-3 rounded-lg border border-red-300 p-3 dark:border-red-800">
            <p className="mb-3 text-sm">
              Disconnect <strong>{status.displayName ?? 'your Jira account'}</strong>? Tools stop
              working until you reconnect, and any MCP client tokens issued for you are revoked.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => void disconnect()}
                disabled={disconnecting}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={disconnecting}
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
            Disconnect Jira
          </button>
        ))}

      {status?.connected && <WatchManager tenantId={tenantId} provider="jira" />}
    </div>
  );
}
