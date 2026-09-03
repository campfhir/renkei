/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The resolver's refusals, each by name: unknown secret, unknown field,
 * page on a host the secret is not scoped to, locked; and the one path
 * that yields a value, which also records the use.
 */

jest.mock('./secrets-store', () => ({
  getSecretByName: jest.fn(),
  touchSecretUsed: jest.fn(async () => undefined),
}));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { sealSecretFields } from '@renkei/connector-sandbox';
import { BrowserOpError } from './browser';
import { SecretVault } from './secret-vault';
import { createSecretResolver } from './secrets';

const store = jest.requireMock<{ getSecretByName: jest.Mock; touchSecretUsed: jest.Mock }>(
  './secrets-store'
);

const TARGET = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const PASSPHRASE = 'correct horse battery staple';
const SEALED = sealSecretFields({ username: 'alice', password: 'hunter2!' }, PASSPHRASE);
const ROW = {
  id: 'secret-1',
  ...TARGET,
  name: 'vendor-portal',
  fields: ['username', 'password'],
  hosts: ['portal.vendor.com', '*.vendor.com'],
  sealed: SEALED,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 1000),
  lastUsedAt: null,
};

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserOpError);
    expect((error as BrowserOpError).type).toBe('secret_unavailable');
    return (error as BrowserOpError).message;
  }
  throw new Error('expected a refusal');
}

describe('createSecretResolver', () => {
  let vault: SecretVault;

  beforeEach(() => {
    jest.clearAllMocks();
    vault = new SecretVault({ sweepIntervalMs: 60 * 60_000 });
    store.getSecretByName.mockResolvedValue(ROW);
  });

  afterEach(() => vault.close());

  it('types the value when the secret is unlocked and the page is on a scoped host', async () => {
    vault.unlock(ROW.id, SEALED, PASSPHRASE, Date.now() + 60_000);
    const resolve = createSecretResolver({} as Kysely<DB>, vault);
    await expect(
      resolve(TARGET, { name: 'vendor-portal', field: 'password' }, 'portal.vendor.com')
    ).resolves.toBe('hunter2!');
    await expect(
      resolve(TARGET, { name: 'vendor-portal', field: 'username' }, 'sso.vendor.com')
    ).resolves.toBe('alice');
    expect(store.getSecretByName).toHaveBeenCalledWith({}, TARGET, 'vendor-portal');
    expect(store.touchSecretUsed).toHaveBeenCalledWith({}, ROW.id);
  });

  it('refuses, naming why, and never touches the row', async () => {
    const resolve = createSecretResolver({} as Kysely<DB>, vault);
    store.getSecretByName.mockResolvedValueOnce(undefined);
    expect(
      await refusal(resolve(TARGET, { name: 'nope', field: 'password' }, 'portal.vendor.com'))
    ).toContain('No secret named "nope"');
    expect(
      await refusal(resolve(TARGET, { name: 'vendor-portal', field: 'token' }, 'portal.vendor.com'))
    ).toContain('has no field "token"');
    expect(
      await refusal(resolve(TARGET, { name: 'vendor-portal', field: 'password' }, 'evil.example'))
    ).toContain('may only be typed on portal.vendor.com, *.vendor.com');
    expect(
      await refusal(
        resolve(TARGET, { name: 'vendor-portal', field: 'password' }, 'portal.vendor.com')
      )
    ).toContain('is locked');
    expect(store.touchSecretUsed).not.toHaveBeenCalled();
  });
});
