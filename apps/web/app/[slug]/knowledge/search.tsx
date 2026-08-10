'use client';

import React, { useState } from 'react';
import { searchMyKnowledge, type KnowledgeSearchHit, type KnowledgeSearchResult } from './actions';
import { signInUrl } from '@/lib/sign-in-url';

const K_OPTIONS = [5, 10, 20, 30];

function formatDistance(distance: number): string {
  return Number.isFinite(distance) ? distance.toFixed(3) : String(distance);
}

/** Display name per connector — matches the labels used elsewhere in the UI. */
function providerLabel(provider: string): string {
  switch (provider) {
    case 'webex':
      return 'WebEx';
    case 'microsoft':
      return 'Outlook';
    case 'zoom':
      return 'Zoom';
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

function providerBadgeClass(provider: string): string {
  switch (provider) {
    case 'webex':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'microsoft':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
    case 'zoom':
      return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300';
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

/** Whichever timestamp field this connector recorded, formatted for display. */
function whenFor(hit: KnowledgeSearchHit): string | null {
  const raw = str(hit.metadata.when) || str(hit.metadata.created) || str(hit.metadata.startTime);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString();
}

const EXCERPT_CHARS = 400;

function HitCard({ hit }: { hit: KnowledgeSearchHit }) {
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const when = whenFor(hit);
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
          {providerLabel(hit.provider)}
        </span>
        {when && <span className="text-xs text-gray-500 dark:text-gray-400">{when}</span>}
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">
          distance {formatDistance(hit.distance)}
        </span>
      </div>

      <p className="mt-2 font-medium">{titleFor(hit)}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{shown}</p>

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

      {showDetails && (
        <div className="mt-2 rounded-md bg-gray-100 p-2 text-xs dark:bg-gray-900">
          <p className="mb-1 font-mono text-gray-600 dark:text-gray-400">
            {hit.provider}:{hit.refId}
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
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  async function runSearch(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true);
    try {
      const res = await searchMyKnowledge(tenantId, query, k);
      if (res.signedOut) {
        window.location.href = signInUrl(tenantId, window.location.pathname);
        return;
      }
      setResult(res);
      setHasSearched(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={(e) => void runSearch(e)} className="mb-6 flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What are you looking for?"
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
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
      </form>

      {!hasSearched && !busy && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Type something to search what's indexed for you.
        </p>
      )}

      {result?.error && (
        <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
          {result.error}
        </p>
      )}

      {hasSearched && !result?.error && (
        <div className="space-y-4">
          {result && result.hits.length === 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-400">No accessible results.</p>
          )}
          {result?.hits.map((hit) => (
            <HitCard key={`${hit.provider}:${hit.refId}`} hit={hit} />
          ))}
          {result && result.elided > 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {result.elided} result{result.elided === 1 ? '' : 's'} withheld — your access couldn't
              be verified at the source.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
