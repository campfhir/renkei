'use client';

import ConnectorIcon from '@/components/connector-icon';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ScopePicker from '@/components/scope-picker';
import AuthorizedPermissions from '@/components/authorized-permissions';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { GITHUB_SCOPE_GROUPS, GITHUB_SCOPE_OPTIONS } from '@/lib/github-scopes';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';

/**
 * The user's own grant on Renkei's GitHub App: "Renkei acts on my
 * GitHub." Same shape as ZoomConnector/BitbucketConnector — a GitHub
 * App's real permissions are fixed on the App's registration, so
 * unchecking a capability here decides what Renkei USES, never what
 * GitHub grants (see github-scopes.ts).
 */
export default function GitHubConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed capabilities — the most a user can grant. */
  ceiling: string[];
  /** Capabilities on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ceilingSet = new Set(ceiling);
  const pickable = GITHUB_SCOPE_OPTIONS.filter((option) => optionWithin(option, ceilingSet));
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

  const authorizeUrl = `/api/github/${tenantId}/authorize?scopes=${encodeURIComponent(
    scopesOfOptions(GITHUB_SCOPE_OPTIONS, selectedIds).join(' ')
  )}`;

  async function disconnect() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/github/${tenantId}/grant`, { method: 'DELETE' });
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

  const cardAnchor = useCoachAnchor('card-github');
  const scopesAnchor = useCoachAnchor('github-scopes');
  const connectAnchor = useCoachAnchor('github-connect');

  return (
    <div
      {...cardAnchor}
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <ConnectorIcon capabilityKey="github" label="GitHub" size={20} />
          GitHub
        </h2>
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
            Connected as <strong>{displayName}</strong>. Repositories, branches, commits, pull
            requests, code search and Actions run on this grant — for any organization or account
            where Renkei&apos;s GitHub App is installed and you have access.
          </>
        ) : (
          'Repositories, branches, commits, code search, pull requests and Actions, for any organization or account where Renkei’s GitHub App is installed and you have access. Connecting installs the App if it isn’t already, then authorizes it as you.'
        )}
      </p>

      {notice && (
        <p className="mt-3 rounded-md bg-gray-100 p-2 text-sm dark:bg-gray-900">{notice}</p>
      )}

      {!connected && (
        <div className="mt-3">
          <details
            {...scopesAnchor}
            className="mb-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
          >
            <summary className="cursor-pointer text-sm font-medium">
              What Renkei may do ({selectedIds.size} of {pickable.length} capabilities)
            </summary>
            <div className="mt-3">
              <ScopePicker
                groups={GITHUB_SCOPE_GROUPS}
                options={GITHUB_SCOPE_OPTIONS}
                checked={selectedIds}
                onToggle={toggleOption}
                available={ceiling}
                audience="user"
              />
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Your organization allows at most these. Uncheck anything you don&apos;t want Renkei
                to use — GitHub&apos;s own permissions are fixed on the App either way, but Renkei
                only exercises what you check here.
              </p>
            </div>
          </details>
          <a
            {...connectAnchor}
            href={authorizeUrl}
            className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Connect GitHub
          </a>
        </div>
      )}

      {connected && (
        <div {...scopesAnchor}>
          <AuthorizedPermissions
            options={GITHUB_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="GitHub"
          >
            <ScopePicker
              groups={GITHUB_SCOPE_GROUPS}
              options={GITHUB_SCOPE_OPTIONS}
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
        </div>
      )}

      {connected &&
        (confirming ? (
          <div className="mt-3 rounded-lg border border-red-300 p-3 dark:border-red-800">
            <p className="mb-3 text-sm">
              Disconnect GitHub? The GitHub tools stop working until you reconnect.
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
            Disconnect GitHub
          </button>
        ))}
    </div>
  );
}
