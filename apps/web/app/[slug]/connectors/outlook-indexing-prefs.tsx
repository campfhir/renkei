'use client';

import { useEffect, useState } from 'react';

/**
 * The per-user opt-in for what Outlook content Renkei indexes. Everything
 * defaults OFF: granting a scope powers the interactive tools, and feeding
 * that content into the knowledge index is a separate decision made here.
 * Each toggle saves immediately and takes effect within moments (the save
 * triggers the same bootstrap a fresh connect runs).
 */

const CATEGORIES = [
  {
    key: 'mail' as const,
    label: 'Mail',
    hint: 'Inbox messages, cleaned by the email sanitizer before indexing',
  },
  {
    key: 'calendar' as const,
    label: 'Calendar',
    hint: 'Event subjects, bodies and attendees',
  },
  {
    key: 'tasks' as const,
    label: 'Tasks',
    hint: 'Microsoft To Do items',
  },
];

type Prefs = { mail: boolean; calendar: boolean; tasks: boolean };

export default function OutlookIndexingPrefs({ tenantId }: { tenantId: string }) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/microsoft/${tenantId}/indexing`);
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        if (!cancelled && data.indexing) setPrefs(data.indexing);
      } catch {
        // The section renders disabled until the next visit.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  async function toggle(key: keyof Prefs, on: boolean) {
    if (!prefs) return;
    const next = { ...prefs, [key]: on };
    setPrefs(next);
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/microsoft/${tenantId}/indexing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setPrefs(prefs);
        setNotice(data.error ?? 'Could not save.');
        return;
      }
      setNotice(
        on
          ? 'Indexing starts in the background within a few minutes.'
          : 'Indexing stopped. Already-indexed content stays searchable; turning it back on resumes where it left off.'
      );
    } catch {
      setPrefs(prefs);
      setNotice('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
        What gets indexed
        <span className="ml-1 font-normal">
          — off by default; your scopes only power the tools until you opt in here
        </span>
      </p>
      <div className="mt-2 space-y-1.5">
        {CATEGORIES.map((category) => (
          <label key={category.key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={prefs?.[category.key] ?? false}
              disabled={prefs === null || busy}
              onChange={(event) => void toggle(category.key, event.target.checked)}
              className="mt-0.5"
            />
            <span>
              {category.label}
              <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                — {category.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
      {notice && <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{notice}</p>}
    </div>
  );
}
