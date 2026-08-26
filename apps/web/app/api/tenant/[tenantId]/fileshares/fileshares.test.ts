/**
 * The file-share REST routes as thin proxies onto the fileshare worker.
 * ACL enforcement itself is pinned in the package's service.test.ts (the
 * worker's authority); what these tests pin is the seam: session-gated
 * entry, faithful forwarding of the caller's subject and paths, and the
 * worker-error → HTTP mapping that keeps this surface answering exactly
 * like the MCP tools — an ungranted share still 404s like a missing one.
 */

jest.mock('@/lib/session', () => ({
  getSessionFromRequest: jest.fn(async () => ({ subject: 'auth0|alice' })),
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@renkei/settings', () => ({
  getOrgSettings: async () => ({ ok: true, val: { maxAttachmentBytes: 1024 } }),
}));
jest.mock('@renkei/connector-fileshares', () => {
  const actual = jest.requireActual<typeof import('@renkei/connector-fileshares')>(
    '@renkei/connector-fileshares'
  );
  return {
    ...actual,
    listGrantedShares: jest.fn(),
  };
});
jest.mock('@/lib/file-shares/service-client', () => {
  const actual = jest.requireActual<typeof import('@/lib/file-shares/service-client')>(
    '@/lib/file-shares/service-client'
  );
  return {
    ...actual,
    fsListFolder: jest.fn(),
    fsReadFile: jest.fn(),
    fsWriteFile: jest.fn(),
    fsMakeFolder: jest.fn(),
    fsRemoveEntry: jest.fn(),
    fsMoveEntry: jest.fn(),
    fsRenameEntry: jest.fn(),
  };
});

import { NextRequest } from 'next/server';
import { GET as listShares } from './route';
import { GET as listFolder } from './[shareId]/folder/route';
import { GET as downloadFile, PUT as uploadFile } from './[shareId]/file/route';
import { POST as createFolder } from './[shareId]/folders/route';
import { DELETE as deleteEntry, POST as mutateEntry } from './[shareId]/entries/route';

const { getSessionFromRequest } = jest.requireMock<{ getSessionFromRequest: jest.Mock }>(
  '@/lib/session'
);
const { listGrantedShares } = jest.requireMock<{ listGrantedShares: jest.Mock }>(
  '@renkei/connector-fileshares'
);
const client = jest.requireMock<{
  fsListFolder: jest.Mock;
  fsReadFile: jest.Mock;
  fsWriteFile: jest.Mock;
  fsMakeFolder: jest.Mock;
  fsRemoveEntry: jest.Mock;
  fsMoveEntry: jest.Mock;
  fsRenameEntry: jest.Mock;
}>('@/lib/file-shares/service-client');

const SHARE_ID = '11111111-2222-3333-4444-555555555555';
const SHARE = { id: SHARE_ID, name: 'Accounting' };
const TARGET = { tenantId: 'tenant-1', shareId: SHARE_ID, subject: 'auth0|alice' };
const paramsOf = () => Promise.resolve({ tenantId: 'tenant-1' });
const shareParamsOf = (shareId: string) => Promise.resolve({ tenantId: 'tenant-1', shareId });

function reqOf(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(url, init));
}

function opError(type: string, message: string | undefined, status: number) {
  return { ok: false as const, err: { kind: 'op' as const, type, message, status } };
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
  expect(client.fsListFolder).not.toHaveBeenCalled();
  expect(client.fsReadFile).not.toHaveBeenCalled();
});

test('the share list is the grants list, verbatim (store-side, no worker)', async () => {
  listGrantedShares.mockResolvedValue({
    ok: true,
    val: [
      {
        share: {
          id: SHARE_ID,
          name: 'Accounting',
          protocol: 'sftp',
          host: 'nas.example.test',
          shareName: null,
          hasCredentials: true,
        },
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

test("an ungranted share answers the worker's 404, indistinguishable from a missing one", async () => {
  client.fsListFolder.mockResolvedValue(opError('no_share', undefined, 404));
  const response = await listFolder(reqOf('http://x/api?path=/'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(404);
  expect((await response.json()).error).toBe('Not found');
});

test('folder listings forward the session subject and pass wire entries through', async () => {
  client.fsListFolder.mockResolvedValue({
    ok: true,
    val: {
      share: SHARE,
      path: '/',
      access: 'read',
      entries: [
        {
          name: 'open.txt',
          path: '/open.txt',
          kind: 'file',
          size: 5,
          modifiedAt: null,
          access: 'read',
        },
      ],
    },
  });
  const response = await listFolder(reqOf('http://x/api?path=/'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(client.fsListFolder).toHaveBeenCalledWith(TARGET, '/');
  expect(body.access).toBe('read');
  expect(body.entries).toEqual([
    { name: 'open.txt', path: '/open.txt', kind: 'file', size: 5, modifiedAt: null, access: 'read' },
  ]);
});

test("a worker path complaint is the route's 400", async () => {
  client.fsListFolder.mockResolvedValue(
    opError('bad_path', 'That path climbs out of the share.', 400)
  );
  const response = await listFolder(reqOf('http://x/api?path=/a/../../etc'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(400);
});

test('an unconfigured worker is a 503, never an open fallback', async () => {
  client.fsListFolder.mockResolvedValue({ ok: false, err: { kind: 'unconfigured' as const } });
  const response = await listFolder(reqOf('http://x/api?path=/'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(503);
});

test("download relays the worker's refusal and streams its bytes", async () => {
  client.fsReadFile.mockResolvedValue(
    opError('forbidden', 'You do not have access to that file.', 403)
  );
  const refused = await downloadFile(reqOf('http://x/api?path=/closed/file.txt'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(refused.status).toBe(403);

  client.fsReadFile.mockResolvedValue({ ok: true, val: new TextEncoder().encode('bytes!') });
  const response = await downloadFile(reqOf('http://x/api?path=/report.pdf'), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toContain('report.pdf');
  expect(await response.text()).toBe('bytes!');
  expect(client.fsReadFile).toHaveBeenCalledWith(TARGET, '/report.pdf');
});

test('PUT refuses bodies over the org attachment limit before any worker call', async () => {
  const response = await uploadFile(
    reqOf('http://x/api?path=/new.txt', { method: 'PUT', body: 'x'.repeat(2048) }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(response.status).toBe(413);
  expect(client.fsWriteFile).not.toHaveBeenCalled();
});

test('PUT forwards the exact bytes and destination to the worker', async () => {
  client.fsWriteFile.mockResolvedValue({ ok: true, val: { path: '/new.txt' } });
  const response = await uploadFile(
    reqOf('http://x/api?path=/new.txt', { method: 'PUT', body: 'data' }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(response.status).toBe(200);
  const [target, path, bytes] = client.fsWriteFile.mock.calls[0];
  expect(target).toEqual(TARGET);
  expect(path).toBe('/new.txt');
  expect(new TextDecoder().decode(bytes)).toBe('data');
});

test("PUT surfaces the worker's read/write refusal as 403", async () => {
  client.fsWriteFile.mockResolvedValue(
    opError('forbidden', 'You do not have read/write access at that destination.', 403)
  );
  const response = await uploadFile(
    reqOf('http://x/api?path=/new.txt', { method: 'PUT', body: 'data' }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(response.status).toBe(403);
});

test('folder creation forwards to the worker and relays parent refusals', async () => {
  client.fsMakeFolder.mockResolvedValue(
    opError('forbidden', 'You do not have read/write access in the parent folder.', 403)
  );
  const refused = await createFolder(
    reqOf('http://x/api', { method: 'POST', body: JSON.stringify({ path: '/reports/new' }) }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(refused.status).toBe(403);

  client.fsMakeFolder.mockResolvedValue({ ok: true, val: { share: SHARE, path: '/drafts/new' } });
  const allowed = await createFolder(
    reqOf('http://x/api', { method: 'POST', body: JSON.stringify({ path: '/drafts/new' }) }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(allowed.status).toBe(200);
  expect(client.fsMakeFolder).toHaveBeenCalledWith(TARGET, '/drafts/new');
});

test("entry deletion relays the worker's gate refusals with their reasons", async () => {
  client.fsRemoveEntry.mockResolvedValue(
    opError(
      'forbidden',
      'Access rules are anchored at or under that path (/old.txt), so it cannot be deleted — ' +
        'an administrator must remove those rules first.',
      403
    )
  );
  const anchored = await deleteEntry(reqOf('http://x/api?path=/old.txt', { method: 'DELETE' }), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(anchored.status).toBe(403);
  expect(String((await anchored.json()).error)).toContain('administrator');
});

test('a non-empty folder answers 409, and a clean delete succeeds', async () => {
  client.fsRemoveEntry.mockResolvedValue(opError('not_empty', undefined, 409));
  const notEmpty = await deleteEntry(reqOf('http://x/api?path=/stuff', { method: 'DELETE' }), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(notEmpty.status).toBe(409);

  client.fsRemoveEntry.mockResolvedValue({ ok: true, val: { share: SHARE, path: '/stuff' } });
  const emptied = await deleteEntry(reqOf('http://x/api?path=/stuff', { method: 'DELETE' }), {
    params: shareParamsOf(SHARE_ID),
  });
  expect(emptied.status).toBe(200);
  expect(client.fsRemoveEntry).toHaveBeenCalledWith(TARGET, '/stuff');
});

test('move forwards both ends; clobber and destination refusals keep their statuses', async () => {
  client.fsMoveEntry.mockResolvedValue(
    opError('forbidden', 'You do not have read/write access at the destination.', 403)
  );
  const refused = await mutateEntry(
    reqOf('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ op: 'move', from: '/a.txt', toFolder: '/readonly' }),
    }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(refused.status).toBe(403);

  client.fsMoveEntry.mockResolvedValue(
    opError('exists', 'Something already exists at the destination.', 409)
  );
  const clobber = await mutateEntry(
    reqOf('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ op: 'move', from: '/a.txt', toFolder: '/archive' }),
    }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(clobber.status).toBe(409);
  expect(client.fsMoveEntry).toHaveBeenCalledWith(TARGET, '/a.txt', '/archive');
});

test('rename forwards the new name; a worker name complaint is a 400', async () => {
  client.fsRenameEntry.mockResolvedValue(
    opError('bad_path', 'The new name must be a plain name with no path separators.', 400)
  );
  const traversal = await mutateEntry(
    reqOf('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ op: 'rename', from: '/docs/a.txt', newName: '../up.txt' }),
    }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(traversal.status).toBe(400);

  client.fsRenameEntry.mockResolvedValue({
    ok: true,
    val: { share: SHARE, path: '/docs/b.txt', unchanged: false },
  });
  const renamed = await mutateEntry(
    reqOf('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ op: 'rename', from: '/docs/a.txt', newName: 'b.txt' }),
    }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(renamed.status).toBe(200);
  expect((await renamed.json()).path).toBe('/docs/b.txt');
  expect(client.fsRenameEntry).toHaveBeenCalledWith(TARGET, '/docs/a.txt', 'b.txt');
});

test('an unknown entry op is a 400 without a worker call', async () => {
  const response = await mutateEntry(
    reqOf('http://x/api', { method: 'POST', body: JSON.stringify({ op: 'copy', from: '/a' }) }),
    { params: shareParamsOf(SHARE_ID) }
  );
  expect(response.status).toBe(400);
  expect(client.fsMoveEntry).not.toHaveBeenCalled();
  expect(client.fsRenameEntry).not.toHaveBeenCalled();
});
