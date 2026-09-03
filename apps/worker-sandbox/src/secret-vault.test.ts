/**
 * The vault's contract: a key is held only after the passphrase proves
 * itself against the blob, only until its window closes, and never after
 * lock or close; nothing survives a wrong passphrase.
 */

import { sealSecretFields } from '@renkei/connector-sandbox';
import { SecretVault } from './secret-vault';

const PASSPHRASE = 'correct horse battery staple';
const FIELDS = { username: 'alice', password: 'hunter2!' };

describe('SecretVault', () => {
  it('unlocks only with the right passphrase and opens the fields while held', () => {
    const clock = { now: 1_000 };
    const vault = new SecretVault({ now: () => clock.now, sweepIntervalMs: 60 * 60_000 });
    const sealed = sealSecretFields(FIELDS, PASSPHRASE);
    expect(vault.unlock('s1', sealed, 'wrong passphrase!!', clock.now + 1000)).toBe(false);
    expect(vault.open('s1', sealed)).toBeNull();
    expect(vault.unlockedUntil('s1')).toBeNull();

    expect(vault.unlock('s1', sealed, PASSPHRASE, clock.now + 1000)).toBe(true);
    expect(vault.open('s1', sealed)).toEqual(FIELDS);
    expect(vault.unlockedUntil('s1')).toEqual(new Date(2_000));
    expect(vault.size()).toBe(1);
    vault.close();
  });

  it('drops the key when the window closes, on lock, and on close', () => {
    const clock = { now: 1_000 };
    const vault = new SecretVault({ now: () => clock.now, sweepIntervalMs: 60 * 60_000 });
    const sealed = sealSecretFields(FIELDS, PASSPHRASE);
    vault.unlock('s1', sealed, PASSPHRASE, clock.now + 500);
    clock.now += 500;
    expect(vault.open('s1', sealed)).toBeNull();
    expect(vault.size()).toBe(0);

    vault.unlock('s1', sealed, PASSPHRASE, clock.now + 5000);
    expect(vault.lock('s1')).toBe(true);
    expect(vault.lock('s1')).toBe(false);
    expect(vault.open('s1', sealed)).toBeNull();

    vault.unlock('s1', sealed, PASSPHRASE, clock.now + 5000);
    vault.close();
    expect(vault.open('s1', sealed)).toBeNull();
  });

  it('a held key cannot open a different blob', () => {
    const vault = new SecretVault({ sweepIntervalMs: 60 * 60_000 });
    const sealed = sealSecretFields(FIELDS, PASSPHRASE);
    const other = sealSecretFields(FIELDS, 'another passphrase entirely');
    vault.unlock('s1', sealed, PASSPHRASE, Date.now() + 5000);
    expect(vault.open('s1', other)).toBeNull();
    vault.close();
  });
});
