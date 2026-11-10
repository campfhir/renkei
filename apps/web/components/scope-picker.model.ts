/**
 * What the scope picker (scope-picker.tsx) offers: which capability boxes
 * show under which group headings, and the fine print under each. The
 * admin forms (choosing the org ceiling) and the connect cards (narrowing
 * within it) both draw through it. Pure; tested in scope-picker.model.test.ts.
 */

import { optionWithin, type ScopeGroup, type ScopeOption } from '@/lib/scope-catalog';

/** Who is reading: an operator setting the ceiling, or a person granting their own account. */
export type ScopePickerAudience = 'admin' | 'user';

export interface VisibleScopeGroup {
  group: ScopeGroup;
  options: ScopeOption[];
}

/**
 * The groups to draw, in catalog order, each with the options inside
 * `available` (the ceiling). An option shows only when EVERY scope it needs
 * is inside it — a person never sees a capability the org withheld — and a
 * group with nothing left disappears with its options. Omitting `available`
 * offers the whole catalog.
 */
export function visibleScopeGroups(
  groups: readonly ScopeGroup[],
  options: readonly ScopeOption[],
  available?: readonly string[]
): VisibleScopeGroup[] {
  const allowed = available === undefined ? null : new Set(available);
  const visible = options.filter((option) => allowed === null || optionWithin(option, allowed));
  return groups
    .map((group) => ({ group, options: visible.filter((option) => option.group === group.id) }))
    .filter((entry) => entry.options.length > 0);
}

/**
 * The lines under a box's label. An operator sees the raw OAuth scopes,
 * because that is what the ceiling turns on; a person deciding about their
 * own account sees only the plain-language hint.
 */
export function optionFinePrint(
  option: ScopeOption,
  audience: ScopePickerAudience
): { scopes: string | null; scopesTitle: string; hint: string } {
  const scopesTitle = option.scopes.join(' ');
  if (audience === 'user') {
    return { scopes: null, scopesTitle, hint: option.userHint ?? option.hint };
  }
  return {
    scopes:
      option.scopes.length === 1
        ? option.scopes[0]
        : `${option.scopes.length} scopes: ${option.scopes.join(' ')}`,
    scopesTitle,
    hint: option.hint,
  };
}
