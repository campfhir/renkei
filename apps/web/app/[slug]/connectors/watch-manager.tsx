'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Add and remove the Jira projects / Confluence spaces Renkei keeps indexed,
 * with each one's progress.
 *
 * This is the same table the MCP tools write, through the same helpers — a
 * watch added here is indistinguishable from one an assistant added. Having
 * to ask a chat client to change a setting is a fine option to offer, not an
 * acceptable only way to do it.
 *
 * The picker lists what the caller can actually see rather than taking a
 * typed key, because a typed key puts the user in the position the
 * assistant was in: guessing, and reading provider errors. Free text stays
 * available as a fallback for the case where listing itself is refused —
 * that needs a scope watching does not.
 */

const POLL_MS = 15_000;

interface Watch {
  scopeKey: string;
  scopeLabel: string | null;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastRunItems: number;
  /** What the sweep has read from the provider. */
  totalItems: number;
  /** What is actually in the index and findable now. */
  indexedObjects: number;
  /** Read but not yet embedded. */
  queuedObjects: number;
  syncStatus: string;
  lastError: string | null;
}

interface Option {
  key: string;
  label: string;
  hint: string;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'not yet synced';
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusDotClass(watch: Watch): string {
  if (!watch.enabled) return 'bg-gray-400';
  if (watch.syncStatus === 'error') return 'bg-red-500';
  if (!watch.lastSyncedAt) return 'bg-blue-500 animate-pulse';
  return 'bg-green-500';
}

export default function WatchManager({
  tenantId,
  provider,
}: {
  tenantId: string;
  provider: 'jira' | 'confluence';
}) {
  const noun = provider === 'jira' ? 'project' : 'space';
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [options, setOptions] = useState<Option[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState('');
  const [manualKey, setManualKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadWatches = useCallback(async () => {
    try {
      const response = await fetch(`/api/tenant/${tenantId}/watches?provider=${provider}`);
      if (!response.ok) throw new Error('failed');
      const data = await response.json();
      setWatches(Array.isArray(data.watches) ? data.watches : []);
    } catch {
      // Keep whatever is on screen; the next poll is 15s away.
      setWatches((current) => current ?? []);
    }
  }, [tenantId, provider]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      await loadWatches();
      if (!cancelled) {
        timer = setTimeout(tick, document.visibilityState === 'visible' ? POLL_MS : POLL_MS * 4);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadWatches]);

  async function openPicker() {
    setAdding(true);
    setNotice(null);
    if (options !== null || optionsError !== null) return;
    try {
      const response = await fetch(`/api/tenant/${tenantId}/watches/options?provider=${provider}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setOptionsError(data.error ?? `Could not list ${noun}s.`);
        return;
      }
      setOptions(Array.isArray(data.options) ? data.options : []);
    } catch {
      setOptionsError('Could not reach the server.');
    }
  }

  async function add(scopeKey: string) {
    if (!scopeKey) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, scopeKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.error ?? 'Could not start watching.');
        return;
      }
      setNotice(
        data.created
          ? `Indexing started. The first pass runs within a few minutes.`
          : `That ${noun} was already being indexed.`
      );
      setAdding(false);
      setChoice('');
      setManualKey('');
      await loadWatches();
    } catch {
      setNotice('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Drop what Renkei has indexed for this scope and re-read it from
   * scratch. Nothing is written to Jira or Confluence — the only thing
   * deleted is Renkei's own copy.
   */
  async function reindex(watch: Watch) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/watches/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, scopeKey: watch.scopeKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.error ?? 'Could not start the rebuild.');
        return;
      }
      const discarded = Number(data.discarded ?? 0);
      setNotice(
        `Cleared ${Number(data.purged ?? 0).toLocaleString()} indexed item(s)` +
          (discarded > 0
            ? `, and discarded ${discarded.toLocaleString()} queued update(s) that would have rebuilt them`
            : '') +
          `. Re-reading this ${noun} from scratch; nothing was changed in the source.`
      );
      await loadWatches();
    } catch {
      setNotice('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(watch: Watch) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/tenant/${tenantId}/watches?provider=${provider}&scopeKey=${encodeURIComponent(
          watch.scopeKey
        )}`,
        { method: 'DELETE' }
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setNotice(data.error ?? 'Could not stop watching.');
        return;
      }
      // Already-indexed content stays searchable and permission-checked; only
      // the polling stops. Say so, or removing looks like a delete.
      setNotice(`Stopped indexing. What was already indexed stays searchable.`);
      await loadWatches();
    } catch {
      setNotice('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const active = (watches ?? []).filter((watch) => watch.enabled);

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
          Indexed {noun}s
          <span className="ml-1 font-normal">
            — searchable by meaning, always re-checked against your live permissions
          </span>
        </p>
        {!adding && (
          <button
            onClick={openPicker}
            className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            Add {noun}
          </button>
        )}
      </div>

      {active.length === 0 && watches !== null && !adding && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-500">
          Nothing indexed yet. Add a {noun} to make its content searchable.
        </p>
      )}

      {active.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {active.map((watch) => (
            <li key={watch.scopeKey} className="text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass(watch)}`}
                  aria-hidden
                />
                <span className="truncate text-gray-700 dark:text-gray-300">
                  {watch.scopeLabel || watch.scopeKey}
                </span>
                {/*
                  A progress fraction, indexed over the work that exists.
                  The denominator is indexed + queued, NOT the sweep's
                  `totalItems`: that counter is cumulative and re-counts every
                  item the 2-minute overlap window re-reads, so a scope that
                  had finished would still read 1,342 / 5,800 and look stuck
                  forever. What the sweep has read is kept in the tooltip,
                  where it is a fact rather than a denominator.
                */}
                <span
                  className="ml-auto shrink-0 tabular-nums text-gray-500 dark:text-gray-500"
                  title={
                    `${watch.indexedObjects.toLocaleString()} searchable now` +
                    (watch.queuedObjects > 0
                      ? `, ${watch.queuedObjects.toLocaleString()} still being indexed`
                      : '') +
                    `. ${watch.totalItems.toLocaleString()} read from the provider so far ` +
                    `(includes re-reads).`
                  }
                >
                  {watch.indexedObjects.toLocaleString()} /{' '}
                  {(watch.indexedObjects + watch.queuedObjects).toLocaleString()} indexed
                  {watch.queuedObjects > 0 && (
                    <span className="text-amber-600 dark:text-amber-500"> · indexing</span>
                  )}{' '}
                  · {relativeTime(watch.lastSyncedAt)}
                </span>
                <button
                  onClick={() => reindex(watch)}
                  disabled={busy}
                  className="shrink-0 text-gray-400 hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-200"
                  aria-label={`Re-index ${watch.scopeLabel || watch.scopeKey}`}
                  title="Clear Renkei's indexed copy and re-read from scratch"
                >
                  Re-index
                </button>
                <button
                  onClick={() => remove(watch)}
                  disabled={busy}
                  className="shrink-0 text-gray-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                  aria-label={`Stop indexing ${watch.scopeLabel || watch.scopeKey}`}
                >
                  Remove
                </button>
              </div>
              {watch.lastError && (
                <p className="mt-0.5 pl-4 text-red-600 dark:text-red-400">{watch.lastError}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mt-2 rounded-md border border-gray-200 p-2 dark:border-gray-800">
          {options === null && optionsError === null && (
            <p className="text-xs text-gray-500">Loading {noun}s…</p>
          )}

          {options !== null && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
                className="min-w-48 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="">Choose a {noun}…</option>
                {options.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                    {option.hint ? ` (${option.hint})` : ''}
                  </option>
                ))}
              </select>
              <button
                onClick={() => add(choice)}
                disabled={busy || !choice}
                className="rounded bg-gray-900 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
              >
                Start indexing
              </button>
            </div>
          )}

          {optionsError !== null && (
            <div>
              <p className="text-xs text-amber-700 dark:text-amber-400">{optionsError}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={manualKey}
                  onChange={(event) => setManualKey(event.target.value)}
                  placeholder={provider === 'jira' ? 'Project key, e.g. ENG' : 'Space key or id'}
                  className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                />
                <button
                  onClick={() => add(manualKey.trim())}
                  disabled={busy || !manualKey.trim()}
                  className="rounded bg-gray-900 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
                >
                  Start indexing
                </button>
              </div>
            </div>
          )}

          <button
            onClick={() => setAdding(false)}
            className="mt-2 text-xs text-gray-500 hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      {notice && <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{notice}</p>}
    </div>
  );
}
