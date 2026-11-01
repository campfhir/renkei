'use client';

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
import { optionFinePrint, visibleScopeGroups } from './scope-picker.model';

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
 *
 * What is offered and the fine print are scope-picker.model.ts's.
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
  return (
    <div className="@container space-y-4">
      {visibleScopeGroups(groups, options, available).map(({ group, options: groupOptions }) => {
        return (
          <div key={group.id}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {group.label}
            </p>
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 @md:grid-cols-2 @2xl:grid-cols-3">
              {groupOptions.map((option) => {
                const finePrint = optionFinePrint(option, audience);
                return (
                  <label key={option.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={checked.has(option.id)}
                      onChange={(e) => onToggle(option.id, e.target.checked)}
                    />
                    <span className="min-w-0">
                      {option.label}
                      {finePrint.scopes !== null && (
                        <span
                          className="block truncate font-mono text-[11px] text-gray-400 dark:text-gray-500"
                          title={finePrint.scopesTitle}
                        >
                          {finePrint.scopes}
                        </span>
                      )}
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {finePrint.hint}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
