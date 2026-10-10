/**
 * The identity spine's contract: the email is taken from the id_token's
 * standard claim (with Azure AD's preferred_username accepted when it looks
 * like an address), normalized to lowercase, and a token with no address
 * yields no identity — recorded as absent, never guessed.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import {
  identityClaimsFromIdToken,
  groupValuesFromIdToken,
  hasGroupsOverage,
  upsertIdentity,
  getIdentityEmail,
  clearIdpGroups,
} from './identity';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

beforeEach(() => {
  mockGetDatabase.mockReset();
});

describe('identityClaimsFromIdToken', () => {
  it('prefers the standard email claim, lowercased', () => {
    const claims = identityClaimsFromIdToken(
      {
        email: 'Sam.Lee@Example.COM',
        preferred_username: 'sam.other@example.com',
        name: 'Sam Lee',
      },
      'groups'
    );
    expect(claims).toEqual({
      email: 'sam.lee@example.com',
      displayName: 'Sam Lee',
      idpGroups: [],
    });
  });

  it('falls back to preferred_username when it looks like an address', () => {
    const claims = identityClaimsFromIdToken({ preferred_username: 'sam@example.com' }, 'groups');
    expect(claims?.email).toBe('sam@example.com');
    expect(claims?.displayName).toBeNull();
  });

  it('yields nothing for a token with no address anywhere', () => {
    expect(
      identityClaimsFromIdToken({ preferred_username: 'DOMAIN\\sam', name: 'Sam' }, 'groups')
    ).toBeNull();
    expect(identityClaimsFromIdToken({}, 'groups')).toBeNull();
  });
});

describe('groupValuesFromIdToken', () => {
  it('reads an array of strings from the named claim, deduplicated', () => {
    expect(groupValuesFromIdToken({ groups: ['eng', ' eng ', 'ops', 7, ''] }, 'groups')).toEqual([
      'eng',
      'ops',
    ]);
  });

  it('accepts a single string, and reads the claim the tenant names', () => {
    expect(groupValuesFromIdToken({ memberOf: 'eng' }, 'memberOf')).toEqual(['eng']);
    expect(groupValuesFromIdToken({ groups: ['eng'] }, 'memberOf')).toEqual([]);
  });

  it('reads anything else as no groups', () => {
    expect(groupValuesFromIdToken({ groups: { eng: true } }, 'groups')).toEqual([]);
    expect(groupValuesFromIdToken({}, 'groups')).toEqual([]);
  });

  it('is carried on the identity claims', () => {
    const claims = identityClaimsFromIdToken(
      { email: 'sam@example.com', groups: ['eng'] },
      'groups'
    );
    expect(claims?.idpGroups).toEqual(['eng']);
  });

  it('records no groups when no groups claim is configured, whatever the token carries', () => {
    const claims = identityClaimsFromIdToken(
      { email: 'sam@example.com', groups: ['eng'], memberOf: ['ops'] },
      null
    );
    expect(claims?.idpGroups).toEqual([]);
  });

  it('records no groups when the token omits the configured claim', () => {
    const claims = identityClaimsFromIdToken(
      { email: 'sam@example.com', groups: ['eng'] },
      'memberOf'
    );
    expect(claims?.idpGroups).toEqual([]);
  });
});

describe('hasGroupsOverage', () => {
  it('spots Entra pointing at Graph instead of listing groups', () => {
    expect(hasGroupsOverage({ _claim_names: { groups: 'src1' } }, 'groups')).toBe(true);
    expect(hasGroupsOverage({ groups: ['eng'] }, 'groups')).toBe(false);
    expect(hasGroupsOverage({}, 'groups')).toBe(false);
  });
});

describe('upsertIdentity / getIdentityEmail', () => {
  it('round-trips through the database chains', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const insertChain = {
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return insertChain;
      },
      onConflict: () => insertChain,
      execute: async () => [],
    };
    const selectChain = {
      select: () => selectChain,
      where: () => selectChain,
      executeTakeFirst: async () => ({ email: 'sam@example.com' }),
    };
    mockGetDatabase.mockReturnValue({
      ok: true,
      val: { insertInto: () => insertChain, selectFrom: () => selectChain },
    });

    const wrote = await upsertIdentity('subject-1', {
      email: 'sam@example.com',
      displayName: 'Sam',
      idpGroups: ['eng'],
    });
    expect(wrote.ok).toBe(true);
    expect(inserted[0]?.email).toBe('sam@example.com');
    expect(inserted[0]?.subject).toBe('subject-1');

    const read = await getIdentityEmail('subject-1');
    expect(read.ok && read.val).toBe('sam@example.com');
  });

  it('clears only the groups of the named subject', async () => {
    const sets: Array<Record<string, unknown>> = [];
    const wheres: unknown[][] = [];
    const updateChain = {
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return updateChain;
      },
      where: (...args: unknown[]) => {
        wheres.push(args);
        return updateChain;
      },
      execute: async () => [],
    };
    mockGetDatabase.mockReturnValue({ ok: true, val: { updateTable: () => updateChain } });

    const cleared = await clearIdpGroups('subject-1');
    expect(cleared.ok).toBe(true);
    expect(sets[0]?.idp_groups).toEqual([]);
    expect(sets[0]?.email).toBeUndefined();
    expect(wheres).toEqual([['subject', '=', 'subject-1']]);
  });

  it('reports null for a subject with no recorded identity', async () => {
    const selectChain = {
      select: () => selectChain,
      where: () => selectChain,
      executeTakeFirst: async () => undefined,
    };
    mockGetDatabase.mockReturnValue({ ok: true, val: { selectFrom: () => selectChain } });

    const read = await getIdentityEmail('stranger');
    expect(read.ok && read.val === null).toBe(true);
  });

  it('fails with DB_ERROR when the database is unavailable', async () => {
    mockGetDatabase.mockReturnValue({ ok: false, err: { type: 'DB_ERROR' } });
    const read = await getIdentityEmail('subject-1');
    expect(read.ok).toBe(false);
  });
});
