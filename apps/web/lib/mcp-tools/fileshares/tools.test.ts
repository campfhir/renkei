/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The fileshare tools' contract, driven through real registration with a
 * fake backend and a fake auth: the ACL engine runs for real (that is the
 * point — these tests pin enforcement, not formatting), while the protocol
 * session is an in-memory tree.
 */

jest.mock('@renkei/connector-fileshares', () => {
  const actual = jest.requireActual<typeof import('@renkei/connector-fileshares')>(
    '@renkei/connector-fileshares'
  );
  return {
    ...actual,
    openBackend: jest.fn(),
    withSessionLimits: (_shareId: string, _lane: string, work: () => Promise<unknown>) => work(),
  };
});
jest.mock('../upload-slots', () => ({
  createUploadSlot: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import type { AclContext, RawEntry, ShareBackend } from '@renkei/connector-fileshares';
import { registerFileshareTools } from './index';
import type { FileshareAuth } from './fileshare-auth';
import type { MCPToolContext } from '../common';

const { openBackend } = jest.requireMock<{ openBackend: jest.Mock }>(
  '@renkei/connector-fileshares'
);
const { createUploadSlot } = jest.requireMock<{ createUploadSlot: jest.Mock }>('../upload-slots');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const SHARE_ID = '11111111-2222-3333-4444-555555555555';

function contextOf(): MCPToolContext {
  return {
    tenantId: 'tenant-1',
    subject: 'auth0|alice',
    origin: 'https://renkei.example.test',
    maxAttachmentBytes: 1024 * 1024,
  } as unknown as MCPToolContext;
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
    grant: { subject: 'auth0|alice', defaultAccess: 'read' },
    shareRules: [],
    userRules: [],
    ...overrides,
  };
}

function authOf(ctx: AclContext): FileshareAuth {
  return {
    kind: 'user',
    async listGranted() {
      return [{ share: ctx.share, grant: ctx.grant, hasRules: ctx.userRules.length > 0 }];
    },
    async resolve(shareId: string) {
      if (shareId !== ctx.share.id) return 'No file share with that id is available to you.';
      return { ctx, credentials: { protocol: 'sftp', username: 'svc', password: 'pw' } };
    },
  };
}

/** An in-memory backend over a flat path → entry map. */
function fakeBackend(tree: Map<string, RawEntry & { content?: string }>): ShareBackend & {
  writes: Array<{ path: string; bytes: Uint8Array }>;
  mkdirs: string[];
} {
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const mkdirs: string[] = [];
  return {
    writes,
    mkdirs,
    async list(path) {
      const prefix = path === '/' ? '/' : `${path}/`;
      const entries: RawEntry[] = [];
      for (const [entryPath, entry] of tree) {
        if (!entryPath.startsWith(prefix)) continue;
        if (entryPath.slice(prefix.length).includes('/')) continue;
        entries.push(entry);
      }
      return { ok: true, val: entries };
    },
    async stat(path) {
      const entry = tree.get(path);
      if (!entry) return { ok: false, val: undefined, err: { type: 'not_found' } };
      return { ok: true, val: entry };
    },
    async read(path, maxBytes) {
      const entry = tree.get(path);
      if (!entry || entry.content === undefined) {
        return { ok: false, val: undefined, err: { type: 'not_found' } };
      }
      const bytes = new TextEncoder().encode(entry.content);
      if (bytes.byteLength > maxBytes) {
        return { ok: false, val: undefined, err: { type: 'too_large' } };
      }
      return { ok: true, val: bytes };
    },
    async write(path, bytes) {
      writes.push({ path, bytes });
      return { ok: true, val: undefined };
    },
    async mkdir(path) {
      mkdirs.push(path);
      return { ok: true, val: undefined };
    },
    async close() {},
  } as ShareBackend & { writes: Array<{ path: string; bytes: Uint8Array }>; mkdirs: string[] };
}

function register(ctx: AclContext): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerFileshareTools(server, contextOf(), authOf(ctx));
  return handlers;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

beforeEach(() => {
  jest.clearAllMocks();
});

test('list_shares reports name, id and access level', async () => {
  const handlers = register(aclContext());
  const result = await handlers.get('fileshare_list_shares')!({});
  expect(result.isError).toBeUndefined();
  expect(textOf(result)).toContain('Accounting');
  expect(textOf(result)).toContain(SHARE_ID);
  expect(textOf(result)).toContain('your access: read');
});

test('list_folder hides denied entries, marks corridors, stamps levels', async () => {
  const ctx = aclContext({
    grant: { subject: 'auth0|alice', defaultAccess: 'read' },
    userRules: [
      { path: '/secret.txt', access: 'none' },
      { path: '/vault', access: 'none' },
      { path: '/vault/open', access: 'read' },
      { path: '/drafts', access: 'read_write' },
    ],
  });
  const backend = fakeBackend(
    new Map([
      ['/notes.txt', { name: 'notes.txt', kind: 'file', size: 5, modifiedAt: null }],
      ['/secret.txt', { name: 'secret.txt', kind: 'file', size: 5, modifiedAt: null }],
      ['/vault', { name: 'vault', kind: 'dir', size: null, modifiedAt: null }],
      ['/drafts', { name: 'drafts', kind: 'dir', size: null, modifiedAt: null }],
    ])
  );
  openBackend.mockResolvedValue({ ok: true, val: backend });

  const handlers = register(ctx);
  const result = await handlers.get('fileshare_list_folder')!({ shareId: SHARE_ID, path: '/' });
  const text = textOf(result);
  expect(result.isError).toBeUndefined();
  expect(text).toContain('/notes.txt [read]');
  expect(text).not.toContain('secret.txt');
  expect(text).toContain('/vault/ [folders below]');
  expect(text).toContain('/drafts/ [read/write]');
});

test('a traversal path is refused with a reason, never resolved', async () => {
  const handlers = register(aclContext());
  const result = await handlers.get('fileshare_list_folder')!({
    shareId: SHARE_ID,
    path: '/reports/../../etc',
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('climbs out of the share');
  expect(openBackend).not.toHaveBeenCalled();
});

test('an unknown share id and an ungranted share read identically', async () => {
  const handlers = register(aclContext());
  const result = await handlers.get('fileshare_list_folder')!({
    shareId: '99999999-9999-9999-9999-999999999999',
    path: '/',
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('No file share with that id is available to you');
});

test('read_file refuses paths the ACL closes without touching the backend', async () => {
  const ctx = aclContext({ userRules: [{ path: '/closed', access: 'none' }] });
  const handlers = register(ctx);
  const result = await handlers.get('fileshare_read_file')!({
    shareId: SHARE_ID,
    path: '/closed/file.txt',
  });
  expect(result.isError).toBe(true);
  expect(openBackend).not.toHaveBeenCalled();
});

test('read_file returns text for an allowed plain file', async () => {
  const backend = fakeBackend(
    new Map([
      [
        '/notes.txt',
        { name: 'notes.txt', kind: 'file', size: 12, modifiedAt: null, content: 'hello world' },
      ],
    ])
  );
  openBackend.mockResolvedValue({ ok: true, val: backend });
  const handlers = register(aclContext());
  const result = await handlers.get('fileshare_read_file')!({
    shareId: SHARE_ID,
    path: '/notes.txt',
  });
  expect(result.isError).toBeUndefined();
  expect(textOf(result)).toContain('hello world');
});

test('request_file_upload requires read_write at the destination', async () => {
  const handlers = register(aclContext()); // default access: read
  const result = await handlers.get('fileshare_request_file_upload')!({
    shareId: SHARE_ID,
    path: '/reports',
    filename: 'q4.xlsx',
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('read/write');
  expect(createUploadSlot).not.toHaveBeenCalled();
});

test('request_file_upload mints a slot with the share destination', async () => {
  createUploadSlot.mockResolvedValue({ ok: true, uploadId: 'slot-1', instructions: 'POST here' });
  const ctx = aclContext({ grant: { subject: 'auth0|alice', defaultAccess: 'read_write' } });
  const handlers = register(ctx);
  const result = await handlers.get('fileshare_request_file_upload')!({
    shareId: SHARE_ID,
    path: '/reports',
    filename: 'q4.xlsx',
  });
  expect(result.isError).toBeUndefined();
  expect(createUploadSlot).toHaveBeenCalledWith(
    expect.anything(),
    'fileshare-file',
    { shareId: SHARE_ID, path: '/reports' },
    expect.objectContaining({ filename: 'q4.xlsx' })
  );
});

test('request_file_upload refuses filenames carrying separators', async () => {
  const ctx = aclContext({ grant: { subject: 'auth0|alice', defaultAccess: 'read_write' } });
  const handlers = register(ctx);
  const result = await handlers.get('fileshare_request_file_upload')!({
    shareId: SHARE_ID,
    path: '/reports',
    filename: '../../evil.sh',
  });
  expect(result.isError).toBe(true);
  expect(createUploadSlot).not.toHaveBeenCalled();
});

test('create_folder requires read_write on the parent', async () => {
  const ctx = aclContext({
    grant: { subject: 'auth0|alice', defaultAccess: 'read' },
    userRules: [{ path: '/drafts', access: 'read_write' }],
  });
  const backend = fakeBackend(new Map());
  openBackend.mockResolvedValue({ ok: true, val: backend });
  const handlers = register(ctx);

  const refused = await handlers.get('fileshare_create_folder')!({
    shareId: SHARE_ID,
    path: '/reports/new',
  });
  expect(refused.isError).toBe(true);

  const allowed = await handlers.get('fileshare_create_folder')!({
    shareId: SHARE_ID,
    path: '/drafts/new',
  });
  expect(allowed.isError).toBeUndefined();
  expect(backend.mkdirs).toEqual(['/drafts/new']);
});

test('download_file hands out the session-guarded REST link', async () => {
  const backend = fakeBackend(
    new Map([['/report.pdf', { name: 'report.pdf', kind: 'file', size: 9, modifiedAt: null }]])
  );
  openBackend.mockResolvedValue({ ok: true, val: backend });
  const handlers = register(aclContext());
  const result = await handlers.get('fileshare_download_file')!({
    shareId: SHARE_ID,
    path: '/report.pdf',
  });
  expect(result.isError).toBeUndefined();
  expect(textOf(result)).toContain(
    `https://renkei.example.test/api/tenant/tenant-1/fileshares/${SHARE_ID}/file?path=%2Freport.pdf`
  );
});
