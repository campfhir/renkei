/**
 * The Connect / Reconnect scope selection on a single-catalog OAuth card
 * (Zoom, GitHub, WebEx, the Atlassian products), as a person ticking boxes
 * sees it. Moved from e2e/connectors.spec.ts, which pressed a checkbox and
 * watched the Connect link's href change.
 */

import type { ScopeOption } from '@/lib/scope-catalog';
import { DEFAULT_ZOOM_SCOPES, ZOOM_SCOPE_OPTIONS } from '@/lib/zoom-scopes';
import {
  authorizeHref,
  connectBlockedReason,
  initScopeSelection,
  overUrlBudget,
  pickableOptions,
  scopeSelectionReducer,
  selectedScopeString,
  selectionSummary,
  type ScopeSelectionAction,
  type ScopeSelectionContext,
  type ScopeSelectionState,
} from './scope-connect-panel.model';

const option = (id: string, scopes: string[]): ScopeOption => ({
  id,
  scopes,
  label: id,
  hint: id,
  group: 'g',
  defaultChecked: true,
});

const OPTIONS = [
  option('meetings', ['meeting:read']),
  option('recordings', ['recording:read', 'meeting:read']),
  option('schedule', ['meeting:write']),
];

function context(overrides: Partial<ScopeSelectionContext> = {}): ScopeSelectionContext {
  return {
    options: OPTIONS,
    ceiling: ['meeting:read', 'recording:read', 'meeting:write'],
    priorScopes: null,
    ...overrides,
  };
}

function after(
  ctx: ScopeSelectionContext,
  ...actions: ScopeSelectionAction[]
): ScopeSelectionState {
  return actions.reduce(scopeSelectionReducer, initScopeSelection(ctx));
}

const ids = (state: ScopeSelectionState) => [...state.selected].sort();

describe('the connect card scope selection', () => {
  it('offers only the capabilities whose every scope the org allows', () => {
    const ctx = context({ ceiling: ['meeting:read', 'meeting:write'] });
    expect(pickableOptions(ctx).map((o) => o.id)).toEqual(['meetings', 'schedule']);
  });

  it('a first connection starts with everything the org allows ticked', () => {
    expect(ids(after(context()))).toEqual(['meetings', 'recordings', 'schedule']);
    expect(ids(after(context({ ceiling: ['meeting:read'] })))).toEqual(['meetings']);
  });

  it('a reconnect starts from what the previous grant held', () => {
    const ctx = context({ priorScopes: ['meeting:read', 'recording:read'] });
    expect(ids(after(ctx))).toEqual(['meetings', 'recordings']);
  });

  it('a previous grant holding none of the choices starts with everything ticked', () => {
    const ctx = context({ priorScopes: ['user:read:user'] });
    expect(ids(after(ctx))).toEqual(['meetings', 'recordings', 'schedule']);
  });

  it('a capability the org has since withdrawn is not ticked on reconnect', () => {
    const ctx = context({
      ceiling: ['meeting:read'],
      priorScopes: ['meeting:read', 'meeting:write'],
    });
    expect(ids(after(ctx))).toEqual(['meetings']);
  });

  it('unticking a box changes where Connect goes, before any round trip', () => {
    const ctx = context();
    const before = authorizeHref('/api/zoom/authorize', after(ctx), ctx);
    const unticked = after(ctx, { type: 'toggled', optionId: 'schedule', on: false });
    const href = authorizeHref('/api/zoom/authorize', unticked, ctx);
    expect(href).not.toBe(before);
    expect(href).toBe(
      `/api/zoom/authorize?scopes=${encodeURIComponent('meeting:read recording:read')}`
    );
  });

  it('a scope two ticked capabilities share is asked for once', () => {
    const ctx = context();
    expect(selectedScopeString(after(ctx), ctx)).toBe('meeting:read recording:read meeting:write');
  });

  it('ticking a box back on asks for it again', () => {
    const ctx = context();
    const state = after(
      ctx,
      { type: 'toggled', optionId: 'schedule', on: false },
      { type: 'toggled', optionId: 'schedule', on: true }
    );
    expect(ids(state)).toEqual(['meetings', 'recordings', 'schedule']);
  });

  it('with every box unticked Connect sends an empty selection', () => {
    const ctx = context({ ceiling: ['meeting:read'] });
    const state = after(ctx, { type: 'toggled', optionId: 'meetings', on: false });
    expect(authorizeHref('/api/zoom/authorize', state, ctx)).toBe('/api/zoom/authorize?scopes=');
  });

  it('the summary counts what is ticked out of what is offered', () => {
    const ctx = context({ ceiling: ['meeting:read', 'meeting:write'] });
    expect(selectionSummary(after(ctx), ctx)).toBe('What Renkei may do (2 of 2 capabilities)');
    const unticked = after(ctx, { type: 'toggled', optionId: 'meetings', on: false });
    expect(selectionSummary(unticked, ctx)).toBe('What Renkei may do (1 of 2 capabilities)');
  });

  it('warns when the consent URL would run past the vendor limit, and not before', () => {
    const ctx = context();
    const state = after(ctx);
    const length = encodeURIComponent(selectedScopeString(state, ctx)).length;
    expect(overUrlBudget(undefined, state, ctx)).toBe(false);
    expect(overUrlBudget({ baseChars: 100, limit: 100 + length }, state, ctx)).toBe(false);
    expect(overUrlBudget({ baseChars: 101, limit: 100 + length }, state, ctx)).toBe(true);
  });

  it('cannot connect with nothing ticked, which would ask for everything instead', () => {
    const ctx = context();
    expect(connectBlockedReason(after(ctx))).toBeNull();
    const none = after(
      ctx,
      { type: 'toggled', optionId: 'meetings', on: false },
      { type: 'toggled', optionId: 'recordings', on: false },
      { type: 'toggled', optionId: 'schedule', on: false }
    );
    expect(connectBlockedReason(none)).toBe(
      'Tick at least one thing Renkei may do before connecting.'
    );
    // Ticking one back lets it go again.
    const one = scopeSelectionReducer(none, { type: 'toggled', optionId: 'schedule', on: true });
    expect(connectBlockedReason(one)).toBeNull();
  });

  it("Zoom's default ceiling offers and ticks every Zoom capability", () => {
    const ctx = context({ options: ZOOM_SCOPE_OPTIONS, ceiling: DEFAULT_ZOOM_SCOPES.split(' ') });
    expect(pickableOptions(ctx)).toHaveLength(ZOOM_SCOPE_OPTIONS.length);
    expect(after(ctx).selected.size).toBe(ZOOM_SCOPE_OPTIONS.length);
  });
});
