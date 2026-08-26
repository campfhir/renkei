'use client';

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
import { optionWithin } from '@/lib/scope-catalog';

/**
 * Grouped, responsive scope checkboxes — the one rendering of a scope
 * catalog, shared by the admin forms (choosing the org ceiling) and the user
 * connect cards (narrowing within it).
 *
 * The two audiences see different fine print, which is the point of the
 * `audience` prop. An operator setting a ceiling gets the raw OAuth scopes and
 * the tool names they cover, because that is what the decision turns on.
 * Someone deciding whether to hand over their own mailbox gets neither:
 * `Mail.Read` and `outlook_list_messages` are facts about our implementation,
 * and showing them in place of "Read your email" makes the checkbox look like
 * consent without informing it.
 *
 * Each checkbox is a capability bundle; checked state is keyed by the
 * option's id. `available` is
 * the ceiling: an option renders only when EVERY scope it needs is inside
 * it — a user must not even see a capability the org withheld, and an empty
 * group disappears with its options.
 *
 * Columns go 1 → 2 → 3 against the width of THIS picker, not the viewport,
 * which is the whole reason for the `@container` here. Viewport breakpoints
 * were actively wrong: the connectors page nests a picker inside a card
 * inside a page column, so on a 1440px screen `xl:grid-cols-3` split roughly
 * 290px of usable width three ways and rendered a checkbox label one word
 * per line. The container reads the space the picker actually has.
 */
export default function ScopePicker({
  groups,
  options,
  checked,
  onToggle,
  available,
  audience = 'admin',
}: {
  groups: ScopeGroup[];
  options: ScopeOption[];
  checked: ReadonlySet<string>;
  onToggle: (optionId: string, on: boolean) => void;
  /** Scopes the caller may choose from; omit for the full catalog. */
  available?: readonly string[];
  /** Who is reading. Defaults to the operator view. */
  audience?: 'admin' | 'user';
}) {
  const allowed = available === undefined ? null : new Set(available);
  const visible = options.filter((option) => allowed === null || optionWithin(option, allowed));

  return (
    <div className="@container space-y-4">
      {groups.map((group) => {
        const groupOptions = visible.filter((option) => option.group === group.id);
        if (groupOptions.length === 0) return null;
        return (
          <div key={group.id}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {group.label}
            </p>
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 @md:grid-cols-2 @2xl:grid-cols-3">
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
                    {audience === 'admin' && (
                      <span
                        className="block truncate font-mono text-[11px] text-gray-400 dark:text-gray-500"
                        title={option.scopes.join(' ')}
                      >
                        {option.scopes.length === 1
                          ? option.scopes[0]
                          : `${option.scopes.length} scopes: ${option.scopes.join(' ')}`}
                      </span>
                    )}
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {audience === 'user' ? (option.userHint ?? option.hint) : option.hint}
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
