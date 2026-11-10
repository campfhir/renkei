import { MICROSOFT_SCOPE_OPTIONS } from '@/lib/microsoft-scopes';
import {
  authorizeUrl,
  changesPending,
  disconnectRefusal,
  initMicrosoftCard,
  microsoftCardReducer,
  offersSharePointWatches,
  pickableOptions,
  reauthorize,
  selectionSummary,
  shownProducts,
  type MicrosoftCardAction,
  type MicrosoftCardState,
  type MicrosoftContext,
} from './microsoft-connect-body.model';

const ALL_SCOPES = [...new Set(MICROSOFT_SCOPE_OPTIONS.flatMap((option) => option.scopes))];
const ALL_IDS = MICROSOFT_SCOPE_OPTIONS.map((option) => option.id);
const scopesOfIds = (ids: string[]) => [
  ...new Set(
    MICROSOFT_SCOPE_OPTIONS.filter((option) => ids.includes(option.id)).flatMap((o) => o.scopes)
  ),
];

function run(context: MicrosoftContext, ...actions: MicrosoftCardAction[]): MicrosoftCardState {
  return actions.reduce(microsoftCardReducer, initMicrosoftCard(context));
}

const notConnected: MicrosoftContext = { connected: false, ceiling: ALL_SCOPES, priorScopes: null };
const connectedWithAll: MicrosoftContext = {
  connected: true,
  ceiling: ALL_SCOPES,
  priorScopes: ALL_SCOPES,
};

describe('the Microsoft 365 card', () => {
  it('shows only the panels this person added: Teams and OneNote, no Outlook or SharePoint', () => {
    expect(shownProducts(['teams', 'onenote']).map((product) => product.title)).toEqual([
      'Teams',
      'OneNote',
    ]);
  });

  it('Outlook and the directory share a key, so adding Microsoft shows both', () => {
    expect(shownProducts(['microsoft']).map((product) => product.id)).toEqual([
      'outlook',
      'enterprise',
    ]);
  });

  it('a first connection starts with everything the org allows ticked', () => {
    const state = run(notConnected);
    expect([...state.selected].sort()).toEqual([...ALL_IDS].sort());
    expect(selectionSummary(state, notConnected)).toBe(
      `${ALL_IDS.length} of ${ALL_IDS.length} capabilities selected across all products.`
    );
  });

  it('offers only what is inside the org’s ceiling', () => {
    const ceiling = scopesOfIds(['Chat.Read', 'Notes.Read']);
    expect(
      pickableOptions(ceiling)
        .map((option) => option.id)
        .sort()
    ).toEqual(['Chat.Read', 'Notes.Read'].sort());
    expect(selectionSummary(run({ ...notConnected, ceiling }), { ...notConnected, ceiling })).toBe(
      '2 of 2 capabilities selected across all products.'
    );
  });

  it('a reconnect starts from what the grant holds', () => {
    const context = { ...connectedWithAll, priorScopes: scopesOfIds(['Chat.Read']) };
    expect([...run(context).selected]).toContain('Chat.Read');
    expect([...run(context).selected]).not.toContain('Presence.Read.All');
  });

  it('a grant holding none of the choices starts with everything ticked, as a first connection does', () => {
    const context = { ...connectedWithAll, priorScopes: ['openid', 'User.Read'] };
    expect(run(context).selected.size).toBe(ALL_IDS.length);
  });

  it('Connect asks Microsoft for the union of every panel’s selection', () => {
    const context = { ...notConnected, ceiling: scopesOfIds(['Chat.Read', 'Notes.ReadWrite']) };
    const url = new URL(authorizeUrl(run(context)), 'http://test.local');
    expect(url.pathname).toBe('/api/microsoft/authorize');
    expect(url.searchParams.get('scopes')?.split(' ').sort()).toEqual(
      ['Chat.Read', 'Notes.Read', 'Notes.ReadWrite'].sort()
    );
  });

  it('an unticked box leaves its scopes out of the consent', () => {
    const context = { ...notConnected, ceiling: scopesOfIds(['Chat.Read', 'Notes.Read']) };
    const state = run(context, { type: 'toggled', optionId: 'Chat.Read', on: false });
    expect(new URL(authorizeUrl(state), 'http://x').searchParams.get('scopes')).toBe('Notes.Read');
  });

  it('connected with nothing changed: Re-authorize, and the line says nothing indexed is removed', () => {
    const state = run(connectedWithAll);
    expect(changesPending(state, connectedWithAll)).toBe(false);
    expect(reauthorize(state, connectedWithAll)).toEqual({
      label: 'Re-authorize',
      hint: 'Re-authorizing sends your current selections as one consent. Nothing already indexed is removed.',
      emphasized: false,
    });
  });

  it('a changed checkbox in any panel turns the one button into Approve changes; ticking it back undoes that', () => {
    const changed = run(connectedWithAll, {
      type: 'toggled',
      optionId: 'Presence.Read.All',
      on: false,
    });
    expect(reauthorize(changed, connectedWithAll)).toMatchObject({
      label: 'Approve changes',
      emphasized: true,
    });
    const back = microsoftCardReducer(changed, {
      type: 'toggled',
      optionId: 'Presence.Read.All',
      on: true,
    });
    expect(reauthorize(back, connectedWithAll).label).toBe('Re-authorize');
  });

  it('a grant from before scopes were recorded claims no change', () => {
    const context = { ...connectedWithAll, priorScopes: null };
    const state = run(context, { type: 'toggled', optionId: 'Chat.Read', on: false });
    expect(changesPending(state, context)).toBe(false);
  });

  it('offers SharePoint’s library picker only with Sites.Read.All granted, or on an old grant', () => {
    expect(offersSharePointWatches(connectedWithAll)).toBe(ALL_SCOPES.includes('Sites.Read.All'));
    expect(offersSharePointWatches({ ...connectedWithAll, priorScopes: ['Chat.Read'] })).toBe(
      false
    );
    expect(offersSharePointWatches({ ...connectedWithAll, priorScopes: null })).toBe(true);
    expect(offersSharePointWatches(notConnected)).toBe(false);
  });

  describe('disconnecting', () => {
    it('asks first, and Keep it backs out', () => {
      const asked = run(connectedWithAll, { type: 'disconnectAsked' });
      expect(asked.confirming).toBe(true);
      expect(microsoftCardReducer(asked, { type: 'disconnectKept' }).confirming).toBe(false);
    });

    it('holds both buttons while the disconnect is in flight', () => {
      expect(
        run(connectedWithAll, { type: 'disconnectAsked' }, { type: 'disconnectSent' }).busy
      ).toBe(true);
    });

    it('a refused disconnect keeps the question open and says why', () => {
      const state = run(
        connectedWithAll,
        { type: 'disconnectAsked' },
        { type: 'disconnectSent' },
        { type: 'disconnectFailed', notice: disconnectRefusal('Database unavailable') }
      );
      expect(state.confirming).toBe(true);
      expect(state.busy).toBe(false);
      expect(state.notice).toBe('Database unavailable');
      expect(disconnectRefusal(undefined)).toBe('Could not disconnect');
    });

    it('a second try clears the last notice', () => {
      const failed = run(connectedWithAll, { type: 'disconnectFailed', notice: 'No' });
      expect(microsoftCardReducer(failed, { type: 'disconnectSent' }).notice).toBeNull();
    });
  });
});
