/**
 * Operator sign-out-everywhere: operator-only, never on oneself, and it
 * removes the person's sessions AND both MCP token tables.
 */

jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { POST } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { recordAuditEvent: mockAudit } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const TARGET = 'bob@example.com';
const OTHER = 'ann@example.com';
const EXPIRES = new Date('2030-01-01T00:00:00.000Z');

/** Two of everything for the target, one of everything for someone else. */
async function seededStore(): Promise<MemoryDataStore> {
  const store = createMemoryDataStore();
  const sid = (n: number) => `00000000-0000-4000-8000-00000000050${n}`;
  const rid = (n: number) => `00000000-0000-4000-8000-00000000060${n}`;
  await store.seed({
    sessions: [
      { id: sid(1), subject: TARGET, expires_at: EXPIRES },
      { id: sid(2), subject: TARGET, expires_at: EXPIRES },
      { id: sid(3), subject: OTHER, expires_at: EXPIRES },
    ],
    oauth_clients: [{ client_id: 'c', client_secret_hash: 'h', redirect_uris: ['https://x'] }],
    oauth_access_tokens: [
      { token_hash: 'a1', client_id: 'c', subject: TARGET, expires_at: EXPIRES },
      { token_hash: 'a2', client_id: 'c', subject: TARGET, expires_at: EXPIRES },
      { token_hash: 'a3', client_id: 'c', subject: OTHER, expires_at: EXPIRES },
    ],
    oauth_refresh_tokens: [
      { token_hash: 'r1', token_id: rid(1), client_id: 'c', subject: TARGET, expires_at: EXPIRES },
      { token_hash: 'r2', token_id: rid(2), client_id: 'c', subject: TARGET, expires_at: EXPIRES },
      { token_hash: 'r3', token_id: rid(3), client_id: 'c', subject: OTHER, expires_at: EXPIRES },
    ],
  });
  registerDataStore(store);
  return store;
}

function request(subject = TARGET) {
  return {
    request: new NextRequest(
      `http://localhost/api/admin/acme/access/${encodeURIComponent(subject)}/revoke-sessions`,
      { method: 'POST' }
    ),
    context: { params: Promise.resolve({ subject: encodeURIComponent(subject) }) },
  };
}

const subjects = (store: MemoryDataStore) => ({
  sessions: store.tables.select('sessions').map((r) => r.subject),
  accessTokens: store.tables.select('oauth_access_tokens').map((r) => r.subject),
  refreshTokens: store.tables.select('oauth_refresh_tokens').map((r) => r.subject),
});

describe('POST /api/admin/access/{subject}/revoke-sessions', () => {
  beforeEach(() => {
    mockCheckAccess.mockReset();
    mockAudit.mockReset();
  });
  afterAll(() => {
    resetDataStore();
  });

  it('refuses a caller who is not an operator before touching anything', async () => {
    const store = await seededStore();
    mockCheckAccess.mockResolvedValue(null);
    const { request: req, context } = request();
    const response = await POST(req, context);
    expect(response.status).toBe(401);
    expect(subjects(store).sessions).toHaveLength(3);
  });

  it("deletes the person's sessions, access tokens and refresh tokens, and audits it", async () => {
    const store = await seededStore();
    mockCheckAccess.mockResolvedValue({ subject: 'op@example.com', roles: ['renkei-operator'] });
    const { request: req, context } = request();

    const response = await POST(req, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      revoked: { sessions: 2, accessTokens: 2, refreshTokens: 2 },
    });
    expect(subjects(store)).toEqual({
      sessions: [OTHER],
      accessTokens: [OTHER],
      refreshTokens: [OTHER],
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubject: 'op@example.com',
        action: 'user.sessions_revoked',
        targetLabel: TARGET,
      })
    );
  });

  it('will not sign the operator themselves out from here', async () => {
    const store = await seededStore();
    mockCheckAccess.mockResolvedValue({ subject: TARGET, roles: ['renkei-operator'] });
    const { request: req, context } = request(TARGET);
    const response = await POST(req, context);
    expect(response.status).toBe(400);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(subjects(store).sessions).toHaveLength(3);
  });
});
