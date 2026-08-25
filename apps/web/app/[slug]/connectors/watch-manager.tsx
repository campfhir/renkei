'use client';

import RemoveButton from '@/components/remove-button';
import { BackButton } from '@/components/back-link';
import { useCallback, useEffect, useState } from 'react';

/**
 * Add and remove the Jira projects / Confluence spaces / SharePoint document
 * libraries Renkei keeps indexed, with each one's progress.
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
 *
 * SharePoint gets a picker of its own (SitePicker, below) because a library
 * cannot be chosen in one step: Graph has no "all sites" call, so the user
 * finds a site first and then picks from its libraries. Everything after the
 * choice — the list, the progress, re-index, remove — is shared, because
 * none of it differs by provider.
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

interface Site {
  id: string;
  name: string;
  webUrl: string;
}

export type WatchProvider = 'jira' | 'confluence' | 'sharepoint';

const NOUN: Record<WatchProvider, string> = {
  jira: 'project',
  confluence: 'space',
  sharepoint: 'library',
};

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
  provider: WatchProvider;
}) {
  const noun = NOUN[provider];
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
    // SharePoint has no flat list to preload — SitePicker asks for sites
    // once it is on screen, and for libraries once a site is chosen.
    if (provider === 'sharepoint') return;
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

  /**
   * `site` is SharePoint's second half: the server checks the drive really is
   * one of that site's libraries rather than trusting a bare driveId, and it
   * needs the site to do so.
   */
  async function add(scopeKey: string, site?: string) {
    if (!scopeKey) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, scopeKey, ...(site ? { site } : {}) }),
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

  /**
   * Rebind a failing watch to the caller's own connection, KEEPING the
   * cursor — polling resumes where it stopped instead of re-reading the
   * whole scope. The cheap fix for a dead or misaligned grant; re-index
   * stays available for when the indexed content itself is suspect.
   */
  async function repair(watch: Watch) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/watches/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, scopeKey: watch.scopeKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.error ?? 'Could not repair the watch.');
        return;
      }
      setNotice(
        `Rebound to your connection. Polling resumes within a few minutes from where it ` +
          `stopped — nothing is re-fetched.`
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

      {/*
        Said here and not only in the tool description, because this is where
        someone decides to do it. A library is SHARED, so "indexed under your
        access" is not the same promise as "only you can find it" — the second
        half, that disclosure is decided per reader at search time, is the part
        that makes the first half safe.
      */}
      {provider === 'sharepoint' && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-500">
          Indexing reads with your own access, and every result is re-checked against the
          reader&apos;s live permissions — so indexing a library never widens what anyone can see.
        </p>
      )}

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
                {watch.syncStatus === 'error' && provider !== 'sharepoint' && (
                  <button
                    onClick={() => repair(watch)}
                    disabled={busy}
                    className="shrink-0 text-amber-600 hover:text-amber-800 disabled:opacity-50 dark:text-amber-500 dark:hover:text-amber-300"
                    aria-label={`Repair ${watch.scopeLabel || watch.scopeKey}`}
                    title="Rebind this watch to your connection and resume polling where it stopped — nothing is re-fetched"
                  >
                    Repair
                  </button>
                )}
                <button
                  onClick={() => reindex(watch)}
                  disabled={busy}
                  className="shrink-0 text-gray-400 hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-200"
                  aria-label={`Re-index ${watch.scopeLabel || watch.scopeKey}`}
                  title="Clear Renkei's indexed copy and re-read from scratch"
                >
                  Re-index
                </button>
                <RemoveButton
                  label="Remove"
                  accessibleLabel={`Stop indexing ${watch.scopeLabel || watch.scopeKey}`}
                  disabled={busy}
                  onClick={() => remove(watch)}
                />
              </div>
              {watch.lastError && (
                <p className="mt-0.5 pl-4 text-red-600 dark:text-red-400">{watch.lastError}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && provider === 'sharepoint' && (
        <div className="mt-2 rounded-md border border-gray-200 p-2 dark:border-gray-800">
          <SitePicker
            tenantId={tenantId}
            busy={busy}
            onPick={(driveId, siteId) => void add(driveId, siteId)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {adding && provider !== 'sharepoint' && (
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

/**
 * Find a site, then choose one of its libraries.
 *
 * Two steps because Graph offers no third option: `/sites` requires a search
 * term, so "show me everything I could index" is not a question it answers.
 * The opening list is therefore the sites the user FOLLOWS — usually the
 * handful they actually work in — with search for everything else. An empty
 * follow list is normal rather than an error, so it says so and points at the
 * search box instead of showing a failure.
 */
function SitePicker({
  tenantId,
  busy,
  onPick,
  onCancel,
}: {
  tenantId: string;
  busy: boolean;
  onPick: (driveId: string, siteId: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sites, setSites] = useState<Site[] | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [libraries, setLibraries] = useState<Option[] | null>(null);
  const [choice, setChoice] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSites = useCallback(
    async (search: string) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/tenant/${tenantId}/watches/options?provider=sharepoint` +
            (search ? `&q=${encodeURIComponent(search)}` : '')
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setError(data.error ?? 'Could not list sites.');
          return;
        }
        setSites(Array.isArray(data.sites) ? data.sites : []);
      } catch {
        setError('Could not reach the server.');
      } finally {
        setLoading(false);
      }
    },
    [tenantId]
  );

  // The followed-sites list, once, when the picker opens.
  useEffect(() => {
    void loadSites('');
  }, [loadSites]);

  async function chooseSite(chosen: Site) {
    setSite(chosen);
    setLibraries(null);
    setChoice('');
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/tenant/${tenantId}/watches/options?provider=sharepoint&site=${encodeURIComponent(
          chosen.id
        )}`
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? 'Could not list libraries.');
        return;
      }
      setLibraries(Array.isArray(data.options) ? data.options : []);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }

  if (site) {
    return (
      <div>
        <div className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
          <BackButton
            label="Sites"
            onClick={() => {
              setSite(null);
              setLibraries(null);
              setError(null);
            }}
          />
          <span className="min-w-0 truncate font-medium">{site.name}</span>
        </div>

        {loading && <p className="mt-2 text-xs text-gray-500">Loading libraries…</p>}
        {error && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{error}</p>}

        {libraries !== null && libraries.length === 0 && !loading && (
          <p className="mt-2 text-xs text-gray-500">That site has no document libraries.</p>
        )}

        {libraries !== null && libraries.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              className="min-w-48 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="">Choose a library…</option>
              {libraries.map((library) => (
                <option key={library.key} value={library.key}>
                  {library.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => onPick(choice, site.id)}
              disabled={busy || !choice}
              className="rounded bg-gray-900 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
            >
              Start indexing
            </button>
          </div>
        )}

        <button onClick={onCancel} className="mt-2 block text-xs text-gray-500 hover:underline">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void loadSites(query.trim());
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sites by name"
          className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Search
        </button>
      </form>

      {loading && <p className="mt-2 text-xs text-gray-500">Loading sites…</p>}
      {error && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{error}</p>}

      {sites !== null && sites.length === 0 && !loading && !error && (
        <p className="mt-2 text-xs text-gray-500">
          {query
            ? `No site matched "${query}".`
            : 'You are not following any sites — search for one by name above.'}
        </p>
      )}

      {sites !== null && sites.length > 0 && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {sites.map((entry) => (
            <li key={entry.id}>
              <button
                onClick={() => void chooseSite(entry)}
                className="w-full truncate rounded px-1 py-0.5 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-900"
                title={entry.webUrl}
              >
                {entry.name || entry.webUrl}
              </button>
            </li>
          ))}
        </ul>
      )}

      <button onClick={onCancel} className="mt-2 text-xs text-gray-500 hover:underline">
        Cancel
      </button>
    </div>
  );
}
