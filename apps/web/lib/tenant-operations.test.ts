/**
 * The identity-provider record's writers agree on what they persist. The
 * first-run insert (createTenantOidcIfAbsent) and the operator's upsert
 * (setTenantOidc) take the same input; a column one of them dropped would
 * make the first configuration mean something different from every later
 * one — which is how the groups claim collected on the setup form once went
 * unrecorded until an operator re-saved the mapping.
 */

jest.mock('@renkei/crypto', () => ({
  loadKeyring: jest.fn(() => ({ ok: true, val: 'keyring' })),
  encrypt: jest.fn((value: string) => `sealed:${value}`),
  decryptBoundValue: jest.fn((value: string) => ({
    ok: true,
    val: value.replace(/^sealed:/, ''),
  })),
  aadFor: jest.fn((purpose: string) => purpose),
  AAD_PURPOSE: { oidcClientSecret: 'oidc-client-secret' },
}));

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  createTenantOidcIfAbsent,
  getTenantOidc,
  setTenantOidc,
  type TenantOidc,
} from './tenant-operations';

const OIDC: TenantOidc = {
  issuer: 'https://idp.example.com',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  roleClaim: 'roles',
  operatorIdpValue: 'renkei-operator',
  userIdpValue: 'renkei-user',
  groupsClaim: 'memberOf',
};

/** A fresh memory store, and a read of the one row it holds. */
function freshStore() {
  const store = createMemoryDataStore();
  registerDataStore(store);
  return () => {
    const [row] = store.tables.select('oidc_config');
    return row && { ...row, id: undefined, created_at: undefined };
  };
}

afterAll(() => {
  resetDataStore();
});

describe('the identity provider record', () => {
  it('is written the same by first-run setup and by an operator', async () => {
    const first = freshStore();
    expect(await createTenantOidcIfAbsent(OIDC)).toEqual({ ok: true, val: true });

    const later = freshStore();
    expect((await setTenantOidc(OIDC)).ok).toBe(true);
    const insertedByOperator = later();
    // …and an operator replacing an existing record writes the same again.
    expect((await setTenantOidc(OIDC)).ok).toBe(true);

    expect(first()).toEqual(insertedByOperator);
    expect(later()).toEqual(insertedByOperator);
    expect(first()?.groups_claim).toBe('memberOf');
    expect(first()?.client_secret).toBe('sealed:secret-1');
  });

  it('records no groups claim when the form left it empty', async () => {
    const row = freshStore();
    await createTenantOidcIfAbsent({ ...OIDC, groupsClaim: '' });
    expect(row()?.groups_claim).toBeNull();
  });

  it('keeps the first configuration when setup races', async () => {
    freshStore();
    expect(await createTenantOidcIfAbsent(OIDC)).toEqual({ ok: true, val: true });
    expect(await createTenantOidcIfAbsent({ ...OIDC, issuer: 'https://other.example' })).toEqual({
      ok: true,
      val: false,
    });
    const read = await getTenantOidc();
    expect(read.ok && read.val?.issuer).toBe('https://idp.example.com');
    expect(read.ok && read.val?.clientSecret).toBe('secret-1');
  });
});
