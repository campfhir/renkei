/**
 * One product's panel on the Microsoft 365 card (microsoft-product-card.tsx):
 * which of its capabilities the org lets a person pick, how many are
 * granted and selected, and whether a changed checkbox is still a draft
 * Microsoft has not approved. Pure; tested in
 * microsoft-product-card.model.test.ts.
 */

import { optionWithin, type ScopeOption } from '@/lib/scope-catalog';

/** The options inside the org's ceiling: the only ones a person may pick. */
export function pickableWithin(
  options: readonly ScopeOption[],
  ceiling: readonly string[]
): ScopeOption[] {
  const ceilingSet = new Set(ceiling);
  return options.filter((option) => optionWithin(option, ceilingSet));
}

/**
 * Whether the selection has diverged from what Microsoft holds. A null
 * `authorized` is a grant from before scopes were recorded: there is
 * nothing to diff against, so nothing is claimed to have changed.
 */
export function selectionPending(
  pickable: readonly ScopeOption[],
  authorized: readonly string[] | null,
  checked: ReadonlySet<string>,
  connected: boolean
): boolean {
  if (!connected || authorized === null) return false;
  const held = new Set(authorized);
  const granted = pickable.filter((option) => optionWithin(option, held));
  const selected = pickable.filter((option) => checked.has(option.id));
  return selected.length !== granted.length || selected.some((option) => !granted.includes(option));
}

export type ProductBadge = { kind: 'on'; text: string } | { kind: 'off'; text: 'Off' };

export interface ProductPanel {
  pickable: ScopeOption[];
  /** "Not approved yet": a selection Microsoft's consent has not seen. */
  pending: boolean;
  /** Connected only: how much of this product is granted. */
  badge: ProductBadge | null;
  /** Before connecting: the picker's summary line. */
  pickerSummary: string;
}

/**
 * The panel, or null when every option is outside the org's ceiling: a
 * capability the org withheld is not this person's business, and an empty
 * panel invites a ticket about a feature they were never going to get.
 */
export function productPanel(input: {
  options: readonly ScopeOption[];
  ceiling: readonly string[];
  authorized: readonly string[] | null;
  checked: ReadonlySet<string>;
  connected: boolean;
}): ProductPanel | null {
  const pickable = pickableWithin(input.options, input.ceiling);
  if (pickable.length === 0) return null;
  const held = new Set(input.authorized ?? []);
  const granted = pickable.filter((option) => optionWithin(option, held)).length;
  const selected = pickable.filter((option) => input.checked.has(option.id)).length;
  return {
    pickable,
    pending: selectionPending(pickable, input.authorized, input.checked, input.connected),
    badge: input.connected
      ? granted > 0
        ? { kind: 'on', text: `${granted} of ${pickable.length} on` }
        : { kind: 'off', text: 'Off' }
      : null,
    pickerSummary: `What Renkei may do here (${selected} of ${pickable.length})`,
  };
}
