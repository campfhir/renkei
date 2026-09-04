'use client';

/**
 * The model picker in the composer row, with the thinking switch for
 * models that take one. Switching a model mid-chat is fine — every turn
 * resends the whole conversation anyway — and the note says as much once
 * there is a history to resend.
 */

import type { ModelOption } from '@/lib/chat/views';

export default function ModelSelect({
  models,
  value,
  onChange,
  thinking,
  onThinking,
  hasHistory,
}: {
  models: ModelOption[];
  value: string | null;
  onChange: (id: string) => void;
  thinking: boolean;
  onThinking: (on: boolean) => void;
  hasHistory: boolean;
}) {
  const current = models.find((model) => model.id === value) ?? null;
  if (models.length === 0) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Model"
        title={
          hasHistory ? 'Switching resends the whole conversation to the new model.' : undefined
        }
        className="max-w-[10rem] truncate rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
      {current?.supportsThinking ? (
        <label
          className="flex items-center gap-1 text-gray-600 dark:text-gray-400"
          title="Show the model's extended thinking (uses part of the reply budget)."
        >
          <input
            type="checkbox"
            checked={thinking}
            onChange={(event) => onThinking(event.target.checked)}
          />
          Think
        </label>
      ) : null}
    </div>
  );
}
