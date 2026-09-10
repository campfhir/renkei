'use client';

/**
 * The catalog: what this person may add, searchable, grouped the way the
 * catalog groups things. Adding puts the card on the page; it connects
 * nothing by itself — the card's own Connect does that, with its own scope
 * picker — so "Add" is cheap to press and cheap to undo.
 *
 * The list arrives from the server already filtered to what the org offers
 * this person. Nothing here decides availability; it only searches it.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import ConnectorIcon from '@/components/connector-icon';
import { Icon, ICONS } from '@/components/icons';
import {
  CONNECTOR_CATEGORY_LABELS,
  type ConnectorCategory,
  type ConnectorEntry,
} from '@/lib/connector-catalog';
import { searchConnectors } from '@/lib/connector-search';

/** What a catalog row needs — the entry, and where this person stands with it. */
export interface CatalogItem {
  entry: ConnectorEntry;
  added: boolean;
  connected: boolean;
}

export default function AddConnectorModal({
  tenantId,
  items,
  onClose,
}: {
  tenantId: string;
  items: CatalogItem[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<Set<string>>(
    () => new Set(items.filter((item) => item.added).map((item) => item.entry.capabilityKey))
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byKey = useMemo(
    () => new Map(items.map((item) => [item.entry.capabilityKey, item])),
    [items]
  );

  // Search first, then group: a query narrows the whole catalog and the
  // groups that survive keep their order, so the list never reshuffles as
  // somebody types.
  const groups = useMemo(() => {
    const matches = searchConnectors(
      items.map((item) => item.entry),
      query
    );
    const grouped = new Map<ConnectorCategory, ConnectorEntry[]>();
    for (const entry of matches) {
      const list = grouped.get(entry.category) ?? [];
      list.push(entry);
      grouped.set(entry.category, list);
    }
    return [...grouped.entries()];
  }, [items, query]);

  async function add(capabilityKey: string) {
    setBusy(capabilityKey);
    setError(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/connector-selections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector: capabilityKey }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String(body.error)
            : 'Could not add';
        setError(message);
        return;
      }
      setAdded((current) => new Set(current).add(capabilityKey));
      // The card's props (ceilings, grant state) are server-derived, so the
      // page re-renders rather than the modal guessing at them.
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title="Add a connector" onClose={onClose}>
      <label className="relative mb-2 block">
        <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-gray-400">
          <Icon path={ICONS.search} />
        </span>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search connectors — try “email” or “tickets”"
          aria-label="Search connectors"
          className="w-full rounded-md border border-gray-300 bg-white py-1.5 pr-2 pl-8 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
      </label>
      {error && <p className="mb-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
      <div className="max-h-96 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing is available to add. Your organization has not set up any connectors for you
            yet.
          </p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-gray-500">No matches.</p>
        ) : (
          groups.map(([category, entries]) => (
            <section key={category} className="mb-3">
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase">
                {CONNECTOR_CATEGORY_LABELS[category]}
              </h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-900">
                {entries.map((entry) => {
                  const item = byKey.get(entry.capabilityKey);
                  const isAdded = added.has(entry.capabilityKey);
                  const isConnected = item?.connected ?? false;
                  return (
                    <li key={entry.capabilityKey} className="flex items-center gap-3 py-2">
                      <span className="flex w-16 shrink-0 items-center justify-center">
                        <ConnectorIcon
                          capabilityKey={entry.capabilityKey}
                          label={entry.label}
                          size={22}
                          maxWidth={60}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{entry.label}</p>
                        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                          {entry.summary}
                        </p>
                      </div>
                      {isAdded || isConnected ? (
                        <span className="shrink-0 text-xs text-gray-500">
                          {isConnected ? 'Connected' : 'Added'}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void add(entry.capabilityKey)}
                          disabled={busy !== null}
                          className="shrink-0 rounded-md border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
                        >
                          {busy === entry.capabilityKey ? 'Adding…' : 'Add'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </Modal>
  );
}
