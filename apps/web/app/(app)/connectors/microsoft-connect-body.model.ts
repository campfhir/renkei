/**
 * The Microsoft 365 card's live state (microsoft-connect-body.tsx): the one
 * scope selection lifted across every product panel, and the disconnect
 * confirmation. What the card decides — which panels show, what a first
 * connection or a reconnect starts with ticked, the consent URL Connect and
 * Re-authorize open, whether a change waits on Microsoft's approval, the
 * words under the button, whether SharePoint's library picker is offered,
 * what a failed disconnect leaves — is here, and tested in
 * microsoft-connect-body.model.test.ts.
 */

import { MICROSOFT_SCOPE_OPTIONS } from '@/lib/microsoft-scopes';
import { MICROSOFT_PRODUCTS, type MicrosoftProduct } from '@/lib/microsoft-products';
import { optionWithin, scopesOfOptions, type ScopeOption } from '@/lib/scope-catalog';
import { pickableWithin, selectionPending } from './microsoft-product-card.model';

/** What the server knows about this person's connection. */
export interface MicrosoftContext {
  connected: boolean;
  /** The org's allowed scopes: the most a person can grant. */
  ceiling: string[];
  /** Scopes on the person's grant; null for a grant from before scopes were recorded. */
  priorScopes: string[] | null;
}

export interface MicrosoftCardState {
  selected: ReadonlySet<string>;
  confirming: boolean;
  busy: boolean;
  notice: string | null;
}

export type MicrosoftCardAction =
  | { type: 'toggled'; optionId: string; on: boolean }
  | { type: 'disconnectAsked' }
  | { type: 'disconnectKept' }
  | { type: 'disconnectSent' }
  | { type: 'disconnected' }
  | { type: 'disconnectFailed'; notice: string };

/**
 * Only catalog options inside the ceiling count as choices; the required
 * scopes (openid, profile, email, offline_access, User.Read) ride along
 * server-side and are not offered.
 */
export function pickableOptions(ceiling: readonly string[]): ScopeOption[] {
  return pickableWithin(MICROSOFT_SCOPE_OPTIONS, ceiling);
}

/** The panels this person added or connected; a hidden panel's scopes are simply not offered. */
export function shownProducts(shownKeys: readonly string[]): MicrosoftProduct[] {
  const shown = new Set(shownKeys);
  return MICROSOFT_PRODUCTS.filter((product) => shown.has(product.capabilityKey));
}

/**
 * A reconnect starts from what the grant holds; a first connection (or a
 * grant holding none of the choices) starts with everything the org allows.
 */
export function initMicrosoftCard(
  context: Pick<MicrosoftContext, 'ceiling' | 'priorScopes'>
): MicrosoftCardState {
  const pickable = pickableOptions(context.ceiling);
  const prior = context.priorScopes === null ? null : new Set(context.priorScopes);
  const seed = prior
    ? pickable.filter((option) => optionWithin(option, prior)).map((option) => option.id)
    : [];
  return {
    selected: new Set(seed.length > 0 ? seed : pickable.map((option) => option.id)),
    confirming: false,
    busy: false,
    notice: null,
  };
}

export function microsoftCardReducer(
  state: MicrosoftCardState,
  action: MicrosoftCardAction
): MicrosoftCardState {
  switch (action.type) {
    case 'toggled': {
      const selected = new Set(state.selected);
      if (action.on) selected.add(action.optionId);
      else selected.delete(action.optionId);
      return { ...state, selected };
    }
    case 'disconnectAsked':
      return { ...state, confirming: true };
    case 'disconnectKept':
      return { ...state, confirming: false };
    case 'disconnectSent':
      return { ...state, busy: true, notice: null };
    case 'disconnected':
      return { ...state, busy: false, confirming: false };
    case 'disconnectFailed':
      return { ...state, busy: false, notice: action.notice };
  }
}

/** The one consent URL: always the union of every panel's selection, since a re-consent replaces the grant. */
export function authorizeUrl(state: MicrosoftCardState): string {
  return `/api/microsoft/authorize?scopes=${encodeURIComponent(
    scopesOfOptions(MICROSOFT_SCOPE_OPTIONS, state.selected).join(' ')
  )}`;
}

/**
 * Whether any panel's selection has diverged from what Microsoft holds,
 * across all products: the button is one button, and a change made in
 * SharePoint has to light up a control four panels below it.
 */
export function changesPending(state: MicrosoftCardState, context: MicrosoftContext): boolean {
  return selectionPending(
    pickableOptions(context.ceiling),
    context.priorScopes,
    state.selected,
    context.connected
  );
}

/** Under Connect: "N of M capabilities selected across all products." */
export function selectionSummary(state: MicrosoftCardState, context: MicrosoftContext): string {
  return `${state.selected.size} of ${pickableOptions(context.ceiling).length} capabilities selected across all products.`;
}

/** The connected card's main control, and the line under it. */
export function reauthorize(
  state: MicrosoftCardState,
  context: MicrosoftContext
): { label: string; hint: string; emphasized: boolean } {
  const pending = changesPending(state, context);
  return pending
    ? {
        label: 'Approve changes',
        hint: 'You changed what a product may do. Microsoft still has the previous permissions until you approve.',
        emphasized: true,
      }
    : {
        label: 'Re-authorize',
        hint: 'Re-authorizing sends your current selections as one consent. Nothing already indexed is removed.',
        emphasized: false,
      };
}

/**
 * SharePoint's library picker needs Sites.Read.All on the grant: without
 * it listing sites and the background sweep can only end in a 403. A grant
 * from before scopes were recorded is offered it, and the picker's own
 * error does the explaining.
 */
export function offersSharePointWatches(context: MicrosoftContext): boolean {
  return (
    context.connected &&
    (context.priorScopes === null || context.priorScopes.includes('Sites.Read.All'))
  );
}

/** The disconnect's refusal words, or "Could not disconnect". */
export function disconnectRefusal(error: unknown): string {
  return typeof error === 'string' ? error : 'Could not disconnect';
}
