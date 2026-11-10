/**
 * The file-share registry's routes, on the memory store, for the SFTP
 * host-key pin (docs/fileshares-connector-design.md, "Host keys"): a
 * pasted fingerprint is stored normalized and read back as the key on
 * file; clearing it returns the share to trust-on-first-use; a malformed
 * one is refused. These were file-shares.spec.ts's reads of what the
 * forms saved; the forms' rules are
 * app/(app)/admin/file-shares/**\/*.model.test.ts.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET as list, POST as create } from '../route';
import { DELETE, GET, PATCH } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);

/** A well-formed SHA256 host-key fingerprint, as `ssh-keygen -lf` prints one. */
const FINGERPRINT = 'SHA256:zgO0mL4RkHlb6yVSZS1Bz0Ys7gs0Ia0ZLyTRpFH9bXw';

const request = (method: string, body?: unknown) =>
  new NextRequest('http://test.local/api/admin/file-shares', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const params = (shareId: string) => ({ params: Promise.resolve({ shareId }) });

/** What the create form sends for an SFTP share (share-config-fields.model.ts's draftPayload). */
const sftp = (hostKeyFingerprint: string) => ({
  name: 'Reports SFTP',
  protocol: 'sftp',
  host: 'files.corp.example',
  port: null,
  rootPath: '/srv/reports',
  caseInsensitive: false,
  enabled: true,
  hostKeyFingerprint,
});

async function created(body: Record<string, unknown>): Promise<string> {
  const response = await create(request('POST', body));
  expect(response.status).toBe(201);
  return (await response.json()).id;
}

async function read(shareId: string): Promise<Record<string, unknown>> {
  const response = await GET(request('GET'), params(shareId));
  expect(response.status).toBe(200);
  return (await response.json()).share;
}

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockCheckAccess.mockResolvedValue({ subject: 'operator', roles: ['renkei-operator'] });
});

afterEach(() => resetDataStore());

describe('an SFTP share’s host key', () => {
  it('a pasted fingerprint is stored normalized and read back as the key on file', async () => {
    const id = await created(sftp(`${FINGERPRINT.slice('SHA256:'.length)}=`));
    expect(await read(id)).toMatchObject({ protocol: 'sftp', hostKeyFingerprint: FINGERPRINT });
  });

  it('clearing it returns the share to trust-on-first-use', async () => {
    const id = await created(sftp(FINGERPRINT));
    const saved = await PATCH(request('PATCH', sftp('')), params(id));
    expect(saved.status).toBe(200);
    expect((await read(id)).hostKeyFingerprint ?? null).toBeNull();
  });

  it('a malformed fingerprint is refused, and nothing is stored', async () => {
    const response = await create(request('POST', sftp('MD5:aa:bb:cc')));
    expect(response.status).toBe(400);
    expect((await (await list(request('GET'))).json()).shares).toEqual([]);
  });
});

describe('the registry', () => {
  it('deletes a share, and then it is gone', async () => {
    const id = await created(sftp(''));
    expect((await DELETE(request('DELETE'), params(id))).status).toBe(200);
    expect((await GET(request('GET'), params(id))).status).toBe(404);
  });

  it('is an operator’s', async () => {
    mockCheckAccess.mockResolvedValue(null);
    expect((await create(request('POST', sftp('')))).status).toBe(401);
  });
});
