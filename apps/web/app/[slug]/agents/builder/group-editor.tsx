'use client';

/**
 * The editor-panel body for a group node — just its name: a group is pure
 * structure, so there is nothing else to configure. The steps inside are
 * edited on the canvas.
 */

import type { GroupStep } from '@renkei/agents';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';

export function GroupEditor({
  group,
  onChange,
  issues,
}: {
  group: GroupStep;
  onChange: (group: GroupStep) => void;
  issues: string[];
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor={`group-name-${group.id}`}>
          Group name
        </label>
        <input
          id={`group-name-${group.id}`}
          className={inputClass}
          value={group.name}
          maxLength={80}
          placeholder="e.g. Triage"
          onChange={(event) => onChange({ ...group, name: event.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Groups only organize the canvas — the steps inside run exactly as if the group weren’t
          there.
        </p>
      </div>

      {issues.length > 0 ? (
        <ul className="space-y-1">
          {issues.map((issue) => (
            <li key={issue} className="text-xs text-red-600 dark:text-red-400">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
