/**
 * The webhook receipt's contract: the per-tenant secret comes from the
 * connector_configs store (never the environment), the signature is verified
 * over the raw body before anything else is trusted, malformed deliveries
 * are refused, and a valid delivery does exactly one thing — produce one
 * message onto the webhook events queue. No processing here.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/queue', () => ({
  webhookEventsQueue: () => ({
    producer: {
      enqueue: (message: Record<string, unknown>) => mockEnqueueImpl(message),
    },
  }),
}));
jest.mock('@renkei/connector-config', () => ({ readConnectorConfigCached: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { createHmac, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from './route';

let mockEnqueueImpl: (message: Record<string, unknown>) => Promise<{ ok: boolean }>;

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { readConnectorConfigCached: mockReadConfig } = jest.requireMock<{
  readConnectorConfigCached: jest.Mock;
}>('@renkei/connector-config');

const TENANT = '00000000-0000-4000-8000-000000000001';
const SECRET = 'webhook-secret';

interface Recorded {
  enqueued: Array<Record<string, unknown>>;
}

function stubDb(tenantExists = true): Recorded {
  const recorded: Recorded = { enqueued: [] };
  const selectChain = {
    select: () => selectChain,
    where: () => selectChain,
    executeTakeFirst: async () => (tenantExists ? { id: TENANT } : undefined),
  };
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: { selectFrom: () => selectChain },
  });
  mockEnqueueImpl = async (message) => {
    recorded.enqueued.push(message);
    return { ok: true };
  };
  return recorded;
}

function connectorConfigured(
  over: Partial<{ enabled: boolean; secrets: Record<string, string> }> | null = {}
): void {
  mockReadConfig.mockResolvedValue({
    ok: true,
    val:
      over === null
        ? null
        : {
            connector: 'webex',
            enabled: over.enabled ?? true,
            settings: {},
            secrets: over.secrets ?? { webhookSecret: SECRET, botToken: 'bot-token' },
          },
  });
}

function delivery(body: string, signature: string | null): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (signature !== null) headers.set('X-Spark-Signature', signature);
  return new NextRequest(`http://localhost/api/webhooks/webex/${TENANT}`, {
    method: 'POST',
    headers,
    body,
  });
}

function params() {
  return { params: Promise.resolve({ tenantId: TENANT }) };
}

function sign(body: string): string {
  return createHmac('sha1', SECRET).update(body, 'utf8').digest('hex');
}

const VALID_BODY = JSON.stringify({
  resource: 'messages',
  event: 'created',
  data: { id: 'msg-1', roomId: 'room-1', personEmail: 'sam@example.com' },
});

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  mockGetDatabase.mockReset();
  mockReadConfig.mockReset();
});

describe('POST /api/webhooks/webex/[tenantId]', () => {
  it('accepts a delivery signed with the tenant’s stored secret', async () => {
    const recorded = stubDb();
    connectorConfigured();

    const response = await POST(delivery(VALID_BODY, sign(VALID_BODY)), params());

    expect(response.status).toBe(200);
    expect(recorded.enqueued).toHaveLength(1);
    const message = recorded.enqueued[0]!;
    expect(message.tenantId).toBe(TENANT);
    expect(message.source).toBe('webex');
    expect(message.type).toBe('messages.created');
    // One room's messages share an ordering key, so several interactive
    // workers still process a conversation in order.
    expect(message.orderingKey).toBe(`webex/${TENANT}/room-1`);
  });

  it('rejects a bad signature with 401 and inserts nothing', async () => {
    const recorded = stubDb();
    connectorConfigured();

    const response = await POST(delivery(VALID_BODY, 'not-the-signature'), params());

    expect(response.status).toBe(401);
    expect(recorded.enqueued).toHaveLength(0);
  });

  it('rejects a missing signature', async () => {
    stubDb();
    connectorConfigured();
    const response = await POST(delivery(VALID_BODY, null), params());
    expect(response.status).toBe(401);
  });

  it('rejects a signed but malformed payload with 400', async () => {
    stubDb();
    connectorConfigured();
    const body = JSON.stringify({ resource: 'messages' });
    const response = await POST(delivery(body, sign(body)), params());
    expect(response.status).toBe(400);
  });

  it('answers 503 when the connector is not configured for the tenant', async () => {
    stubDb();
    connectorConfigured(null);
    const response = await POST(delivery(VALID_BODY, sign(VALID_BODY)), params());
    expect(response.status).toBe(503);
  });

  it('answers 503 when the connector is disabled', async () => {
    stubDb();
    connectorConfigured({ enabled: false });
    const response = await POST(delivery(VALID_BODY, sign(VALID_BODY)), params());
    expect(response.status).toBe(503);
  });

  it('answers 404 for an unknown tenant', async () => {
    stubDb(false);
    connectorConfigured();
    const response = await POST(delivery(VALID_BODY, sign(VALID_BODY)), params());
    expect(response.status).toBe(404);
  });

  it('answers 500 when the deployment encryption key is absent', async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    stubDb();
    connectorConfigured();
    const response = await POST(delivery(VALID_BODY, sign(VALID_BODY)), params());
    expect(response.status).toBe(500);
  });
});
