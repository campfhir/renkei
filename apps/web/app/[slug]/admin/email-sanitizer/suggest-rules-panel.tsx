'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';

interface Suggestion {
  category: string;
  matchType: string;
  matchValue: string;
  senderKey: string | null;
  rationale: string;
}

/**
 * "Ask the org model for rules" — rendered only when the org HAS a model
 * (the page checks; no model, no feature). Suggestions are drawn from
 * corrections users made on Mail review and from unsure classifications;
 * each accepted one is created through the ordinary rules API, so this
 * panel can propose but never silently change policy.
 */
export default function SuggestRulesPanel({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [addBusy, setAddBusy] = useState<number | null>(null);

  async function suggest() {
    setBusy(true);
    setError(null);
    setSuggestions(null);
    setAdded(new Set());
    const result = await sendJsonFull<{ suggestions: Suggestion[] }>(
      `/api/admin/${slug}/email-sanitizer/suggest-rules`,
      'POST'
    );
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'Could not get suggestions');
      return;
    }
    setSuggestions(result.data.suggestions);
  }

  async function add(index: number, suggestion: Suggestion) {
    setAddBusy(index);
    setError(null);
    const result = await sendJsonFull(`/api/admin/${slug}/email-sanitizer/rules`, 'POST', {
      category: suggestion.category,
      matchType: suggestion.matchType,
      matchValue: suggestion.matchValue,
      ...(suggestion.senderKey ? { senderKey: suggestion.senderKey } : {}),
    });
    setAddBusy(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setAdded((current) => new Set(current).add(index));
    // Server components re-render; the rules list itself refetches on reload.
    router.refresh();
  }

  return (
    <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Suggest rules with your org model</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Drafts new sender rules from corrections people made on Mail review and from messages
            the classifier was unsure about. Nothing is added until you approve it.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void suggest()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Thinking…' : suggestions ? 'Suggest again' : '✨ Suggest rules'}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {suggestions && (
        <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-900">
          {suggestions.map((suggestion, index) => (
            <li
              key={`${suggestion.matchType}:${suggestion.matchValue}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm">
                  <span className="font-mono text-xs">{suggestion.matchType}</span>{' '}
                  <span className="font-medium break-all">“{suggestion.matchValue}”</span>
                  {' → '}
                  <span className="font-medium">{suggestion.category}</span>
                  {suggestion.senderKey && (
                    <span className="ml-1 text-xs text-gray-500">({suggestion.senderKey})</span>
                  )}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{suggestion.rationale}</p>
              </div>
              {added.has(index) ? (
                <span className="text-xs font-medium text-green-600">Added ✓</span>
              ) : (
                <button
                  type="button"
                  disabled={addBusy !== null}
                  onClick={() => void add(index, suggestion)}
                  className="rounded-md border border-blue-600 px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-900/20"
                >
                  {addBusy === index ? 'Adding…' : 'Add rule'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {suggestions && added.size > 0 && (
        <p className="mt-2 text-xs text-gray-500">
          Added rules are live now; reload the page to see them in the list below.
        </p>
      )}
    </div>
  );
}
