'use client';

/**
 * The admin catalog: every connector, searchable, grouped by category, one
 * row per config with its status pills, its off switches and a link to its
 * own page.
 *
 * The off switch is the org-wide `disabledConnectors` dial. It is kept on
 * the row, beside the status it changes, because it answers a different
 * question from the form behind the link: the form is provisioning — which
 * app registration, which secret, which scope ceiling — and this is
 * operational: something is misbehaving, or a capability is not wanted this
 * quarter, and it should stop being offered NOW without anyone reconnecting
 * afterwards to get it back.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import ConnectorIcon from '@/components/connector-icon';
import { Icon, ICONS } from '@/components/icons';
import { CONNECTOR_CATEGORY_LABELS, type ConnectorCategory } from '@/lib/connector-catalog';
import { saveDisabledConnectors } from './availability-client';

export interface ConnectorRow {
  configKey: string;
  label: string;
  category: ConnectorCategory;
  /** Has a form of its own — a page to open. */
  configurable: boolean;
  /** Managed on another page instead (file shares). */
  manageHref: string | null;
  /** A connector_configs row exists. */
  configured: boolean;
  /** …and is enabled (new connections allowed). */
  enabled: boolean;
  products: Array<{
    capabilityKey: string;
    label: string;
    summary: string;
    toolPrefix: string;
    keywords: string[];
    togglable: boolean;
  }>;
}

function Pill({ tone, children }: { tone: 'green' | 'yellow' | 'gray' | 'red'; children: string }) {
  const tones = {
    green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    gray: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function matches(row: ConnectorRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    row.label,
    row.configKey,
    ...row.products.flatMap((product) => [
      product.label,
      product.summary,
      product.toolPrefix,
      product.capabilityKey,
      ...product.keywords,
    ]),
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export default function ConnectorList({
  slug,
  rows,
  initialDisabled,
}: {
  slug: string;
  rows: ConnectorRow[];
  initialDisabled: string[];
}) {
  const [query, setQuery] = useState('');
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set(initialDisabled));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const grouped = new Map<ConnectorCategory, ConnectorRow[]>();
    for (const row of rows) {
      if (!matches(row, query)) continue;
      const list = grouped.get(row.category) ?? [];
      list.push(row);
      grouped.set(row.category, list);
    }
    return [...grouped.entries()];
  }, [rows, query]);

  async function toggle(capabilityKey: string, on: boolean) {
    const next = new Set(disabled);
    if (on) next.delete(capabilityKey);
    else next.add(capabilityKey);
    setDisabled(next);
    setBusy(true);
    setError(null);
    const failure = await saveDisabledConnectors(slug, next);
    if (failure) setError(failure);
    setBusy(false);
  }

  return (
    <div>
      <label className="relative mb-4 block">
        <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-gray-400">
          <Icon path={ICONS.search} />
        </span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a connector"
          aria-label="Find a connector"
          className="w-full rounded-md border border-gray-300 bg-white py-1.5 pr-2 pl-8 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
      </label>
      {error && <p className="mb-3 text-sm text-red-700 dark:text-red-400">{error}</p>}

      {groups.length === 0 && <p className="text-sm text-gray-500">No connector matches.</p>}

      {groups.map(([category, list]) => (
        <section key={category} className="mb-6">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">
            {CONNECTOR_CATEGORY_LABELS[category]}
          </h2>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white dark:divide-gray-900 dark:border-gray-800 dark:bg-gray-950">
            {list.map((row) => {
              const href = row.manageHref ?? `/${slug}/admin/connectors/${row.configKey}`;
              const allOff =
                row.products.some((product) => product.togglable) &&
                row.products
                  .filter((product) => product.togglable)
                  .every((product) => disabled.has(product.capabilityKey));
              return (
                <li key={row.configKey} className="flex items-start gap-3 px-4 py-3">
                  {/* A fixed slot, so marks of wildly different widths still
                      leave every label starting at the same x. */}
                  <span className="flex h-6 w-20 shrink-0 items-center justify-center">
                    <ConnectorIcon
                      capabilityKey={row.products[0].capabilityKey}
                      label={row.label}
                      size={22}
                      maxWidth={76}
                      className={allOff ? 'opacity-40 grayscale' : ''}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={href}
                        className={`text-sm font-medium hover:underline ${allOff ? 'text-gray-400 dark:text-gray-600' : ''}`}
                      >
                        {row.label}
                      </Link>
                      {row.configurable ? (
                        !row.configured ? (
                          <Pill tone="gray">Not configured</Pill>
                        ) : row.enabled ? (
                          <Pill tone="green">Enabled</Pill>
                        ) : (
                          <Pill tone="yellow">Disabled</Pill>
                        )
                      ) : row.manageHref ? (
                        <Pill tone="gray">Managed separately</Pill>
                      ) : (
                        <Pill tone="gray">Built in</Pill>
                      )}
                      {allOff && <Pill tone="red">Off</Pill>}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {row.products.length === 1
                        ? row.products[0].summary
                        : row.products.map((product) => product.label).join(' · ')}
                    </p>
                    {/* One switch per capability key: SharePoint can go off
                        without taking mail with it. */}
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                      {row.products
                        .filter((product) => product.togglable)
                        .map((product) => {
                          const off = disabled.has(product.capabilityKey);
                          return (
                            <label
                              key={product.capabilityKey}
                              className="flex items-center gap-1.5 text-xs"
                            >
                              <input
                                type="checkbox"
                                checked={!off}
                                disabled={busy}
                                onChange={(event) =>
                                  void toggle(product.capabilityKey, event.target.checked)
                                }
                              />
                              <span className={off ? 'text-gray-400' : ''}>
                                {row.products.length > 1 ? product.label : 'Offered'}
                                <span className="ml-1 font-mono text-[10px] text-gray-400">
                                  {product.toolPrefix}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                    </div>
                  </div>
                  <Link
                    href={href}
                    aria-label={`Open ${row.label}`}
                    className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                  >
                    <Icon path={ICONS.chevron} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {/* Jira and JSM share one capability key, so one switch covers both.
          Saying so beats letting an operator discover it. */}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Jira and Jira Service Management share a switch. Turning a connector off does not delete
        anything it has already indexed — indexed content stays searchable and is still access
        checked per reader. Tool lists refresh within a minute.
      </p>
    </div>
  );
}
