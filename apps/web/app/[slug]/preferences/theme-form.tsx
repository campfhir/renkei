'use client';

/**
 * Auto/Light/Dark, applied the instant it's picked — not just on save — so
 * choosing one is its own preview. Saving is what makes it survive a reload
 * or follow to another browser; picking without saving still lasts for this
 * browser's next visit via the same localStorage cache theme-script.tsx
 * reads (see lib/theme.ts), just not anywhere else.
 */

import { useState } from 'react';
import type { ThemeMode } from '@renkei/user-prefs/prefs';
import { applyThemeMode, setStoredThemeMode } from '@/lib/theme';

const THEME_MODES: readonly { value: ThemeMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Matches your system, and follows it if it changes.' },
  { value: 'light', label: 'Light', hint: '' },
  { value: 'dark', label: 'Dark', hint: '' },
];

export default function ThemeForm({
  tenantId,
  initial,
}: {
  tenantId: string;
  initial: ThemeMode;
}) {
  const [mode, setMode] = useState<ThemeMode>(initial);
  const [saved, setSaved] = useState<ThemeMode>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  function choose(next: ThemeMode) {
    setMode(next);
    setStatus('idle');
    setStoredThemeMode(tenantId, next);
    applyThemeMode(next);
  }

  async function save() {
    setStatus('saving');
    try {
      const response = await fetch(`/api/tenant/${tenantId}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: { mode } }),
      });
      if (response.ok) {
        setSaved(mode);
        setStatus('saved');
      } else {
        setStatus('failed');
      }
    } catch {
      setStatus('failed');
    }
  }

  return (
    <section
      aria-labelledby="appearance-heading"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="appearance-heading" className="font-semibold">
        Appearance
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        How Renkei looks on this and every other device you sign into.
      </p>

      <fieldset className="mt-3">
        <legend className="sr-only">Theme</legend>
        <div className="flex flex-wrap gap-4">
          {THEME_MODES.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="theme-mode"
                className="shrink-0"
                checked={mode === option.value}
                onChange={() => choose(option.value)}
              />
              {option.label}
              {option.hint ? (
                <span className="text-xs text-gray-500 dark:text-gray-400">{option.hint}</span>
              ) : null}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving' || mode === saved}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">Could not save.</span>
        ) : null}
      </div>
    </section>
  );
}
