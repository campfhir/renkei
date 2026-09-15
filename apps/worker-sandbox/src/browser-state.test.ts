/**
 * The on-disk browser session store: sealed per caller under a key derived
 * from the deployment's, so one caller's file never opens for another;
 * whole-file writes; a TTL both on read and in the sweep; and no store at
 * all without a key.
 */

import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_STATE_TTL_MS,
  browserStateKey,
  createBrowserStateStore,
  type SavedBrowserState,
} from './browser-state';

const KEY = Buffer.alloc(32, 7);
const ALICE = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const BOB = { tenantId: 'tenant-1', subject: 'auth0|bob' };

const state = (url = 'https://example.com/inbox'): SavedBrowserState => ({
  url,
  storageState: {
    cookies: [
      {
        name: 'sid',
        value: 'secret-session',
        domain: 'example.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  },
  refSignatures: [['e3', { sig: 'button|Send|', ordinal: 0 }]],
  savedAt: Date.now(),
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'renkei-bstate-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createBrowserStateStore', () => {
  it('is null without a sealing key', () => {
    expect(createBrowserStateStore(root, null)).toBeNull();
  });

  it('round-trips a session, sealed on disk, and only for its own caller', async () => {
    const store = createBrowserStateStore(root, KEY)!;
    const saved = state();
    await store.save(ALICE, saved);
    expect(await store.load(ALICE)).toEqual(saved);
    const [file] = await readdir(join(root, 'browser-state'));
    const bytes = await readFile(join(root, 'browser-state', file!), 'utf8');
    expect(bytes.startsWith('bstate1.')).toBe(true);
    expect(bytes).not.toContain('secret-session');
    expect(bytes).not.toContain('example.com');
    // Bob has his own file name, and Alice's key opens nothing of his.
    expect(await store.load(BOB)).toBeNull();
    expect(browserStateKey(KEY, ALICE).equals(browserStateKey(KEY, BOB))).toBe(false);
    expect(browserStateKey(KEY, ALICE).equals(browserStateKey(KEY, ALICE))).toBe(true);
  });

  it('drops a file that does not open under the caller’s key', async () => {
    const store = createBrowserStateStore(root, KEY)!;
    await store.save(ALICE, state());
    const other = createBrowserStateStore(root, Buffer.alloc(32, 9))!;
    expect(await other.load(ALICE)).toBeNull();
    expect(await readdir(join(root, 'browser-state'))).toEqual([]);
  });

  it('forgets a session on remove and past its TTL', async () => {
    const store = createBrowserStateStore(root, KEY)!;
    await store.save(ALICE, state());
    await store.remove(ALICE);
    expect(await store.load(ALICE)).toBeNull();
    await store.save(ALICE, { ...state(), savedAt: Date.now() - BROWSER_STATE_TTL_MS - 1 });
    expect(await store.load(ALICE)).toBeNull();
  });

  it('sweeps files older than the TTL and leaves the rest', async () => {
    const store = createBrowserStateStore(root, KEY)!;
    await store.save(ALICE, state());
    await store.save(BOB, state());
    const [first] = await readdir(join(root, 'browser-state'));
    const old = (Date.now() - BROWSER_STATE_TTL_MS - 60_000) / 1000;
    await utimes(join(root, 'browser-state', first!), old, old);
    expect(await store.sweep()).toBe(1);
    expect(await readdir(join(root, 'browser-state'))).toHaveLength(1);
  });
});
