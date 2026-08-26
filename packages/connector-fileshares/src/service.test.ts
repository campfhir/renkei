/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The service layer's contract: ACL enforcement, the destructive gate, and
 * error tagging — the exact seam the fileshare worker serves over HTTP.
 * The store and protocol backends are mocked; the ACL engine and the
 * credential envelope run for real, because those decisions are what the
 * worker's callers rely on being identical everywhere.
 */

jest.mock('./store', () => {
  const actual = jest.requireActual<typeof import('./store')>('./store');
  return {
    ...actual,
    getAclContext: jest.fn(),
    readCredentialCiphertext: jest.fn(),
    listRulePathsUnder: jest.fn(async () => ({ ok: true, val: [] })),
    getShare: jest.fn(),
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
import type { AclContext, RawEntry } from './types';
import type { ShareBackend } from './backend';
import { encryptCredentials } from './credentials';
import {
  serviceAdminSearch,
  serviceListFolder,
  serviceMakeFolder,
  serviceMoveEntry,
  servicePreviewRemove,
  serviceReadFile,
  serviceRemoveEntry,
  serviceRenameEntry,
  serviceStatEntry,
  serviceWriteFile,
  type ServiceDeps,
} from './service';

const { getAclContext, getShare, readCredentialCiphertext, listRulePathsUnder } = jest.requireMock<{
  getAclContext: jest.Mock;
  getShare: jest.Mock;
  readCredentialCiphertext: jest.Mock;
  listRulePathsUnder: jest.Mock;
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

function aclContext(overrides?: Partial<AclContext>): AclContext {
  return {
    share: {
      id: SHARE_ID,
      name: 'Accounting',
      protocol: 'sftp',
      host: 'nas.example.test',
      port: null,
      shareName: null,
      rootPath: '/srv/accounting',
      caseInsensitive: false,
      maxAccess: 'read_write',
      enabled: true,
      hasCredentials: true,
    },
    grant: { subject: 'auth0|alice', defaultAccess: 'read_write' },
    shareRules: [],
    userRules: [],
    ...overrides,
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

function arm(ctx: AclContext, tree: Record<string, RawEntry[] | Uint8Array>): FakeCalls {
  getAclContext.mockResolvedValue({ ok: true, val: ctx });
  readCredentialCiphertext.mockResolvedValue({
    ok: true,
    val: encryptCredentials({ protocol: 'sftp', username: 'svc', password: 'pw' }, KEY),
  });
  const { backend, calls } = fakeBackend(tree);
  openBackend.mockResolvedValue({ ok: true, val: backend });
  return calls;
}

beforeEach(() => {
  jest.clearAllMocks();
  listRulePathsUnder.mockResolvedValue({ ok: true, val: [] });
});

describe('resolution failures', () => {
  it('answers no_share alike for a missing share and a disabled one', async () => {
    getAclContext.mockResolvedValue({ ok: true, val: null });
    const missing = await serviceListFolder(deps(), target(), '/');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.err.type).toBe('no_share');

    getAclContext.mockResolvedValue({
      ok: true,
      val: aclContext({ share: { ...aclContext().share, enabled: false } }),
    });
    const disabled = await serviceListFolder(deps(), target(), '/');
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.err.type).toBe('no_share');
  });

  it('reports a missing credential and an unreadable one distinctly', async () => {
    getAclContext.mockResolvedValue({ ok: true, val: aclContext() });
    readCredentialCiphertext.mockResolvedValue({ ok: true, val: null });
    const missing = await serviceStatEntry(deps(), target(), '/x');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.err.type).toBe('no_credentials');

    readCredentialCiphertext.mockResolvedValue({ ok: true, val: 'garbage' });
    const unreadable = await serviceStatEntry(deps(), target(), '/x');
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.err.type).toBe('bad_credentials');
  });

  it('fails closed on a store error', async () => {
    getAclContext.mockResolvedValue({ ok: false, val: undefined, err: { type: 'DB_ERROR' } });
    const result = await serviceListFolder(deps(), target(), '/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('store');
  });
});

describe('path discipline', () => {
  it('refuses traversal spellings with the traversal message', async () => {
    arm(aclContext(), {});
    const result = await serviceReadFile(deps(), target(), '/a/../etc/passwd', 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.type).toBe('bad_path');
      expect(result.err.message).toContain('climbs out of the share');
    }
  });

  it('folds backslashes before deciding', async () => {
    const calls = arm(aclContext(), { '/docs/a.txt': new Uint8Array([1]) });
    const result = await serviceWriteFile(
      deps(),
      target(),
      '\\docs\\a.txt',
      new Uint8Array([1]),
      1024
    );
    expect(result.ok).toBe(true);
    expect(calls.writes).toEqual(['/docs/a.txt']);
  });
});

describe('ACL enforcement', () => {
  it('filters listings and marks traverse-only folders', async () => {
    const ctx = aclContext({
      grant: { subject: 'auth0|alice', defaultAccess: 'none' },
      userRules: [{ path: '/open/deep', access: 'read' }],
    });
    arm(ctx, {
      '/': [
        { name: 'open', kind: 'dir', size: null, modifiedAt: null },
        { name: 'closed', kind: 'dir', size: null, modifiedAt: null },
      ],
    });
    const result = await serviceListFolder(deps(), target(), '/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.entries.map((entry) => `${entry.name}:${entry.access}`)).toEqual([
        'open:traverse',
      ]);
      expect(result.val.access).toBe('none');
      expect(result.val.share).toEqual({ id: SHARE_ID, name: 'Accounting' });
    }
  });

  it('stat reports traverse for a shielding folder and refuses a fully closed one', async () => {
    const ctx = aclContext({
      grant: { subject: 'auth0|alice', defaultAccess: 'none' },
      userRules: [{ path: '/open/deep', access: 'read' }],
    });
    arm(ctx, { '/open': [], '/closed': [] });
    const shielding = await serviceStatEntry(deps(), target(), '/open');
    expect(shielding.ok).toBe(true);
    if (shielding.ok) expect(shielding.val.access).toBe('traverse');

    const closed = await serviceStatEntry(deps(), target(), '/closed');
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.err.type).toBe('forbidden');
  });

  it('read requires any access; write requires read_write', async () => {
    const ctx = aclContext({ grant: { subject: 'auth0|alice', defaultAccess: 'read' } });
    arm(ctx, { '/a.txt': new Uint8Array([1, 2]) });
    const read = await serviceReadFile(deps(), target(), '/a.txt', 1024);
    expect(read.ok).toBe(true);

    const write = await serviceWriteFile(deps(), target(), '/a.txt', new Uint8Array([1]), 1024);
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.err.type).toBe('forbidden');
  });

  it('caps writes at the supplied limit', async () => {
    arm(aclContext(), {});
    const result = await serviceWriteFile(deps(), target(), '/big.bin', new Uint8Array(11), 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('too_large');
  });

  it('mkdir authorizes on the parent folder', async () => {
    const ctx = aclContext({
      grant: { subject: 'auth0|alice', defaultAccess: 'read' },
      userRules: [{ path: '/drop', access: 'read_write' }],
    });
    arm(ctx, {});
    const allowed = await serviceMakeFolder(deps(), target(), '/drop/new');
    expect(allowed.ok).toBe(true);

    const refused = await serviceMakeFolder(deps(), target(), '/elsewhere/new');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.err.type).toBe('forbidden');
  });
});

describe('destructive operations', () => {
  it('refuses when any rule is anchored at or under the source', async () => {
    const calls = arm(aclContext(), { '/vault': [] });
    listRulePathsUnder.mockResolvedValue({ ok: true, val: ['/vault/secret'] });
    const result = await serviceRemoveEntry(deps(), target(), '/vault');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.type).toBe('forbidden');
      expect(result.err.message).toContain('/vault/secret');
    }
    expect(calls.removes).toEqual([]);
  });

  it('deletes a file after the gate, with the kind from its stat', async () => {
    const calls = arm(aclContext(), { '/old.txt': new Uint8Array([1]) });
    const result = await serviceRemoveEntry(deps(), target(), '/old.txt');
    expect(result.ok).toBe(true);
    expect(calls.removes).toEqual([{ path: '/old.txt', kind: 'file' }]);
  });

  it('preview refuses a non-empty folder without touching remove', async () => {
    const calls = arm(aclContext(), {
      '/full': [{ name: 'x', kind: 'file', size: 1, modifiedAt: null }],
    });
    const result = await servicePreviewRemove(deps(), target(), '/full');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('not_empty');
    expect(calls.removes).toEqual([]);
  });

  it('preview describes an empty folder and never removes it', async () => {
    const calls = arm(aclContext(), { '/empty': [] });
    const result = await servicePreviewRemove(deps(), target(), '/empty');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.kind).toBe('dir');
    expect(calls.removes).toEqual([]);
  });

  it('move requires read/write on the destination too', async () => {
    const ctx = aclContext({
      userRules: [{ path: '/readonly', access: 'read' }],
    });
    arm(ctx, { '/a.txt': new Uint8Array([1]) });
    const refused = await serviceMoveEntry(deps(), target(), '/a.txt', '/readonly');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.err.type).toBe('forbidden');
  });

  it('move keeps the name and reports the new path', async () => {
    const calls = arm(aclContext(), { '/a.txt': new Uint8Array([1]) });
    const result = await serviceMoveEntry(deps(), target(), '/a.txt', '/archive');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.path).toBe('/archive/a.txt');
      expect(result.val.unchanged).toBe(false);
    }
    expect(calls.renames).toEqual([{ from: '/a.txt', to: '/archive/a.txt' }]);
  });

  it('a move to where it already lives is unchanged, with no I/O', async () => {
    const calls = arm(aclContext(), {});
    const result = await serviceMoveEntry(deps(), target(), '/docs/a.txt', '/docs');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.unchanged).toBe(true);
    expect(calls.renames).toEqual([]);
  });

  it('rename validates the new name as a plain name', async () => {
    arm(aclContext(), {});
    const result = await serviceRenameEntry(deps(), target(), '/a.txt', 'x/y');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('bad_path');
  });

  it('rename stays in the source folder', async () => {
    const calls = arm(aclContext(), {});
    const result = await serviceRenameEntry(deps(), target(), '/docs/a.txt', 'b.txt');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.path).toBe('/docs/b.txt');
    expect(calls.renames).toEqual([{ from: '/docs/a.txt', to: '/docs/b.txt' }]);
  });

  it('the share root is not movable, renamable, or deletable', async () => {
    arm(aclContext(), {});
    for (const result of [
      await serviceMoveEntry(deps(), target(), '/', '/x'),
      await serviceRenameEntry(deps(), target(), '/', 'x'),
      await serviceRemoveEntry(deps(), target(), '/'),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.err.type).toBe('bad_path');
    }
  });
});

describe('admin search', () => {
  const TREE: Record<string, RawEntry[] | Uint8Array> = {
    '/': [
      { name: 'hr', kind: 'dir', size: null, modifiedAt: null },
      { name: 'it', kind: 'dir', size: null, modifiedAt: null },
      { name: 'welcome.txt', kind: 'file', size: 3, modifiedAt: null },
    ],
    '/hr': [{ name: 'contractors', kind: 'dir', size: null, modifiedAt: null }],
    '/hr/contractors': [],
    '/it': [{ name: 'Policies', kind: 'dir', size: null, modifiedAt: null }],
    '/it/Policies': [{ name: 'vpn.md', kind: 'file', size: 5, modifiedAt: null }],
  };

  function armSearch(tree: Record<string, RawEntry[] | Uint8Array>) {
    getShare.mockResolvedValue({ ok: true, val: { summary: aclContext().share } });
    readCredentialCiphertext.mockResolvedValue({
      ok: true,
      val: encryptCredentials({ protocol: 'sftp', username: 'svc', password: 'pw' }, KEY),
    });
    const { backend } = fakeBackend(tree);
    openBackend.mockResolvedValue({ ok: true, val: backend });
  }

  it('finds entries anywhere by case-folded path substring', async () => {
    armSearch(TREE);
    const byPath = await serviceAdminSearch(deps(), 'tenant-1', SHARE_ID, '/it/policies');
    expect(byPath.ok).toBe(true);
    if (byPath.ok) {
      // Descendants of a matching folder match too — their paths carry it.
      expect(byPath.val.results.map((hit) => hit.path)).toEqual([
        '/it/Policies',
        '/it/Policies/vpn.md',
      ]);
      expect(byPath.val.truncated).toBe(false);
    }

    const byName = await serviceAdminSearch(deps(), 'tenant-1', SHARE_ID, 'POLICIES');
    expect(byName.ok).toBe(true);
    if (byName.ok) {
      expect(byName.val.results.map((hit) => hit.path).sort()).toEqual([
        '/it/Policies',
        '/it/Policies/vpn.md',
      ]);
    }
  });

  it('skips an unreadable subtree instead of failing the search', async () => {
    const tree = { ...TREE };
    delete tree['/hr'];
    armSearch(tree);
    const result = await serviceAdminSearch(deps(), 'tenant-1', SHARE_ID, 'vpn');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.results.map((hit) => hit.path)).toEqual(['/it/Policies/vpn.md']);
  });

  it('answers no_share for a missing share and empty for an empty query', async () => {
    getShare.mockResolvedValue({ ok: true, val: null });
    const missing = await serviceAdminSearch(deps(), 'tenant-1', SHARE_ID, 'x');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.err.type).toBe('no_share');

    armSearch(TREE);
    const empty = await serviceAdminSearch(deps(), 'tenant-1', SHARE_ID, '   ');
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.val.results).toEqual([]);
  });
});
