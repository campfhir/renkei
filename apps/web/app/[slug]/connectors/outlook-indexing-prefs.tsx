'use client';

import { useEffect, useState } from 'react';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

/**
 * The per-user opt-ins for what Renkei does with Outlook in the background.
 * Everything defaults OFF: granting a scope powers the interactive tools,
 * and anything beyond that is a separate decision made here. Each toggle
 * saves immediately and takes effect within moments (the save triggers the
 * same bootstrap a fresh connect runs).
 *
 * Mail is never indexed — it is personal. The Mail toggle only lets new
 * mail wake the person's agents through the "An email arrives" trigger;
 * agents then read the message live, as this person. Tasks (Microsoft To
 * Do) are the one Outlook category that goes into knowledge search.
 * Calendar has no toggle: it is neither indexed nor watched.
 */

const CATEGORIES = [
  {
    key: 'mail' as const,
    label: 'Mail',
    hint:
      'New mail can wake your agents through the "An email arrives" trigger. Messages are read ' +
      'live as you and are never indexed.',
  },
  {
    key: 'tasks' as const,
    label: 'Tasks',
    hint: 'Microsoft To Do items, indexed into knowledge search',
  },
];

type Prefs = { mail: boolean; tasks: boolean };

function noticeFor(key: keyof Prefs, on: boolean): string {
  if (key === 'mail') {
    return on
      ? 'New mail will start waking agents with an "An email arrives" trigger within a few minutes. ' +
          'Nothing is indexed.'
      : 'New mail no longer wakes your agents.';
  }
  return on
    ? 'Indexing starts in the background within a few minutes.'
    : 'Indexing stopped. Already-indexed tasks stay searchable; turning it back on resumes where it left off.';
}

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
      setNotice(noticeFor(key, on));
    } catch {
      setPrefs(prefs);
      setNotice('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const indexingAnchor = useCoachAnchor('outlook-indexing');

  return (
    <div {...indexingAnchor} className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
        What runs in the background
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
