'use client';

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
import { optionWithin } from '@/lib/scope-catalog';

/**
 * Grouped, responsive scope checkboxes — the one rendering of a scope
 * catalog, shared by the admin forms (choosing the org ceiling) and the user
 * connect cards (narrowing within it).
 *
 * Each checkbox is a capability bundle; checked state is keyed by the
 * option's id, and its underlying scopes ride in fine print. `available` is
 * the ceiling: an option renders only when EVERY scope it needs is inside
 * it — a user must not even see a capability the org withheld, and an empty
 * group disappears with its options. Columns go 1 → 2 → 3 with viewport
 * width.
 */
export default function ScopePicker({
  groups,
  options,
  checked,
  onToggle,
  available,
}: {
  groups: ScopeGroup[];
  options: ScopeOption[];
  checked: ReadonlySet<string>;
  onToggle: (optionId: string, on: boolean) => void;
  /** Scopes the caller may choose from; omit for the full catalog. */
  available?: readonly string[];
}) {
  const allowed = available === undefined ? null : new Set(available);
  const visible = options.filter((option) => allowed === null || optionWithin(option, allowed));

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const groupOptions = visible.filter((option) => option.group === group.id);
        if (groupOptions.length === 0) return null;
        return (
          <div key={group.id}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {group.label}
            </p>
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
              {groupOptions.map((option) => (
                <label key={option.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checked.has(option.id)}
                    onChange={(e) => onToggle(option.id, e.target.checked)}
                  />
                  <span className="min-w-0">
                    {option.label}
                    <span
                      className="block truncate font-mono text-[11px] text-gray-400 dark:text-gray-500"
                      title={option.scopes.join(' ')}
                    >
                      {option.scopes.length === 1
                        ? option.scopes[0]
                        : `${option.scopes.length} scopes: ${option.scopes.join(' ')}`}
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {option.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
