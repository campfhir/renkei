/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The service layer's contract: per-user credential resolution, path
 * discipline, and error tagging — the exact seam the fileshare worker
 * serves over HTTP. The store and protocol backends are mocked; the
 * credential envelope runs for real. There is deliberately no
 * authorization to test here beyond resolution: the file server judges
 * every operation by the caller's own account.
 */

jest.mock('./store', () => {
  const actual = jest.requireActual<typeof import('./store')>('./store');
  return {
    ...actual,
    getShare: jest.fn(),
    readConnectionCiphertext: jest.fn(),
  };
});
jest.mock('./backend', () => ({ openBackend: jest.fn() }));
jest.mock('./limits', () => {
  const actual = jest.requireActual<typeof import('./limits')>('./limits');
  return {
    ...actual,
    withSessionLimits: (_shareId: string, _lane: string, work: () => Promise<unknown>) => work(),
  };
});

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { RawEntry, ShareSummary } from './types';
import type { ShareBackend } from './backend';
import { encryptCredentials } from './credentials';
import {
  serviceListFolder,
  serviceMakeFolder,
  serviceMoveEntry,
  servicePreviewRemove,
  serviceReadFile,
  serviceRemoveEntry,
  serviceRenameEntry,
  serviceStatEntry,
  serviceTestConnection,
  serviceWriteFile,
  type ServiceDeps,
} from './service';

const { getShare, readConnectionCiphertext } = jest.requireMock<{
  getShare: jest.Mock;
  readConnectionCiphertext: jest.Mock;
}>('./store');
const { openBackend } = jest.requireMock<{ openBackend: jest.Mock }>('./backend');

const KEY = Buffer.alloc(32, 7);
const SHARE_ID = 'share-1';

function deps(): ServiceDeps {
  return { db: {} as Kysely<DB>, encryptionKey: KEY };
}

function target() {
  return { tenantId: 'tenant-1', shareId: SHARE_ID, subject: 'auth0|alice' };
}

function summary(overrides?: Partial<ShareSummary>): ShareSummary {
  return {
    id: SHARE_ID,
    name: 'Accounting',
    protocol: 'sftp',
    host: 'nas.example.test',
    port: null,
    shareName: null,
    rootPath: '/srv/accounting',
    caseInsensitive: false,
    enabled: true,
    ...overrides,
  };
}

function shareRow(overrides?: Partial<ShareSummary>) {
  return {
    ok: true,
    val: {
      summary: summary(overrides),
      settings: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };
}

interface FakeCalls {
  removes: Array<{ path: string; kind: string }>;
  renames: Array<{ from: string; to: string }>;
  writes: string[];
}

function fakeBackend(tree: Record<string, RawEntry[] | Uint8Array>): {
  backend: ShareBackend;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { removes: [], renames: [], writes: [] };
  const backend: ShareBackend = {
    async list(path) {
      const node = tree[path];
      if (Array.isArray(node)) return { ok: true, val: node };
      return { ok: false, val: undefined, err: { type: 'not_found' as const } } as never;
    },
    async stat(path) {
      const node = tree[path];
      if (Array.isArray(node)) {
        return { ok: true, val: { name: path, kind: 'dir' as const, size: null, modifiedAt: null } };
      }
      if (node instanceof Uint8Array) {
        return {
          ok: true,
          val: { name: path, kind: 'file' as const, size: node.byteLength, modifiedAt: null },
        };
      }
      return { ok: false, val: undefined, err: { type: 'not_found' as const } } as never;
    },
    async read(path) {
      const node = tree[path];
      if (node instanceof Uint8Array) return { ok: true, val: node };
      return { ok: false, val: undefined, err: { type: 'not_found' as const } } as never;
    },
    async write(path) {
      calls.writes.push(path);
      return { ok: true, val: undefined };
    },
    async mkdir() {
      return { ok: true, val: undefined };
    },
    async remove(path, kind) {
      calls.removes.push({ path, kind });
      return { ok: true, val: undefined };
    },
    async rename(from, to) {
      calls.renames.push({ from, to });
      return { ok: true, val: undefined };
    },
    async close() {},
  };
  return { backend, calls };
}

function arm(tree: Record<string, RawEntry[] | Uint8Array>): FakeCalls {
  getShare.mockResolvedValue(shareRow());
  readConnectionCiphertext.mockResolvedValue({
    ok: true,
    val: encryptCredentials({ protocol: 'sftp', username: 'alice', password: 'pw' }, KEY),
  });
  const { backend, calls } = fakeBackend(tree);
  openBackend.mockResolvedValue({ ok: true, val: backend });
  return calls;
}

beforeEach(() => jest.clearAllMocks());

describe('resolution failures', () => {
  it('answers no_share alike for a missing share and a disabled one', async () => {
    getShare.mockResolvedValue({ ok: true, val: null });
    const missing = await serviceListFolder(deps(), target(), '/');
    expect(missing).toMatchObject({ ok: false, err: { type: 'no_share' } });

    getShare.mockResolvedValue(shareRow({ enabled: false }));
    const disabled = await serviceListFolder(deps(), target(), '/');
    expect(disabled).toMatchObject({ ok: false, err: { type: 'no_share' } });
  });

  it('reports an unconnected caller and an unreadable credential distinctly', async () => {
    getShare.mockResolvedValue(shareRow());
    readConnectionCiphertext.mockResolvedValue({ ok: true, val: null });
    const unconnected = await serviceListFolder(deps(), target(), '/');
    expect(unconnected).toMatchObject({ ok: false, err: { type: 'not_connected' } });

    readConnectionCiphertext.mockResolvedValue({ ok: true, val: 'not-a-ciphertext' });
    const garbled = await serviceListFolder(deps(), target(), '/');
    expect(garbled).toMatchObject({ ok: false, err: { type: 'bad_credentials' } });
  });

  it('fails closed on a store error', async () => {
    getShare.mockResolvedValue({ ok: false, err: { type: 'DB_ERROR' } });
    const result = await serviceListFolder(deps(), target(), '/');
    expect(result).toMatchObject({ ok: false, err: { type: 'store' } });
  });

  it('resolves the CALLER as the credential owner', async () => {
    arm({ '/': [] });
    await serviceListFolder(deps(), target(), '/');
    expect(readConnectionCiphertext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      SHARE_ID,
      'auth0|alice'
    );
  });
});

describe('path discipline', () => {
  it('refuses traversal spellings with the traversal message', async () => {
    arm({ '/': [] });
    const result = await serviceListFolder(deps(), target(), '/../etc');
    expect(result).toMatchObject({ ok: false, err: { type: 'bad_path' } });
    if (!result.ok) expect(result.err.message).toContain('".."');
    expect(openBackend).not.toHaveBeenCalled();
  });

  it('folds backslashes before deciding', async () => {
    arm({ '/reports': [] });
    const result = await serviceListFolder(deps(), target(), '\\reports\\');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.path).toBe('/reports');
  });
});

describe('operations', () => {
  const ENTRIES: RawEntry[] = [
    { name: 'q4.xlsx', kind: 'file', size: 10, modifiedAt: null },
    { name: 'archive', kind: 'dir', size: null, modifiedAt: null },
  ];

  it('lists a folder and roots every entry path at the share', async () => {
    arm({ '/reports': ENTRIES });
    const result = await serviceListFolder(deps(), target(), '/reports');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.share).toEqual({ id: SHARE_ID, name: 'Accounting' });
      expect(result.val.entries.map((entry) => entry.path)).toEqual([
        '/reports/q4.xlsx',
        '/reports/archive',
      ]);
    }
  });

  it('stat reports kind and size', async () => {
    arm({ '/reports/q4.xlsx': new Uint8Array(10) });
    const result = await serviceStatEntry(deps(), target(), '/reports/q4.xlsx');
    expect(result).toMatchObject({ ok: true, val: { kind: 'file', size: 10 } });
  });

  it('read refuses the root and returns bytes for a file', async () => {
    arm({ '/notes.txt': new Uint8Array([1, 2, 3]) });
    const root = await serviceReadFile(deps(), target(), '/', 100);
    expect(root).toMatchObject({ ok: false, err: { type: 'bad_path' } });

    const file = await serviceReadFile(deps(), target(), '/notes.txt', 100);
    expect(file.ok).toBe(true);
    if (file.ok) expect(file.val.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('caps writes at the supplied limit', async () => {
    const calls = arm({});
    const result = await serviceWriteFile(deps(), target(), '/big.bin', new Uint8Array(11), 10);
    expect(result).toMatchObject({ ok: false, err: { type: 'too_large' } });
    expect(calls.writes).toEqual([]);
  });

  it('writes within the limit', async () => {
    const calls = arm({});
    const result = await serviceWriteFile(deps(), target(), '/ok.bin', new Uint8Array(5), 10);
    expect(result.ok).toBe(true);
    expect(calls.writes).toEqual(['/ok.bin']);
  });

  it('mkdir refuses the root', async () => {
    arm({});
    const result = await serviceMakeFolder(deps(), target(), '/');
    expect(result).toMatchObject({ ok: false, err: { type: 'bad_path' } });
  });

  it('deletes with the kind from its stat', async () => {
    const calls = arm({ '/old.txt': new Uint8Array(1) });
    const result = await serviceRemoveEntry(deps(), target(), '/old.txt');
    expect(result.ok).toBe(true);
    expect(calls.removes).toEqual([{ path: '/old.txt', kind: 'file' }]);
  });

  it('preview refuses a non-empty folder without touching remove', async () => {
    const calls = arm({
      '/stash': [{ name: 'keep.txt', kind: 'file', size: 1, modifiedAt: null }],
    });
    const result = await servicePreviewRemove(deps(), target(), '/stash');
    expect(result).toMatchObject({ ok: false, err: { type: 'not_empty' } });
    expect(calls.removes).toEqual([]);
  });

  it('preview describes an empty folder and never removes it', async () => {
    const calls = arm({ '/stash': [] });
    const result = await servicePreviewRemove(deps(), target(), '/stash');
    expect(result).toMatchObject({ ok: true, val: { kind: 'dir', path: '/stash' } });
    expect(calls.removes).toEqual([]);
  });

  it('move keeps the name and reports the new path', async () => {
    const calls = arm({});
    const result = await serviceMoveEntry(deps(), target(), '/reports/q4.xlsx', '/archive');
    expect(result).toMatchObject({ ok: true, val: { path: '/archive/q4.xlsx', unchanged: false } });
    expect(calls.renames).toEqual([{ from: '/reports/q4.xlsx', to: '/archive/q4.xlsx' }]);
  });

  it('a move to where it already lives is unchanged, with no I/O', async () => {
    const calls = arm({});
    const result = await serviceMoveEntry(deps(), target(), '/reports/q4.xlsx', '/reports');
    expect(result).toMatchObject({ ok: true, val: { unchanged: true } });
    expect(calls.renames).toEqual([]);
  });

  it('rename validates the new name as a plain name and stays in the folder', async () => {
    const calls = arm({});
    const bad = await serviceRenameEntry(deps(), target(), '/reports/q4.xlsx', 'a/b');
    expect(bad).toMatchObject({ ok: false, err: { type: 'bad_path' } });

    const good = await serviceRenameEntry(deps(), target(), '/reports/q4.xlsx', 'final.xlsx');
    expect(good).toMatchObject({ ok: true, val: { path: '/reports/final.xlsx' } });
    expect(calls.renames).toEqual([{ from: '/reports/q4.xlsx', to: '/reports/final.xlsx' }]);
  });

  it('the share root is not movable, renamable, or deletable', async () => {
    arm({});
    for (const attempt of [
      serviceMoveEntry(deps(), target(), '/', '/x'),
      serviceRenameEntry(deps(), target(), '/', 'x'),
      serviceRemoveEntry(deps(), target(), '/'),
    ]) {
      expect(await attempt).toMatchObject({ ok: false, err: { type: 'bad_path' } });
    }
  });
});

describe('test connection', () => {
  it('opens a session with the supplied credential and counts the root', async () => {
    getShare.mockResolvedValue(shareRow());
    const { backend } = fakeBackend({
      '/': [{ name: 'a.txt', kind: 'file', size: 1, modifiedAt: null }],
    });
    openBackend.mockResolvedValue({ ok: true, val: backend });
    const result = await serviceTestConnection(deps(), 'tenant-1', SHARE_ID, {
      protocol: 'sftp',
      username: 'alice',
      password: 'pw',
    });
    expect(result).toMatchObject({ ok: true, val: { entries: 1 } });
    // The stored credential is never consulted: the test is of the
    // credential the person just typed.
    expect(readConnectionCiphertext).not.toHaveBeenCalled();
  });

  it('refuses a credential whose protocol does not match the share', async () => {
    getShare.mockResolvedValue(shareRow());
    const result = await serviceTestConnection(deps(), 'tenant-1', SHARE_ID, {
      protocol: 'smb',
      username: 'alice',
      password: 'pw',
    });
    expect(result).toMatchObject({ ok: false, err: { type: 'bad_credentials' } });
    expect(openBackend).not.toHaveBeenCalled();
  });

  it('answers no_share for a missing or disabled share', async () => {
    getShare.mockResolvedValue({ ok: true, val: null });
    const missing = await serviceTestConnection(deps(), 'tenant-1', SHARE_ID, {
      protocol: 'sftp',
      username: 'alice',
      password: 'pw',
    });
    expect(missing).toMatchObject({ ok: false, err: { type: 'no_share' } });
  });
});
