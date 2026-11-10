/**
 * The sharing dialog (share-modal.model.ts), as the person sharing would
 * describe it. artifacts.spec.ts walked an artifact's share by pressing
 * ("they get use, never edit"); it keeps the dialog drawn at phone width,
 * and the rules are here.
 */

import type { GrantView } from '@/lib/chat/access';
import {
  canShare,
  grantAbility,
  granteeName,
  grantRequest,
  hasRoles,
  initialShare,
  personName,
  personSuggestions,
  shareIntro,
  shareReducer,
  type Person,
  type ShareAction,
  type ShareState,
} from './share-modal.model';

const priya: Person = {
  subject: 'priya',
  email: 'priya@example.test',
  displayName: 'Priya Friend',
};
const sam: Person = { subject: 'sam', email: 'sam@example.test', displayName: null };
const people = [priya, sam];

const grant = (more: Partial<GrantView> = {}): GrantView => ({
  id: 'g1',
  granteeSubject: 'priya',
  granteeName: 'Priya Friend',
  granteeEmail: 'priya@example.test',
  role: 'viewer',
  expiresAt: null,
  expired: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...more,
});

const run = (actions: ShareAction[], from: ShareState = initialShare) =>
  actions.reduce(shareReducer, from);

describe('finding a person', () => {
  it('suggests nobody until something is typed, then matches name or email, any case', () => {
    expect(personSuggestions(people, '  ')).toEqual([]);
    expect(personSuggestions(people, 'FRIEND')).toEqual([priya]);
    expect(personSuggestions(people, 'sam@')).toEqual([sam]);
    expect(personSuggestions(people, 'example.test')).toEqual([priya, sam]);
  });

  it('leaves out the people excluded, and suggests six at most', () => {
    expect(personSuggestions(people, 'example', ['priya'])).toEqual([sam]);
    const many = Array.from({ length: 9 }, (_, n) => ({
      subject: `p${n}`,
      email: `p${n}@example.test`,
      displayName: null,
    }));
    expect(personSuggestions(many, 'example')).toHaveLength(6);
  });

  it('names a person by their display name, else their email', () => {
    expect(personName(priya)).toBe('Priya Friend');
    expect(personName(sam)).toBe('sam@example.test');
  });

  it('choosing a suggestion clears the search; "change" lets you choose again', () => {
    const chosen = run([
      { type: 'typed', query: 'pri' },
      { type: 'chosen', person: priya },
    ]);
    expect(chosen.query).toBe('');
    expect(chosen.chosen).toBe(priya);
    expect(run([{ type: 'unchosen' }], chosen).chosen).toBeNull();
  });
});

describe('Share', () => {
  it('is off until someone is chosen, and while a share is in flight', () => {
    expect(canShare(initialShare)).toBe(false);
    const chosen = run([{ type: 'chosen', person: priya }]);
    expect(canShare(chosen)).toBe(true);
    expect(canShare(run([{ type: 'sent', clearsError: true }], chosen))).toBe(false);
  });

  it('an artifact or a chat is shared to use or read, never to edit, whatever the role says', () => {
    const editor = run([
      { type: 'chosen', person: priya },
      { type: 'roleChanged', role: 'editor' },
    ]);
    expect(hasRoles('artifact')).toBe(false);
    expect(hasRoles('chat')).toBe(false);
    expect(grantRequest('artifact', editor)?.role).toBe('viewer');
    expect(grantRequest('chat', editor)?.role).toBe('viewer');
    expect(hasRoles('chat_project')).toBe(true);
    expect(grantRequest('chat_project', editor)?.role).toBe('editor');
  });

  it('sends the person and no expiry, or the expiry as an instant', () => {
    const chosen = run([{ type: 'chosen', person: priya }]);
    expect(grantRequest('artifact', chosen)).toEqual({
      granteeSubject: 'priya',
      role: 'viewer',
      expiresAt: null,
    });
    const expiring = run([{ type: 'expiryChanged', expiresAt: '2026-12-01T09:30' }], chosen);
    expect(grantRequest('artifact', expiring)?.expiresAt).toBe(
      new Date('2026-12-01T09:30').toISOString()
    );
    expect(grantRequest('artifact', initialShare)).toBeNull();
  });

  it('a share that lands clears the form for the next person', () => {
    const shared = run([
      { type: 'chosen', person: priya },
      { type: 'expiryChanged', expiresAt: '2026-12-01T09:30' },
      { type: 'sent', clearsError: true },
      { type: 'shared' },
    ]);
    expect(shared).toMatchObject({ chosen: null, query: '', expiresAt: '', busy: false });
  });

  it('a refused share keeps the person chosen and says why', () => {
    const refused = run([
      { type: 'chosen', person: priya },
      { type: 'sent', clearsError: true },
      { type: 'failed', error: 'You cannot share with yourself.' },
    ]);
    expect(refused.chosen).toBe(priya);
    expect(refused.error).toBe('You cannot share with yourself.');
    expect(canShare(refused)).toBe(true);
  });
});

describe('who has access', () => {
  it('is loading until the first answer, then lists the shares', () => {
    expect(initialShare.grants).toBeNull();
    expect(run([{ type: 'grantsLoaded', grants: [grant()] }]).grants).toHaveLength(1);
    expect(run([{ type: 'loadFailed', error: 'Not yours' }]).error).toBe('Not yours');
  });

  it('says a share on an artifact lets its person use it', () => {
    expect(grantAbility('artifact', grant())).toBe('use');
    expect(grantAbility('chat', grant())).toBe('view');
    expect(grantAbility('chat_project', grant({ role: 'editor' }))).toBe('edit');
  });

  it('names the person by name, then email, then subject', () => {
    expect(granteeName(grant())).toBe('Priya Friend');
    expect(granteeName(grant({ granteeName: null }))).toBe('priya@example.test');
    expect(granteeName(grant({ granteeName: null, granteeEmail: null }))).toBe('priya');
  });

  it('a removal keeps an earlier error unless it fails itself', () => {
    const earlier = run([{ type: 'failed', error: 'Earlier' }]);
    const removing = run([{ type: 'sent', clearsError: false }], earlier);
    expect(removing.error).toBe('Earlier');
    expect(run([{ type: 'revoked', error: null }], removing)).toMatchObject({
      busy: false,
      error: 'Earlier',
    });
    expect(run([{ type: 'revoked', error: 'Gone' }], removing).error).toBe('Gone');
  });
});

describe('what sharing means', () => {
  it('an artifact says sharing lets a person use it, never change it', () => {
    expect(shareIntro('artifact')).toMatch(/Sharing lets a person use it/);
    expect(shareIntro('chat')).toMatch(/Only you can continue it/);
    expect(shareIntro('chat_project')).toMatch(/keyed to them/);
  });
});
