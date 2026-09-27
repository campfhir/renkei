'use client';

/**
 * Auto/Light/Dark, applied the instant it's picked — not just on save — so
 * choosing one is its own preview. The pick goes into this browser's cache
 * (see lib/theme.ts), which is how the shell's ThemeSync — this tab's and
 * every other open tab's — learns to render it and, for Auto, to start
 * following the system again. Saving is what makes it survive: on the next
 * full load the saved preference wins and overwrites an unsaved pick, and
 * only the saved one follows to another browser.
 */

import { useState } from 'react';
import type { ThemeMode, ThemePrefs } from '@renkei/user-prefs/prefs';
import { applyThemeMode, setStoredThemeMode } from '@/lib/theme';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

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
  initial: ThemePrefs;
}) {
  const [prefs, setPrefs] = useState<ThemePrefs>(initial);
  const [saved, setSaved] = useState<ThemePrefs>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  function choose(mode: ThemeMode) {
    setPrefs((current) => ({ ...current, mode }));
    setStatus('idle');
    setStoredThemeMode(tenantId, mode);
    applyThemeMode(mode);
  }

  function chooseLineNumbers(codeLineNumbers: boolean) {
    setPrefs((current) => ({ ...current, codeLineNumbers }));
    setStatus('idle');
  }

  async function save() {
    setStatus('saving');
    try {
      const response = await fetch(`/api/tenant/${tenantId}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: prefs }),
      });
      if (response.ok) {
        setSaved(prefs);
        setStatus('saved');
      } else {
        setStatus('failed');
      }
    } catch {
      setStatus('failed');
    }
  }

  const anchor = useCoachAnchor('prefs-appearance');
  return (
    <section
      aria-labelledby="appearance-heading"
      {...anchor}
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
                checked={prefs.mode === option.value}
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

      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={prefs.codeLineNumbers}
          onChange={(event) => chooseLineNumbers(event.target.checked)}
        />
        <span>
          <span className="block">Show line numbers in code blocks</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            A gutter down the left of every fenced code block. It never rides along when you copy
            the code.
          </span>
        </span>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={
            status === 'saving' ||
            (prefs.mode === saved.mode && prefs.codeLineNumbers === saved.codeLineNumbers)
          }
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
