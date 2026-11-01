/**
 * DELETE /api/zoom/grant — what the Zoom card's "Yes, disconnect" sends.
 * Whose grant goes is the session's, never a parameter; the meetings
 * indexed from that host go with it; a delegate that cannot delete answers
 * the refusal the card shows. On the memory store, the delegate and the
 * knowledge purge stubbed at their clients. (The control's confirm / keep
 * states are disconnect-control.model.test.ts's.)
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));
jest.mock('@renkei/delegate-client', () => ({ delegateGrants: jest.fn() }));
jest.mock('@renkei/knowledge', () => ({ deleteObjectChunks: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { DELETE } from './route';

const { getSessionFromRequest: mockSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { delegateGrants } = jest.requireMock<{ delegateGrants: jest.Mock }>(
  '@renkei/delegate-client'
);
const { deleteObjectChunks } = jest.requireMock<{ deleteObjectChunks: jest.Mock }>(
  '@renkei/knowledge'
);
const { invalidateToolCatalogCache } = jest.requireMock<{
  invalidateToolCatalogCache: jest.Mock;
}>('@/lib/mcp-tools/tool-catalog');

const ME = 'zoom-host@example.com';
const SOMEONE_ELSE = 'other-host@example.com';
const revoke = jest.fn();

/** A Zoom connect's write, as the callback stores it. */
async function connect(subject: string, accountId: string): Promise<void> {
  await getDataStore().providerGrants.upsertSealed('zoom', {
    accountId,
    clientId: 'zoom-client',
    displayName: subject,
    subject,
    encryptedAccessToken: 'v1.a.b.c',
    encryptedRefreshToken: 'v1.a.b.c',
    keepStoredRefreshToken: false,
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    requestedScopes: ['meeting:read:meeting'],
    grantedScopes: ['meeting:read:meeting'],
    metadata: { email: subject.toUpperCase() },
  });
}

const disconnect = () =>
  DELETE(new NextRequest('http://test.local/api/zoom/grant', { method: 'DELETE' }));

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
  revoke.mockResolvedValue({ ok: true, val: { revokedAtProvider: true } });
  delegateGrants.mockReturnValue({ revoke });
  deleteObjectChunks.mockResolvedValue({ ok: true, val: 0 });
});

afterEach(() => resetDataStore());

describe('DELETE /api/zoom/grant', () => {
  it('refuses someone not signed in', async () => {
    mockSession.mockResolvedValue(null);
    expect((await disconnect()).status).toBe(401);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes the caller's own grant and purges the meetings indexed from that host", async () => {
    await connect(ME, 'acct-me');
    await connect(SOMEONE_ELSE, 'acct-other');

    const response = await disconnect();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Zoom disconnected' });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith({ provider: 'zoom', accountId: 'acct-me' });
    expect(deleteObjectChunks).toHaveBeenCalledWith('zoom', `${ME}/`, { prefixOnly: true });
    expect(invalidateToolCatalogCache).toHaveBeenCalledWith(ME);
  });

  it('with nothing connected there is nothing to disconnect, and nobody else is touched', async () => {
    await connect(SOMEONE_ELSE, 'acct-other');
    const response = await disconnect();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Nothing to disconnect' });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('a delegate that cannot delete the grant answers the refusal the card shows', async () => {
    await connect(ME, 'acct-me');
    revoke.mockResolvedValue({ ok: false, err: { type: 'UNAVAILABLE' } });
    const response = await disconnect();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Could not disconnect' });
  });

  it('a revocation Zoom itself refuses still disconnects', async () => {
    await connect(ME, 'acct-me');
    revoke.mockResolvedValue({ ok: true, val: { revokedAtProvider: false } });
    expect((await disconnect()).status).toBe(200);
  });
});
