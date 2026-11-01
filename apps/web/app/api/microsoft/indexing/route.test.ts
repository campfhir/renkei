/**
 * The Outlook background opt-in (GET/PUT /api/microsoft/indexing), on the
 * memory store: what outlook-indexing.spec.ts read back through the route
 * with two polls before — Mail on and off is what the grant then says, a
 * `calendar` or `tasks` flag is dropped (nothing in Outlook is indexed or
 * watched any more), and the save wakes the same bootstrap a fresh
 * connect runs. The section's own rules are
 * outlook-indexing-prefs.model.test.ts.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/queue', () => {
  const enqueue = jest.fn();
  return { webhookEventsQueue: () => ({ producer: { enqueue } }), enqueue };
});

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET, PUT } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { enqueue: mockEnqueue } = jest.requireMock<{ enqueue: jest.Mock }>('@renkei/queue');

const ME = 'mail-person@example.com';
const ACCOUNT = 'ms-account-1';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
  mockEnqueue.mockResolvedValue({ ok: true, val: undefined });
});

afterEach(() => resetDataStore());

/** A Microsoft connect's write, as the callback stores it. */
async function connect(metadata: Record<string, unknown> = {}): Promise<void> {
  await getDataStore().providerGrants.upsertSealed('microsoft', {
    accountId: ACCOUNT,
    clientId: 'e2e-microsoft-client',
    displayName: 'Mail Person',
    subject: ME,
    encryptedAccessToken: 'v1.a.b.c',
    encryptedRefreshToken: 'v1.a.b.c',
    keepStoredRefreshToken: false,
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    requestedScopes: ['Mail.Read'],
    grantedScopes: ['Mail.Read'],
    metadata,
  });
}

const put = (body: unknown) =>
  PUT(
    new NextRequest('http://test.local/api/microsoft/indexing', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );

async function saved(): Promise<unknown> {
  const response = await GET(new NextRequest('http://test.local/api/microsoft/indexing'));
  expect(response.status).toBe(200);
  return (await response.json()).indexing;
}

describe('GET/PUT /api/microsoft/indexing', () => {
  it('a fresh connection has Mail off', async () => {
    await connect();
    expect(await saved()).toEqual({ mail: false });
  });

  it('Mail on is what the grant says next, and the bootstrap is woken', async () => {
    await connect();

    const response = await put({ mail: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ indexing: { mail: true } });
    expect(await saved()).toEqual({ mail: true });
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'microsoft',
        type: 'grant.connected',
        payload: { accountId: ACCOUNT, subject: ME },
      })
    );
  });

  it('Mail off again is saved for real', async () => {
    await connect();
    await put({ mail: true });
    await put({ mail: false });
    expect(await saved()).toEqual({ mail: false });
  });

  it('drops a calendar or tasks flag: neither is indexed nor watched', async () => {
    await connect();
    const response = await put({ mail: true, calendar: true, tasks: true });
    expect(await response.json()).toEqual({ indexing: { mail: true } });
    expect(await saved()).toEqual({ mail: true });
  });

  it('anything but true is off', async () => {
    await connect();
    await put({ mail: 'yes' });
    expect(await saved()).toEqual({ mail: false });
  });

  it('keeps the rest of the grant’s metadata', async () => {
    await connect({ tenantId: 'tenant-1' });
    await put({ mail: true });
    const grant = await getDataStore().providerGrants.find('microsoft', ACCOUNT);
    expect(grant?.metadata).toEqual(
      expect.objectContaining({ tenantId: 'tenant-1', indexing: { mail: true } })
    );
  });

  it('a save stands even when the bootstrap could not be queued', async () => {
    await connect();
    mockEnqueue.mockResolvedValue({ ok: false, err: { type: 'DB_ERROR' } });
    expect((await put({ mail: true })).status).toBe(200);
    expect(await saved()).toEqual({ mail: true });
  });

  it('answers 404 without a Microsoft connection, and 401 without a session', async () => {
    expect((await put({ mail: true })).status).toBe(404);
    expect((await GET(new NextRequest('http://test.local/x'))).status).toBe(404);
    mockGetSession.mockResolvedValue(null);
    expect((await put({ mail: true })).status).toBe(401);
  });
});
