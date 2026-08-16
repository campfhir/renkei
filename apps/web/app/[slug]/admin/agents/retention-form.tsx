'use client';

import { useState } from 'react';
import { sendJson } from '@/lib/fetch-json';

const OPTIONS = [
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
];

export function RetentionForm({ slug, current }: { slug: string; current: number }) {
  const [value, setValue] = useState(current);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-8 rounded-md border border-gray-200 p-4 dark:border-gray-800">
      <p className="text-sm font-semibold">Run history retention</p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        How long agent run records (including their step details) are kept before being deleted.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <select
          aria-label="Retention window"
          value={value}
          onChange={(event) => setValue(Number(event.target.value))}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
        >
          {OPTIONS.map((option) => (
            <option key={option.days} value={option.days}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={state === 'saving' || value === current}
          onClick={async () => {
            setState('saving');
            setError(null);
            const failed = await sendJson(`/api/admin/${slug}/agents/retention`, 'PUT', {
              agentRunRetentionDays: value,
            });
            if (failed) {
              setState('error');
              setError(failed);
            } else {
              setState('saved');
            }
          }}
          className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {state === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {state === 'saved' ? <span className="text-xs text-green-600">Saved.</span> : null}
        {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      </div>
    </div>
  );
}
