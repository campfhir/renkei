/**
 * The draft job's contract with the web app.
 *
 * Two things matter here and neither is the happy path. The token must name
 * the subject from the DRAFT ROW, never from the job payload — the subject
 * decides whose tool catalog the draft is built against, so a payload that
 * could name one would be a payload that could borrow one. And a draft that
 * no longer exists must be dropped rather than retried forever.
 */

import { createDraftHandler } from './draft';

jest.mock('./token', () => ({
  mintRunToken: jest.fn(async () => 'minted-token'),
  revokeRunToken: jest.fn(async () => undefined),
}));

const { mintRunToken, revokeRunToken } = jest.requireMock<{
  mintRunToken: jest.Mock;
  revokeRunToken: jest.Mock;
}>('./token');

/** A Kysely stand-in returning one agent_drafts row, or none. */
function stubDb(row: { owner_subject: string; agent_id: string | null } | undefined) {
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () => row,
  };
  // The handler touches exactly one query shape; anything else is a bug in
  // the handler rather than a gap in this stub.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { selectFrom: () => chain } as unknown as Parameters<typeof createDraftHandler>[0]['db'];
}

describe('the draft job', () => {
  beforeEach(() => {
    mintRunToken.mockClear();
    revokeRunToken.mockClear();
  });

  it('mints a token for the draft OWNER, not for anything in the payload', async () => {
    const calls: { url: string; init: { method: string; body: string } }[] = [];
    const handler = createDraftHandler({
      db: stubDb({ owner_subject: 'real-owner@example.com', agent_id: null }),
      webBaseUrl: 'http://web:3000',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      },
    });

    await handler({
      tenant_id: 'tenant-1',
      // A payload naming somebody else must change nothing.
      payload: { draftId: 'draft-1', ownerSubject: 'attacker@example.com' },
    });

    expect(mintRunToken).toHaveBeenCalledTimes(1);
    expect(mintRunToken.mock.calls[0][1]).toMatchObject({
      tenantId: 'tenant-1',
      subject: 'real-owner@example.com',
      // Drafting acts as the person; there is usually no agent yet.
      agentId: null,
    });
    expect(calls[0].url).toBe('http://web:3000/api/tenant/tenant-1/agents/draft/draft-1/run');
  });

  it('revokes the token even when the call fails', async () => {
    const handler = createDraftHandler({
      db: stubDb({ owner_subject: 'owner@example.com', agent_id: null }),
      webBaseUrl: 'http://web:3000',
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });

    // Thrown so the queue retries — a token left valid for twenty minutes
    // after a failure is a credential nobody is tracking.
    await expect(handler({ tenant_id: 't', payload: { draftId: 'd' } })).rejects.toThrow(
      'HTTP 500'
    );
    expect(revokeRunToken).toHaveBeenCalledTimes(1);
  });

  it('drops the job when the draft is gone', async () => {
    const handler = createDraftHandler({
      db: stubDb(undefined),
      webBaseUrl: 'http://web:3000',
      fetchImpl: async () => {
        throw new Error('should not be called');
      },
    });

    expect(await handler({ tenant_id: 't', payload: { draftId: 'gone' } })).toBe('skipped');
    expect(mintRunToken).not.toHaveBeenCalled();
  });

  it('refuses a payload with no draft id', async () => {
    const handler = createDraftHandler({
      db: stubDb({ owner_subject: 'owner@example.com', agent_id: null }),
      webBaseUrl: 'http://web:3000',
    });

    await expect(handler({ tenant_id: 't', payload: {} })).rejects.toThrow('missing draftId');
  });
});
