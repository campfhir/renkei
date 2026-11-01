/**
 * The scope selection behind every single-catalog OAuth card's Connect and
 * Reconnect controls (scope-connect-panel.tsx: Jira, JSM, Confluence,
 * Bitbucket, Zoom, GitHub, WebEx). What it decides — which capabilities a
 * person may pick inside the org's ceiling, what starts ticked on a first
 * connection or a reconnect, the "What Renkei may do (N of M)" summary, the
 * authorize URL Connect opens as the boxes change, and Atlassian's
 * consent-URL length warning — is here, and tested in
 * scope-connect-panel.model.test.ts.
 *
 * Microsoft's card does not use it: one selection across several product
 * panels (microsoft-connect-body.model.ts).
 */

import { optionWithin, scopesOfOptions, type ScopeOption } from '@/lib/scope-catalog';
import { pickableWithin } from './microsoft-product-card.model';

/** What the server knows: the catalog, the org's ceiling, and the person's prior grant. */
export interface ScopeSelectionContext {
  options: readonly ScopeOption[];
  /** The org's allowed scopes: the most a person can grant. */
  ceiling: readonly string[];
  /** Scopes on the person's previous grant; null when there is none. */
  priorScopes: readonly string[] | null;
}

export interface ScopeSelectionState {
  selected: ReadonlySet<string>;
}

export type ScopeSelectionAction = { type: 'toggled'; optionId: string; on: boolean };

/** The options inside the ceiling: the only ones a person is offered. */
export function pickableOptions(context: ScopeSelectionContext): ScopeOption[] {
  return pickableWithin(context.options, context.ceiling);
}

/**
 * A reconnect starts from what the previous grant held; a first connection
 * (or a grant holding none of the choices) starts with everything the org
 * allows ticked.
 */
export function initScopeSelection(context: ScopeSelectionContext): ScopeSelectionState {
  const pickable = pickableOptions(context);
  const prior = context.priorScopes === null ? null : new Set(context.priorScopes);
  const seed = prior
    ? pickable.filter((option) => optionWithin(option, prior)).map((option) => option.id)
    : [];
  return { selected: new Set(seed.length > 0 ? seed : pickable.map((option) => option.id)) };
}

export function scopeSelectionReducer(
  state: ScopeSelectionState,
  action: ScopeSelectionAction
): ScopeSelectionState {
  switch (action.type) {
    case 'toggled': {
      const selected = new Set(state.selected);
      if (action.on) selected.add(action.optionId);
      else selected.delete(action.optionId);
      return { selected };
    }
  }
}

/** The scopes the ticked boxes ask for, space-separated, each once. */
export function selectedScopeString(
  state: ScopeSelectionState,
  context: ScopeSelectionContext
): string {
  return scopesOfOptions(context.options, state.selected).join(' ');
}

/**
 * Where Connect (or "Approve updated permissions") goes: the authorize
 * route with the selection as `?scopes=`. It follows the boxes before any
 * round trip; the route itself refuses anything outside the ceiling.
 */
export function authorizeHref(
  authorizePath: string,
  state: ScopeSelectionState,
  context: ScopeSelectionContext
): string {
  return `${authorizePath}?scopes=${encodeURIComponent(selectedScopeString(state, context))}`;
}

/** The picker's summary line: "What Renkei may do (N of M capabilities)". */
export function selectionSummary(
  state: ScopeSelectionState,
  context: ScopeSelectionContext
): string {
  return `What Renkei may do (${state.selected.size} of ${pickableOptions(context).length} capabilities)`;
}

/**
 * Whether the consent URL this selection builds runs past the vendor's
 * limit (Atlassian's granular scopes come dozens to a capability).
 */
export function overUrlBudget(
  budget: { baseChars: number; limit: number } | undefined,
  state: ScopeSelectionState,
  context: ScopeSelectionContext
): boolean {
  if (!budget) return false;
  return (
    budget.baseChars + encodeURIComponent(selectedScopeString(state, context)).length > budget.limit
  );
}
