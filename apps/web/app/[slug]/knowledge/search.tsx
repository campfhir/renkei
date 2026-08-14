'use client';

import StructuredContent from './structured-content';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { searchMyKnowledge, type KnowledgeSearchHit, type KnowledgeSearchResult } from './actions';
import { signInUrl } from '@/lib/sign-in-url';

const K_OPTIONS = [10, 20, 30];

/**
 * The sources a person can narrow to, in their own vocabulary. The mapping
 * onto storage (provider + metadata.kind) lives server-side in
 * sourceFiltersFor, so this list only has to be nameable, not accurate
 * about the schema.
 */
const SOURCE_OPTIONS: { id: string; label: string }[] = [
  { id: 'outlook_mail', label: 'Email' },
  { id: 'outlook_calendar', label: 'Calendar' },
  { id: 'outlook_tasks', label: 'Tasks' },
  { id: 'confluence', label: 'Confluence' },
  { id: 'jira', label: 'Jira' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'webex', label: 'WebEx' },
];

const DATE_PRESETS: { id: string; label: string; days: number | null }[] = [
  { id: 'any', label: 'Any time', days: null },
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
  { id: '365', label: 'Last year', days: 365 },
];

/** Display name per connector — matches the labels used elsewhere in the UI. */
function providerLabel(provider: string): string {
  switch (provider) {
    case 'webex':
      return 'WebEx';
    case 'microsoft':
      return 'Outlook';
    case 'zoom':
      return 'Zoom';
    case 'confluence':
      return 'Confluence';
    case 'jira':
      return 'Jira';
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

/**
 * What a result IS, in the same words the filter chips use.
 *
 * The connector name alone can't say it: Microsoft covers mail, calendar
 * and tasks, so badging all three "Outlook" both contradicts the "Email"
 * chip the user just clicked and hides which of the three a result is.
 * Falls back to the connector name when a chunk carries no kind.
 */
function sourceLabel(hit: KnowledgeSearchHit): string {
  if (hit.provider === 'microsoft') {
    switch (str(hit.metadata.kind)) {
      case 'msg':
        return 'Email';
      case 'evt':
        return 'Calendar';
      case 'task':
        return 'Tasks';
    }
  }
  return providerLabel(hit.provider);
}

function providerBadgeClass(provider: string): string {
  switch (provider) {
    case 'webex':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'microsoft':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
    case 'zoom':
      return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300';
    case 'confluence':
      return 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300';
    case 'jira':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300';
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300';
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A human title for a chunk, from whichever metadata field the connector set. */
function titleFor(hit: KnowledgeSearchHit): string {
  const metaTitle = str(hit.metadata.subject) || str(hit.metadata.topic) || str(hit.metadata.title);
  if (metaTitle) return metaTitle;
  const firstLine = hit.content.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 100 ? `${firstLine.slice(0, 99)}…` : firstLine || '(untitled)';
}

/** The document's own date. Prefers the real column; metadata is the fallback for pre-backfill rows. */
function whenFor(hit: KnowledgeSearchHit): string | null {
  const raw =
    hit.sourceAt ||
    str(hit.metadata.when) ||
    str(hit.metadata.created) ||
    str(hit.metadata.startTime);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString();
}

/**
 * Cosine distance rendered as something a person can act on. The raw number
 * is backwards (smaller is closer) and unitless, so it told a reader
 * nothing; it stays available under "Show details" for debugging.
 */
function relevanceLabel(distance: number): { label: string; className: string } {
  if (!Number.isFinite(distance)) return { label: 'unknown', className: 'text-gray-400' };
  if (distance < 0.25)
    return { label: 'Strong match', className: 'text-emerald-700 dark:text-emerald-400' };
  if (distance < 0.4) return { label: 'Good match', className: 'text-blue-700 dark:text-blue-400' };
  if (distance < 0.55)
    return { label: 'Possible match', className: 'text-amber-700 dark:text-amber-400' };
  return { label: 'Weak match', className: 'text-gray-500 dark:text-gray-400' };
}

/** The document a chunk belongs to — chunk refIds are `${refId}#0001`. */
function documentRefOf(hit: KnowledgeSearchHit): string {
  const hash = hit.refId.lastIndexOf('#');
  return hash > 0 ? hit.refId.slice(0, hash) : hit.refId;
}

/** Query words worth highlighting — short filler words would light up everything. */
function highlightTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 2)
    ),
  ];
}

/**
 * Excerpt with query terms marked. Terms are escaped before they reach a
 * RegExp — the query is user input and must never be able to compile as a
 * pattern.
 */
function Highlighted({ text, terms }: { text: string; terms: string[] }): React.ReactNode {
  if (terms.length === 0) return text;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  // split() with ONE capture group puts the captured separators at odd
  // indices — that parity is the match test. Re-testing each part with the
  // same /g regex would be wrong: `test` advances `lastIndex`, so identical
  // parts would match or miss depending on where the previous call stopped.
  const parts = text.split(pattern);
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-500/40">
        {part}
      </mark>
    ) : (
      <React.Fragment key={index}>{part}</React.Fragment>
    )
  );
}

const EXCERPT_CHARS = 400;

/** One document, with every chunk of it that matched. */
interface DocumentGroup {
  key: string;
  best: KnowledgeSearchHit;
  others: KnowledgeSearchHit[];
}

/**
 * Collapse chunk-level hits into documents. A long page split across five
 * chunks used to occupy five cards and crowd out everything else; now it is
 * one card showing its closest passage, with the rest available on demand.
 */
function groupByDocument(hits: KnowledgeSearchHit[]): DocumentGroup[] {
  const groups = new Map<string, DocumentGroup>();
  for (const hit of hits) {
    const key = `${hit.provider}:${documentRefOf(hit)}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, best: hit, others: [] });
      continue;
    }
    if (hit.distance < existing.best.distance) {
      existing.others.push(existing.best);
      existing.best = hit;
    } else {
      existing.others.push(hit);
    }
  }
  return [...groups.values()].sort((a, b) => a.best.distance - b.best.distance);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
    >
      {copied ? 'Copied' : 'Copy text'}
    </button>
  );
}

function HitCard({ group, terms }: { group: DocumentGroup; terms: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const hit = group.best;
  const when = whenFor(hit);
  const relevance = relevanceLabel(hit.distance);
  const webLink =
    str(hit.metadata.webLink) || str(hit.metadata.note_link) || str(hit.metadata.join_url);
  const needsTruncation = hit.content.length > EXCERPT_CHARS;
  const shown =
    expanded || !needsTruncation ? hit.content : `${hit.content.slice(0, EXCERPT_CHARS)}…`;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${providerBadgeClass(hit.provider)}`}
        >
          {sourceLabel(hit)}
        </span>
        {when && <span className="text-xs text-gray-500 dark:text-gray-400">{when}</span>}
        {group.others.length > 0 && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {group.others.length + 1} matching sections
          </span>
        )}
        <span className={`ml-auto text-xs font-medium ${relevance.className}`}>
          {relevance.label}
        </span>
      </div>

      <p className="mt-2 break-words font-medium">{titleFor(hit)}</p>
      <StructuredContent
        text={shown}
        title={titleFor(hit)}
        renderText={(value) => <Highlighted text={value} terms={terms} />}
      />

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        {needsTruncation && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {expanded ? 'Show less' : 'Show full content'}
          </button>
        )}
        {group.others.length > 0 && (
          <button
            type="button"
            onClick={() => setShowOthers((o) => !o)}
            className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {showOthers
              ? 'Hide other sections'
              : `Show ${group.others.length} other matching section${group.others.length === 1 ? '' : 's'}`}
          </button>
        )}
        <CopyButton text={hit.content} />
        <button
          type="button"
          onClick={() => setShowDetails((d) => !d)}
          className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
        {webLink && (
          <a
            href={webLink}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Open source
          </a>
        )}
      </div>

      {showOthers && (
        <div className="mt-2 space-y-2 border-l-2 border-gray-200 pl-3 dark:border-gray-800">
          {group.others.map((other) => (
            <p
              key={other.refId}
              className="whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-400"
            >
              <Highlighted
                text={
                  other.content.length > EXCERPT_CHARS
                    ? `${other.content.slice(0, EXCERPT_CHARS)}…`
                    : other.content
                }
                terms={terms}
              />
            </p>
          ))}
        </div>
      )}

      {showDetails && (
        <div className="mt-2 rounded-md bg-gray-100 p-2 text-xs dark:bg-gray-900">
          <p className="mb-1 break-all font-mono text-gray-600 dark:text-gray-400">
            {hit.provider}:{hit.refId} — distance {hit.distance.toFixed(3)}
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-gray-600 dark:text-gray-400">
            {JSON.stringify(hit.metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function KnowledgeSearch({ tenantId }: { tenantId: string }) {
  const [query, setQuery] = useState('');
  const [k, setK] = useState(10);
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [datePreset, setDatePreset] = useState('any');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null);
  const [searchedQuery, setSearchedQuery] = useState('');
  const [hasSearched, setHasSearched] = useState(false);

  const groups = useMemo(() => groupByDocument(result?.hits ?? []), [result]);
  const terms = useMemo(() => highlightTerms(searchedQuery), [searchedQuery]);

  function toggleSource(id: string) {
    setSources((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * An empty query is a valid request, not a no-op: the server answers it
   * with the newest indexed items, so the filters double as a browser.
   */
  const run = useCallback(
    async (currentQuery: string) => {
      setBusy(true);
      try {
        const days = DATE_PRESETS.find((preset) => preset.id === datePreset)?.days ?? null;
        const after =
          days === null ? undefined : new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
        const res = await searchMyKnowledge(tenantId, currentQuery, k, {
          sources: [...sources],
          ...(after ? { after } : {}),
        });
        if (res.signedOut) {
          window.location.href = signInUrl(tenantId, window.location.pathname);
          return;
        }
        setResult(res);
        setSearchedQuery(currentQuery);
        setHasSearched(true);
      } finally {
        setBusy(false);
      }
    },
    [tenantId, k, sources, datePreset]
  );

  async function runSearch(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    await run(query);
  }

  // Land on content rather than an empty box, and re-browse whenever the
  // filters change while there is no query — that is what makes the source
  // chips usable as "show me the newest mail / WebEx / Confluence".
  useEffect(() => {
    if (query.trim()) return;
    void run('');
    // `run` already closes over the filter state it depends on.
  }, [run, query]);

  /** "12 results across Email and Confluence" — the shape of the answer, before scrolling. */
  const summary = useMemo(() => {
    if (!result || groups.length === 0) return null;
    // Browsing returns the newest few from EACH selected source, so a
    // per-source count is the honest summary: "4 from Jira" tells you Jira
    // has four indexed items, where a merged total tells you nothing about
    // whether a source is quiet or simply absent.
    const counts = new Map<string, number>();
    for (const group of groups) {
      const label = sourceLabel(group.best);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const labels = [...counts.keys()];
    if (result.browsing) {
      const parts = [...counts.entries()].map(([label, count]) => `${count} from ${label}`);
      return `Most recent — ${parts.join(', ')}`;
    }
    const list =
      labels.length === 1
        ? labels[0]
        : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    return `${groups.length} result${groups.length === 1 ? '' : 's'} from ${list}`;
  }, [result, groups]);

  return (
    <div>
      <form onSubmit={(e) => void runSearch(e)} className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, or leave blank to browse the newest"
            className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <select
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {DATE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <select
            value={k}
            onChange={(e) => setK(Number(e.target.value))}
            className="rounded-md border border-gray-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {K_OPTIONS.map((option) => (
              <option key={option} value={option}>
                Show {option}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || !query.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">Sources:</span>
          {SOURCE_OPTIONS.map((option) => {
            const active = sources.has(option.id);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => toggleSource(option.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                  active
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
                }`}
              >
                {option.label}
              </button>
            );
          })}
          {sources.size > 0 && (
            <button
              type="button"
              onClick={() => setSources(new Set())}
              className="text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              Clear
            </button>
          )}
          {sources.size === 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500">all sources</span>
          )}
        </div>
      </form>

      {!hasSearched && busy && <p className="text-sm text-gray-600 dark:text-gray-400">Loading…</p>}

      {result?.error && (
        <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
          {result.error}
        </p>
      )}

      {hasSearched && !result?.error && (
        <div className="space-y-4">
          {summary && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {summary}
              {(result?.elided ?? 0) > 0 && `, ${result?.elided} withheld`}
            </p>
          )}
          {groups.length === 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {result?.browsing
                ? sources.size > 0 || datePreset !== 'any'
                  ? 'Nothing indexed yet for those filters.'
                  : 'Nothing indexed for you yet — connect a source on the Connectors page.'
                : `No accessible results${sources.size > 0 || datePreset !== 'any' ? ' for those filters.' : '.'}`}
            </p>
          )}
          {groups.map((group) => (
            <HitCard key={group.key} group={group} terms={terms} />
          ))}
          {result && result.elided > 0 && (
            <>
              {result.elided - (result.unverified ?? 0) > 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {result.elided - (result.unverified ?? 0)} result
                  {result.elided - (result.unverified ?? 0) === 1 ? '' : 's'} withheld — you
                  don&apos;t have access at the source.
                </p>
              )}
              {/* Said separately, and in amber: this one is a failure, not a
                  permission decision, and it is worth retrying. */}
              {(result.unverified ?? 0) > 0 && (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  {result.unverified} result{result.unverified === 1 ? '' : 's'} couldn&apos;t be
                  checked in time — the source didn&apos;t respond. Try again in a moment.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
