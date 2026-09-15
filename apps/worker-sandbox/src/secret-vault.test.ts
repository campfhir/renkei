/**
 * The vault's contract: a key is held only after the passphrase proves
 * itself against the blob, only until its window closes, and never after
 * lock or close; nothing survives a wrong passphrase. With a shared key
 * store, a second vault (another replica) opens what the first unlocked,
 * and a lock on either locks both.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealSecretFields } from '@renkei/connector-sandbox';
import { createSecretKeyStore } from './secret-key-store';
import { SecretVault } from './secret-vault';

const PASSPHRASE = 'correct horse battery staple';
const FIELDS = { username: 'alice', password: 'hunter2!' };
const ALICE = { tenantId: 'tenant-1', subject: 'auth0|alice' };

describe('SecretVault', () => {
  it('unlocks only with the right passphrase and opens the fields while held', async () => {
    const clock = { now: 1_000 };
    const vault = new SecretVault({ now: () => clock.now, sweepIntervalMs: 60 * 60_000 });
    const sealed = sealSecretFields(FIELDS, PASSPHRASE);
    expect(await vault.unlock(ALICE, 's1', sealed, 'wrong passphrase!!', clock.now + 1000)).toBe(
      false
    );
    expect(await vault.open(ALICE, 's1', sealed)).toBeNull();
    expect(await vault.unlockedUntil(ALICE, 's1')).toBeNull();

    expect(await vault.unlock(ALICE, 's1', sealed, PASSPHRASE, clock.now + 1000)).toBe(true);
    expect(await vault.open(ALICE, 's1', sealed)).toEqual(FIELDS);
    expect(await vault.unlockedUntil(ALICE, 's1')).toEqual(new Date(2_000));
    expect(vault.size()).toBe(1);
    vault.close();
  });

  it('drops the key when the window closes, on lock, and on close', async () => {
    const clock = { now: 1_000 };
    const vault = new SecretVault({ now: () => clock.now, sweepIntervalMs: 60 * 60_000 });
    const sealed = sealSecretFields(FIELDS, PASSPHRASE);
    await vault.unlock(ALICE, 's1', sealed, PASSPHRASE, clock.now + 500);
    clock.now += 500;
    expect(await vault.open(ALICE, 's1', sealed)).toBeNull();
    expect(vault.size()).toBe(0);

    await vault.unlock(ALICE, 's1', sealed, PASSPHRASE, clock.now + 5000);
    expect(await vault.lock('s1')).toBe(true);
    expect(await vault.lock('s1')).toBe(false);
    expect(await vault.open(ALICE, 's1', sealed)).toBeNull();

    await vault.unlock(ALICE, 's1', sealed, PASSPHRASE, clock.now + 5000);
    vault.close();
    expect(await vault.open(ALICE, 's1', sealed)).toBeNull();
  });

  it('a held key cannot open a different blob', async () => {
    const vault = new SecretVault({ sweepIntervalMs: 60 * 60_000 });
    const sealed = sealSecretFields(FIELDS, PASSPHRASE);
    const other = sealSecretFields(FIELDS, 'another passphrase entirely');
    await vault.unlock(ALICE, 's1', sealed, PASSPHRASE, Date.now() + 5000);
    expect(await vault.open(ALICE, 's1', other)).toBeNull();
    vault.close();
  });

  describe('with a shared key store', () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'renkei-vault-'));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('another replica opens what this one unlocked, and a lock anywhere locks all', async () => {
      const clock = { now: 1_000 };
      const store = createSecretKeyStore(root, Buffer.alloc(32, 3))!;
      const here = new SecretVault({ now: () => clock.now, sweepIntervalMs: 60 * 60_000, store });
      const there = new SecretVault({ now: () => clock.now, sweepIntervalMs: 60 * 60_000, store });
      const sealed = sealSecretFields(FIELDS, PASSPHRASE);
      expect(await here.unlock(ALICE, 's1', sealed, PASSPHRASE, clock.now + 5000)).toBe(true);
      expect(here.size()).toBe(0);
      expect(await there.open(ALICE, 's1', sealed)).toEqual(FIELDS);
      expect(await there.unlockedUntil(ALICE, 's1')).toEqual(new Date(6_000));
      // Another owner's replica cannot open it under its own derivation.
      expect(
        await there.open({ tenantId: 'tenant-1', subject: 'auth0|bob' }, 's1', sealed)
      ).toBeNull();
      await here.unlock(ALICE, 's1', sealed, PASSPHRASE, clock.now + 5000);
      expect(await there.lock('s1')).toBe(true);
      expect(await here.open(ALICE, 's1', sealed)).toBeNull();
      // The window lapses for both.
      await here.unlock(ALICE, 's1', sealed, PASSPHRASE, clock.now + 500);
      clock.now += 500;
      expect(await there.open(ALICE, 's1', sealed)).toBeNull();
      // A restart (close) does not lock what is on the shared disk.
      await here.unlock(ALICE, 's1', sealed, PASSPHRASE, clock.now + 5000);
      here.close();
      expect(await there.open(ALICE, 's1', sealed)).toEqual(FIELDS);
      there.close();
    });
  });
});
