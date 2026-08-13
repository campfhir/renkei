'use client';

import { useEffect, useState } from 'react';

/**
 * Live-ish indexing progress for one connector, inside its card.
 *
 * Counts are cumulative and have no denominator on purpose: no provider
 * tells you how many items a delta or a space will yield, so a percentage
 * would be invented. What a user actually needs is "is it moving, and when
 * did it last move" — which a running total and a last-synced time answer
 * honestly.
 *
 * Polls only while the tab is visible: a background tab hammering the API
 * for a number nobody is reading is pure waste.
 */

const POLL_MS = 15_000;

interface ProgressItem {
  label: string;
  status: string;
  lastSyncedAt: string | null;
  lastRunItems: number;
  totalItems: number;
  error: string | null;
}

type Connector = 'microsoft' | 'jira' | 'confluence';

function relativeTime(iso: string | null): string {
  if (!iso) return 'not yet';
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'error'
      ? 'bg-red-500'
      : status === 'syncing'
        ? 'bg-blue-500 animate-pulse'
        : status === 'paused'
          ? 'bg-gray-400'
          : 'bg-green-500';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden />;
}

export default function SyncProgress({
  tenantId,
  connector,
  emptyHint,
}: {
  tenantId: string;
  connector: Connector;
  /** Shown when there is nothing to report — usually "how do I start one". */
  emptyHint?: string;
}) {
  const [items, setItems] = useState<ProgressItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const response = await fetch(`/api/tenant/${tenantId}/sync-progress`);
        if (!response.ok) throw new Error('failed');
        const data = await response.json();
        if (!cancelled) setItems(Array.isArray(data[connector]) ? data[connector] : []);
      } catch {
        // A failed poll is not worth a visible error: the next one is 15
        // seconds away. Functional update, not `if (items === null)` — that
        // reads a closed-over initial value and would wipe good numbers on
        // every later failure.
        if (!cancelled) setItems((current) => current ?? []);
      } finally {
        if (!cancelled) {
          timer = setTimeout(load, document.visibilityState === 'visible' ? POLL_MS : POLL_MS * 4);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `items` is read inside load() but deliberately not a dependency: it
    // would tear down and restart the poll on every response.
  }, [tenantId, connector]);

  if (items === null || items.length === 0) {
    return emptyHint && items !== null ? (
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-500">{emptyHint}</p>
    ) : null;
  }

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <p className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">Indexing</p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.label} className="text-xs">
            <div className="flex items-center gap-2">
              <StatusDot status={item.status} />
              <span className="truncate text-gray-700 dark:text-gray-300">{item.label}</span>
              <span className="ml-auto shrink-0 tabular-nums text-gray-500 dark:text-gray-500">
                {item.totalItems.toLocaleString()} indexed
                {item.lastRunItems > 0 ? ` (+${item.lastRunItems} last run)` : ''} ·{' '}
                {relativeTime(item.lastSyncedAt)}
              </span>
            </div>
            {item.error && (
              <p className="mt-0.5 pl-4 text-red-600 dark:text-red-400">{item.error}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
