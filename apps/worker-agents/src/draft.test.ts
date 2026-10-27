/**
 * The draft job's contract with the web app.
 *
 * Two things matter here and neither is the happy path. The token must name
 * the subject from the DRAFT ROW, never from the job payload — the subject
 * decides whose tool catalog the draft is built against, so a payload that
 * could name one would be a payload that could borrow one. And a draft that
 * no longer exists must be dropped rather than retried forever.
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createDraftHandler } from './draft';

jest.mock('./token', () => ({
  mintRunToken: jest.fn(async () => 'minted-token'),
  revokeRunToken: jest.fn(async () => undefined),
}));

const { mintRunToken, revokeRunToken } = jest.requireMock<{
  mintRunToken: jest.Mock;
  revokeRunToken: jest.Mock;
}>('./token');

const DRAFT = '00000000-0000-4000-8000-0000000000d1';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const GONE = '00000000-0000-4000-8000-0000000000d9';

/** A memory store holding one draft of `owner`'s. */
async function seedDraft(owner: string): Promise<void> {
  const store = createMemoryDataStore();
  registerDataStore(store);
  await store.seed({
    agents: [{ id: AGENT, owner_subject: owner, name: 'Agent' }],
    agent_drafts: [
      { id: DRAFT, owner_subject: owner, agent_id: null, request: JSON.stringify({}) },
    ],
  });
}

describe('the draft job', () => {
  beforeEach(async () => {
    mintRunToken.mockClear();
    revokeRunToken.mockClear();
    await seedDraft('owner@example.com');
  });

  afterEach(() => {
    resetDataStore();
  });

  it('mints a token for the draft OWNER, not for anything in the payload', async () => {
    await seedDraft('real-owner@example.com');
    const calls: { url: string; init: { method: string; body: string } }[] = [];
    const handler = createDraftHandler({
      webBaseUrl: 'http://web:3000',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      },
    });

    await handler({
      // A payload naming somebody else must change nothing.
      payload: { draftId: DRAFT, ownerSubject: 'attacker@example.com' },
    });

    expect(mintRunToken).toHaveBeenCalledTimes(1);
    expect(mintRunToken.mock.calls[0][0]).toMatchObject({
      subject: 'real-owner@example.com',
      // Drafting acts as the person; there is usually no agent yet.
      agentId: null,
    });
    expect(calls[0].url).toBe(`http://web:3000/api/agents/draft/${DRAFT}/run`);
  });

  it('revokes the token even when the call fails', async () => {
    const handler = createDraftHandler({
      webBaseUrl: 'http://web:3000',
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });

    // Thrown so the queue retries — a token left valid for twenty minutes
    // after a failure is a credential nobody is tracking.
    await expect(handler({ payload: { draftId: DRAFT } })).rejects.toThrow('HTTP 500');
    expect(revokeRunToken).toHaveBeenCalledTimes(1);
  });

  it('drops the job when the draft is gone', async () => {
    const handler = createDraftHandler({
      webBaseUrl: 'http://web:3000',
      fetchImpl: async () => {
        throw new Error('should not be called');
      },
    });

    expect(await handler({ payload: { draftId: GONE } })).toBe('skipped');
    expect(mintRunToken).not.toHaveBeenCalled();
  });

  it('refuses a payload with no draft id', async () => {
    const handler = createDraftHandler({
      webBaseUrl: 'http://web:3000',
    });

    await expect(handler({ payload: {} })).rejects.toThrow('missing draftId');
  });
});
