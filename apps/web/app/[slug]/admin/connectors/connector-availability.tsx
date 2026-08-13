'use client';

import { useState } from 'react';
import ConnectorIcon from '@/components/connector-icon';
import { togglableConnectors } from '@/lib/connector-catalog';

/**
 * Org-wide on/off per connector.
 *
 * Kept above the credential forms because it answers a different question.
 * The forms below are provisioning — which app registration, which secret,
 * which scope ceiling. This is operational: something is misbehaving, or a
 * capability is not wanted this quarter, and it should stop being offered
 * NOW without anyone reconnecting afterwards to get it back.
 */
export default function ConnectorAvailability({
  slug,
  initialDisabled,
}: {
  slug: string;
  initialDisabled: string[];
}) {
  const connectors = togglableConnectors();
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set(initialDisabled));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(next: Set<string>) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch(`/api/admin/${slug}/connector-availability`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabledConnectors: [...next] }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String(body.error)
            : 'Could not save';
        setError(message);
        return;
      }
      setNotice('Saved. Tool lists refresh within a minute.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  function toggle(capabilityKey: string, enabled: boolean) {
    const next = new Set(disabled);
    if (enabled) next.delete(capabilityKey);
    else next.add(capabilityKey);
    setDisabled(next);
    void save(next);
  }

  return (
    <section className="mb-8 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="font-semibold">Available connectors</h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Turn a connector off to stop its tools being offered to everyone in this organization,
        immediately. Nobody&rsquo;s connection is changed and nobody needs to reconnect — turning it
        back on restores the tools as they were.
      </p>

      <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-900">
        {connectors.map((connector) => {
          const off = disabled.has(connector.capabilityKey);
          return (
            <li key={connector.capabilityKey} className="flex items-center gap-3 py-3">
              {/* A fixed slot, so marks of wildly different widths (a square
                  SharePoint tile beside an 8:1 Confluence lockup) still leave
                  every label starting at the same x. */}
              <span className="flex w-24 shrink-0 items-center justify-center">
                <ConnectorIcon
                  capabilityKey={connector.capabilityKey}
                  label={connector.label}
                  size={24}
                  maxWidth={92}
                  className={off ? 'opacity-40 grayscale' : ''}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm font-medium ${off ? 'text-gray-400 dark:text-gray-600' : ''}`}
                >
                  {connector.label}
                  <span className="ml-2 font-mono text-[11px] font-normal text-gray-400">
                    {connector.toolPrefix}
                  </span>
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{connector.summary}</p>
              </div>
              <label className="flex shrink-0 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!off}
                  disabled={busy}
                  onChange={(event) => toggle(connector.capabilityKey, event.target.checked)}
                />
                <span className={off ? 'text-gray-400' : ''}>{off ? 'Off' : 'On'}</span>
              </label>
            </li>
          );
        })}
      </ul>

      {/* Jira and JSM share one capability key, so one switch covers both.
          Saying so beats letting an operator discover it. */}
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        Jira and Jira Service Management share a switch. Turning a connector off does not delete
        anything it has already indexed — indexed content stays searchable and is still access
        checked per reader.
      </p>

      {notice && <p className="mt-3 text-sm text-green-700 dark:text-green-400">{notice}</p>}
      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </section>
  );
}
