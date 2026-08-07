/**
 * The identity spine's contract: the email is taken from the id_token's
 * standard claim (with Azure AD's preferred_username accepted when it looks
 * like an address), normalized to lowercase, and a token with no address
 * yields no identity — recorded as absent, never guessed.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import { identityClaimsFromIdToken, upsertIdentity, getIdentityEmail } from './identity';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

beforeEach(() => {
  mockGetDatabase.mockReset();
});

describe('identityClaimsFromIdToken', () => {
  it('prefers the standard email claim, lowercased', () => {
    const claims = identityClaimsFromIdToken({
      email: 'Sam.Lee@Example.COM',
      preferred_username: 'sam.other@example.com',
      name: 'Sam Lee',
    });
    expect(claims).toEqual({ email: 'sam.lee@example.com', displayName: 'Sam Lee' });
  });

  it('falls back to preferred_username when it looks like an address', () => {
    const claims = identityClaimsFromIdToken({ preferred_username: 'sam@example.com' });
    expect(claims?.email).toBe('sam@example.com');
    expect(claims?.displayName).toBeNull();
  });

  it('yields nothing for a token with no address anywhere', () => {
    expect(identityClaimsFromIdToken({ preferred_username: 'DOMAIN\\sam', name: 'Sam' })).toBeNull();
    expect(identityClaimsFromIdToken({})).toBeNull();
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

    const wrote = await upsertIdentity('tenant-1', 'subject-1', {
      email: 'sam@example.com',
      displayName: 'Sam',
    });
    expect(wrote.ok).toBe(true);
    expect(inserted[0]?.email).toBe('sam@example.com');
    expect(inserted[0]?.subject).toBe('subject-1');

    const read = await getIdentityEmail('tenant-1', 'subject-1');
    expect(read.ok && read.val).toBe('sam@example.com');
  });

  it('reports null for a subject with no recorded identity', async () => {
    const selectChain = {
      select: () => selectChain,
      where: () => selectChain,
      executeTakeFirst: async () => undefined,
    };
    mockGetDatabase.mockReturnValue({ ok: true, val: { selectFrom: () => selectChain } });

    const read = await getIdentityEmail('tenant-1', 'stranger');
    expect(read.ok && read.val === null).toBe(true);
  });

  it('fails with DB_ERROR when the database is unavailable', async () => {
    mockGetDatabase.mockReturnValue({ ok: false, err: { type: 'DB_ERROR' } });
    const read = await getIdentityEmail('tenant-1', 'subject-1');
    expect(read.ok).toBe(false);
  });
});
