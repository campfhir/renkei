/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The file-share REST routes, against a stubbed backend and a REAL ACL
 * engine — what these pin is enforcement equivalence with the MCP tools:
 * the same context that hides an entry from fileshare_list_folder must
 * hide it here, an ungranted share must 404 exactly like a nonexistent
 * one, and a PUT to a read-only path must never reach the backend.
 */

jest.mock('@/lib/session', () => ({
  getSessionFromRequest: jest.fn(async () => ({ subject: 'auth0|alice' })),
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@renkei/crypto', () => ({
  parseEncryptionKey: () => ({ ok: true, val: Buffer.alloc(32) }),
}));
jest.mock('@renkei/settings', () => ({
  getOrgSettings: async () => ({ ok: true, val: { maxAttachmentBytes: 1024 } }),
}));
jest.mock('@renkei/connector-fileshares', () => {
  const actual = jest.requireActual<typeof import('@renkei/connector-fileshares')>(
    '@renkei/connector-fileshares'
  );
  return {
    ...actual,
    getAclContext: jest.fn(),
    listGrantedShares: jest.fn(),
    readCredentialCiphertext: jest.fn(async () => ({ ok: true, val: 'sealed' })),
    decryptCredentials: jest.fn(() => ({
      ok: true,
      val: { protocol: 'sftp', username: 'svc', password: 'pw' },
    })),
    openBackend: jest.fn(),
    withSessionLimits: (_shareId: string, _lane: string, work: () => Promise<unknown>) => work(),
  };
});

import { NextRequest } from 'next/server';
import { GET as listShares } from './route';
import { GET as listFolder } from './[shareId]/folder/route';
import { GET as downloadFile, PUT as uploadFile } from './[shareId]/file/route';
import { POST as createFolder } from './[shareId]/folders/route';

const { getSessionFromRequest } = jest.requireMock<{ getSessionFromRequest: jest.Mock }>(
  '@/lib/session'
);
const { getAclContext, listGrantedShares, openBackend } = jest.requireMock<{
  getAclContext: jest.Mock;
  listGrantedShares: jest.Mock;
  openBackend: jest.Mock;
}>('@renkei/connector-fileshares');

const SHARE_ID = '11111111-2222-3333-4444-555555555555';
const paramsOf = () => Promise.resolve({ tenantId: 'tenant-1' });
const shareParamsOf = (shareId: string) => Promise.resolve({ tenantId: 'tenant-1', shareId });

function aclContext(defaultAccess: 'none' | 'read' | 'read_write', userRules: unknown[] = []) {
  return {
    share: {
      id: SHARE_ID,
      name: 'Accounting',
      protocol: 'sftp',
      host: 'nas.example.test',
      port: null,
      shareName: null,
      rootPath: '/srv',
      caseInsensitive: false,
      maxAccess: 'read_write',
      enabled: true,
      hasCredentials: true,
    },
    grant: { subject: 'auth0|alice', defaultAccess },
    shareRules: [],
    userRules,
  };
}

function reqOf(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(url, init));
}

beforeEach(() => {
  jest.clearAllMocks();
  getSessionFromRequest.mockResolvedValue({ subject: 'auth0|alice' });
});

test('every route answers a signed-out request with 401', async () => {
  getSessionFromRequest.mockResolvedValue(null);
  const listing = await listShares(reqOf('http://x/api'), { params: paramsOf() });
  expect(listing.status).toBe(401);
  const folder = await listFolder(reqOf('http://x/api?path=/'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(folder.status).toBe(401);
  const file = await downloadFile(reqOf('http://x/api?path=/a'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(file.status).toBe(401);
});

test('an ungranted share answers 404, indistinguishable from a missing one', async () => {
  getAclContext.mockResolvedValue({ ok: true, val: null });
  const response = await listFolder(reqOf('http://x/api?path=/'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(404);
});

test('the share list is the grants list, verbatim', async () => {
  listGrantedShares.mockResolvedValue({
    ok: true,
    val: [
      {
        share: aclContext('read').share,
        grant: { subject: 'auth0|alice', defaultAccess: 'read' },
        hasRules: true,
      },
    ],
  });
  const response = await listShares(reqOf('http://x/api'), { params: paramsOf() });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.shares).toHaveLength(1);
  expect(body.shares[0]).toMatchObject({ id: SHARE_ID, defaultAccess: 'read', hasRules: true });
});

test('folder listings run the same annotate-and-filter pass as the tools', async () => {
  getAclContext.mockResolvedValue({
    ok: true,
    val: aclContext('read', [{ path: '/secret.txt', access: 'none' }]),
  });
  openBackend.mockResolvedValue({
    ok: true,
    val: {
      list: async () => ({
        ok: true,
        val: [
          { name: 'open.txt', kind: 'file', size: 5, modifiedAt: null },
          { name: 'secret.txt', kind: 'file', size: 5, modifiedAt: null },
        ],
      }),
      close: async () => undefined,
    },
  });
  const response = await listFolder(reqOf('http://x/api?path=/'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries.map((entry: { name: string }) => entry.name)).toEqual(['open.txt']);
  expect(body.entries[0].access).toBe('read');
});

test('a traversal query string is a 400, not a resolution', async () => {
  getAclContext.mockResolvedValue({ ok: true, val: aclContext('read') });
  const response = await listFolder(reqOf('http://x/api?path=/a/../../etc'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(400);
  expect(openBackend).not.toHaveBeenCalled();
});

test('download refuses a closed path with 403 before any backend call', async () => {
  getAclContext.mockResolvedValue({
    ok: true,
    val: aclContext('read', [{ path: '/closed', access: 'none' }]),
  });
  const response = await downloadFile(reqOf('http://x/api?path=/closed/file.txt'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(403);
  expect(openBackend).not.toHaveBeenCalled();
});

test('download streams bytes with an attachment disposition', async () => {
  getAclContext.mockResolvedValue({ ok: true, val: aclContext('read') });
  openBackend.mockResolvedValue({
    ok: true,
    val: {
      read: async () => ({ ok: true, val: new TextEncoder().encode('bytes!') }),
      close: async () => undefined,
    },
  });
  const response = await downloadFile(reqOf('http://x/api?path=/report.pdf'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toContain('report.pdf');
  expect(await response.text()).toBe('bytes!');
});

test('PUT requires read_write on the exact destination', async () => {
  getAclContext.mockResolvedValue({ ok: true, val: aclContext('read') });
  const response = await uploadFile(
    reqOf('http://x/api?path=/new.txt', { method: 'PUT', body: 'data' }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(response.status).toBe(403);
  expect(openBackend).not.toHaveBeenCalled();
});

test('PUT refuses bodies over the org attachment limit with 413', async () => {
  getAclContext.mockResolvedValue({ ok: true, val: aclContext('read_write') });
  const response = await uploadFile(
    reqOf('http://x/api?path=/new.txt', { method: 'PUT', body: 'x'.repeat(2048) }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(response.status).toBe(413);
  expect(openBackend).not.toHaveBeenCalled();
});

test('folder creation authorizes on the parent', async () => {
  getAclContext.mockResolvedValue({
    ok: true,
    val: aclContext('read', [{ path: '/drafts', access: 'read_write' }]),
  });
  const mkdir = jest.fn(async () => ({ ok: true, val: undefined }));
  openBackend.mockResolvedValue({ ok: true, val: { mkdir, close: async () => undefined } });

  const refused = await createFolder(
    reqOf('http://x/api', { method: 'POST', body: JSON.stringify({ path: '/reports/new' }) }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(refused.status).toBe(403);

  const allowed = await createFolder(
    reqOf('http://x/api', { method: 'POST', body: JSON.stringify({ path: '/drafts/new' }) }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(allowed.status).toBe(200);
  expect(mkdir).toHaveBeenCalledWith('/drafts/new');
});
