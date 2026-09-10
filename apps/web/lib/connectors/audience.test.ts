/**
 * The audience resolver's contract: no rules means nothing restricted; a
 * rule admits a person by any one matching group; and every failure —
 * settings unreadable, identity unreadable — closes the restricted
 * connectors rather than opening them.
 */

jest.mock('@renkei/settings', () => ({ getOrgSettings: jest.fn() }));
jest.mock('@/lib/identity', () => ({ idpGroupsFor: jest.fn() }));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { allowedKeys, resolveAudience, resolveAudienceAllows, restrictedKeys } from './audience';

const { getOrgSettings } = jest.requireMock<{ getOrgSettings: jest.Mock }>('@renkei/settings');
const { idpGroupsFor } = jest.requireMock<{ idpGroupsFor: jest.Mock }>('@/lib/identity');

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- never queried here
const db = {} as Kysely<DB>;

function rules(connectorAudiences: Record<string, string[]>) {
  getOrgSettings.mockResolvedValue({ ok: true, val: { connectorAudiences } });
}

beforeEach(() => {
  getOrgSettings.mockReset();
  idpGroupsFor.mockReset();
});

describe('pure pieces', () => {
  it('treats an empty list as everyone, not a rule', () => {
    expect(restrictedKeys({ zoom: ['a'], jira: [] })).toEqual(['zoom']);
  });

  it('admits on any one matching value', () => {
    expect(allowedKeys({ zoom: ['a', 'b'], onbase: ['c'] }, ['b'])).toEqual(['zoom']);
  });
});

describe('resolveAudience', () => {
  it('restricts nothing when no rule names a group', async () => {
    rules({ zoom: [] });
    const resolution = await resolveAudience(db, 't', 's');
    expect(resolution).toEqual({ restrictedConnectors: [], allowedConnectors: [] });
    // No rules, so the identity is not even read.
    expect(idpGroupsFor).not.toHaveBeenCalled();
  });

  it('admits a person whose recorded groups match', async () => {
    rules({ zoom: ['svc-desk'], 'atlassian-bitbucket': ['eng'] });
    idpGroupsFor.mockResolvedValue({ ok: true, val: ['svc-desk'] });
    const resolution = await resolveAudience(db, 't', 's');
    expect(resolution.restrictedConnectors.sort()).toEqual(['atlassian-bitbucket', 'zoom']);
    expect(resolution.allowedConnectors).toEqual(['zoom']);
  });

  it('closes every restricted connector when the identity cannot be read', async () => {
    rules({ zoom: ['svc-desk'] });
    idpGroupsFor.mockResolvedValue({ ok: false, err: 'DB_ERROR' });
    const resolution = await resolveAudience(db, 't', 's');
    expect(resolution).toEqual({ restrictedConnectors: ['zoom'], allowedConnectors: [] });
  });

  it('closes every connector when the rules cannot be read', async () => {
    // Fail closed all the way: with the rules unknown, no connector can be
    // assumed unrestricted.
    getOrgSettings.mockResolvedValue({ ok: false, err: 'DB_ERROR' });
    const resolution = await resolveAudience(db, 't', 's');
    expect(resolution.allowedConnectors).toEqual([]);
    expect(resolution.restrictedConnectors).toContain('zoom');
    expect(resolution.restrictedConnectors).toContain('jira');
  });

  it('answers the page the same way it answers the projection', async () => {
    rules({ zoom: ['svc-desk'] });
    idpGroupsFor.mockResolvedValue({ ok: true, val: ['other'] });
    const allows = await resolveAudienceAllows(db, 't', 's');
    expect(allows('zoom')).toBe(false);
    expect(allows('jira')).toBe(true);
  });
});
