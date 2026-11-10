/**
 * The "Paused people" rules: who is listed (an enabled agent and no
 * automation delegation), what each is called, the order (longest away
 * first), and how "since" reads.
 */

import { agoText, pausedOwnersOf, type OwnerKeySummary } from './paused-owners';

const delegated: OwnerKeySummary = { enrolled: true, automationInstances: 1, sessionInstances: 1 };
const lapsed: OwnerKeySummary = { enrolled: true, automationInstances: 0, sessionInstances: 0 };
const sessionOnly: OwnerKeySummary = {
  enrolled: true,
  automationInstances: 0,
  sessionInstances: 1,
};
const unenrolled: OwnerKeySummary = {
  enrolled: false,
  automationInstances: 0,
  sessionInstances: 0,
};

const agent = (ownerSubject: string, enabled = true, ownerEmail: string | null = null) => ({
  ownerSubject,
  ownerEmail,
  enabled,
});

describe('pausedOwnersOf', () => {
  it('lists owners of enabled agents whose agents cannot run, longest away first', () => {
    const rows = pausedOwnersOf({
      agents: [
        agent('scott'),
        agent('deryck'),
        agent('deryck'),
        agent('quinn'),
        agent('eve'),
        agent('nobody-enabled', false),
        agent('ghost'),
      ],
      statuses: new Map([
        ['scott', delegated],
        ['deryck', lapsed],
        ['quinn', sessionOnly],
        ['eve', unenrolled],
        ['nobody-enabled', lapsed],
        ['ghost', null],
      ]),
      lastSeen: new Map([
        ['scott', new Date('2026-11-09T00:00:00Z')],
        ['deryck', new Date('2026-11-04T21:17:00Z')],
        ['quinn', new Date('2026-10-29T23:19:00Z')],
        ['eve', new Date('2026-11-01T00:00:00Z')],
      ]),
      names: new Map([
        ['deryck', { email: 'deryck@example.org', displayName: 'Deryck Wong' }],
        ['quinn', { email: 'quinn@example.org', displayName: null }],
      ]),
      parked: new Map([['deryck', 1]]),
    });
    expect(rows.map((row) => row.subject)).toEqual(['ghost', 'quinn', 'eve', 'deryck']);
    expect(rows.map((row) => row.state)).toEqual([
      'unknown',
      'session-only',
      'not-enrolled',
      'no-delegation',
    ]);
    const deryck = rows[3];
    expect(deryck).toMatchObject({
      email: 'deryck@example.org',
      displayName: 'Deryck Wong',
      agents: 2,
      parkedRuns: 1,
      lastSeenAt: '2026-11-04T21:17:00.000Z',
    });
    expect(rows[0].lastSeenAt).toBeNull();
    expect(rows[0].parkedRuns).toBe(0);
  });

  it('leaves out an owner with no enabled agent, and one whose agents run', () => {
    const rows = pausedOwnersOf({
      agents: [agent('off', false), agent('fine')],
      statuses: new Map([
        ['off', lapsed],
        ['fine', delegated],
      ]),
      lastSeen: new Map(),
      names: new Map(),
      parked: new Map(),
    });
    expect(rows).toEqual([]);
  });

  it("falls back to the agent row's owner email when no identity is recorded", () => {
    const rows = pausedOwnersOf({
      agents: [agent('p', true, 'p@example.org')],
      statuses: new Map([['p', lapsed]]),
      lastSeen: new Map(),
      names: new Map(),
      parked: new Map(),
    });
    expect(rows[0].email).toBe('p@example.org');
    expect(rows[0].displayName).toBeNull();
  });

  it('reads an owner the delegate was not asked about as unknown', () => {
    const rows = pausedOwnersOf({
      agents: [agent('p')],
      statuses: new Map(),
      lastSeen: new Map(),
      names: new Map(),
      parked: new Map(),
    });
    expect(rows[0].state).toBe('unknown');
  });
});

describe('agoText', () => {
  const now = Date.parse('2026-11-09T17:00:00Z');
  const at = (iso: string) => agoText(iso, now);
  it('reads as a person would say it', () => {
    expect(agoText(null, now)).toBe('never');
    expect(at('2026-11-09T16:59:30Z')).toBe('just now');
    expect(at('2026-11-09T16:30:00Z')).toBe('30 minutes ago');
    expect(at('2026-11-09T15:59:00Z')).toBe('1 hour ago');
    expect(at('2026-11-08T17:30:00Z')).toBe('23 hours ago');
    expect(at('2026-11-08T10:00:00Z')).toBe('yesterday');
    expect(at('2026-11-04T21:17:00Z')).toBe('4 days ago');
    expect(at('2026-10-19T17:52:00Z')).toBe('2 weeks ago');
    expect(at('2026-10-17T17:52:00Z')).toBe('3 weeks ago');
    expect(at('2026-08-01T00:00:00Z')).toBe('3 months ago');
  });
});
