/**
 * The on-disk store for unlocked secret keys: sealed per owner and secret
 * under a key derived from the deployment's; a wrong key, a past window
 * or a removed file read as locked; and no store without a key.
 */

import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretKeyStore, secretKeySealingKey } from './secret-key-store';

const ROOT_KEY = Buffer.alloc(32, 5);
const ALICE = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const BOB = { tenantId: 'tenant-1', subject: 'auth0|bob' };
const KEY = Buffer.from('0123456789abcdef0123456789abcdef');

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'renkei-skeys-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createSecretKeyStore', () => {
  it('is null without a sealing key', () => {
    expect(createSecretKeyStore(root, null)).toBeNull();
  });

  it('holds a key sealed on disk for its window, for its owner only', async () => {
    const store = createSecretKeyStore(root, ROOT_KEY)!;
    await store.save(ALICE, 's1', { key: KEY, until: 10_000 });
    expect(await store.load(ALICE, 's1', 5_000)).toEqual({ key: KEY, until: 10_000 });
    const [file] = await readdir(join(root, 'secret-keys'));
    const bytes = await readFile(join(root, 'secret-keys', file!), 'utf8');
    expect(bytes.startsWith('skey1.')).toBe(true);
    expect(bytes).not.toContain(KEY.toString('base64'));
    // Bob's derived key does not open Alice's file — and the failed open drops it.
    expect(await store.load(BOB, 's1', 5_000)).toBeNull();
    expect(await readdir(join(root, 'secret-keys'))).toEqual([]);
    expect(
      secretKeySealingKey(ROOT_KEY, ALICE, 's1').equals(secretKeySealingKey(ROOT_KEY, ALICE, 's2'))
    ).toBe(false);
  });

  it('reads as locked past the window and after remove', async () => {
    const store = createSecretKeyStore(root, ROOT_KEY)!;
    await store.save(ALICE, 's1', { key: KEY, until: 10_000 });
    expect(await store.load(ALICE, 's1', 10_000)).toBeNull();
    await store.save(ALICE, 's1', { key: KEY, until: 10_000 });
    expect(await store.remove('s1')).toBe(true);
    expect(await store.remove('s1')).toBe(false);
    expect(await store.load(ALICE, 's1', 5_000)).toBeNull();
  });

  it('sweeps files older than any window could be', async () => {
    const store = createSecretKeyStore(root, ROOT_KEY)!;
    await store.save(ALICE, 's1', { key: KEY, until: 10_000 });
    await store.save(ALICE, 's2', { key: KEY, until: 10_000 });
    const [first] = await readdir(join(root, 'secret-keys'));
    const old = (Date.now() - 26 * 60 * 60_000) / 1000;
    await utimes(join(root, 'secret-keys', first!), old, old);
    expect(await store.sweep()).toBe(1);
    expect(await readdir(join(root, 'secret-keys'))).toHaveLength(1);
  });
});
