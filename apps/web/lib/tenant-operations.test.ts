/**
 * The identity-provider record's writers agree on what they persist. The
 * first-run insert (createTenantOidcIfAbsent) and the operator's upsert
 * (setTenantOidc) take the same input; a column one of them dropped would
 * make the first configuration mean something different from every later
 * one — which is how the groups claim collected on the setup form once went
 * unrecorded until an operator re-saved the mapping.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/crypto', () => ({
  loadKeyring: jest.fn(() => ({ ok: true, val: 'keyring' })),
  encrypt: jest.fn((value: string) => `sealed:${value}`),
  decrypt: jest.fn((value: string) => value.replace(/^sealed:/, '')),
}));

import { createTenantOidcIfAbsent, setTenantOidc, type TenantOidc } from './tenant-operations';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

const OIDC: TenantOidc = {
  issuer: 'https://idp.example.com',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  roleClaim: 'roles',
  operatorIdpValue: 'renkei-operator',
  userIdpValue: 'renkei-user',
  groupsClaim: 'memberOf',
};

/** A database that records what each writer hands it. */
function recordingDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const insertChain = {
    values: (row: Record<string, unknown>) => {
      inserted.push(row);
      return insertChain;
    },
    onConflict: (build: (oc: unknown) => unknown) => {
      const oc = {
        expression: () => ({
          doNothing: () => oc,
          doUpdateSet: (row: Record<string, unknown>) => {
            updated.push(row);
            return oc;
          },
        }),
      };
      build(oc);
      return insertChain;
    },
    execute: async () => [],
    executeTakeFirst: async () => ({ numInsertedOrUpdatedRows: BigInt(1) }),
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: { insertInto: () => insertChain } });
  return { inserted, updated };
}

beforeEach(() => {
  mockGetDatabase.mockReset();
});

describe('the identity provider record', () => {
  it('is written the same by first-run setup and by an operator', async () => {
    const first = recordingDb();
    const created = await createTenantOidcIfAbsent(OIDC);
    expect(created).toEqual({ ok: true, val: true });

    const later = recordingDb();
    const saved = await setTenantOidc(OIDC);
    expect(saved.ok).toBe(true);

    const persisted = (row: Record<string, unknown>) => ({
      issuer: row.issuer,
      client_id: row.client_id,
      client_secret: row.client_secret,
      role_claim: row.role_claim,
      operator_idp_value: row.operator_idp_value,
      user_idp_value: row.user_idp_value,
      groups_claim: row.groups_claim,
    });
    expect(persisted(first.inserted[0])).toEqual(persisted(later.inserted[0]));
    expect(persisted(first.inserted[0])).toEqual(persisted(later.updated[0]));
    expect(first.inserted[0].groups_claim).toBe('memberOf');
    expect(first.inserted[0].client_secret).toBe('sealed:secret-1');
  });

  it('records no groups claim when the form left it empty', async () => {
    const { inserted } = recordingDb();
    await createTenantOidcIfAbsent({ ...OIDC, groupsClaim: '' });
    expect(inserted[0].groups_claim).toBeNull();
  });
});
