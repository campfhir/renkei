/**
 * The webhook receipt's contract: signature verified over the raw body
 * before anything else, malformed deliveries refused, and a valid delivery
 * does exactly one thing — INSERT an event row. No processing here.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

const TENANT = '00000000-0000-4000-8000-000000000001';
const SECRET = 'webhook-secret';

interface Recorded {
  inserted: Array<Record<string, unknown>>;
}

function stubDb(tenantExists = true): Recorded {
  const recorded: Recorded = { inserted: [] };
  const selectChain = {
    select: () => selectChain,
    where: () => selectChain,
    executeTakeFirst: async () => (tenantExists ? { id: TENANT } : undefined),
  };
  const insertChain = (values: Record<string, unknown>) => ({
    execute: async () => {
      recorded.inserted.push(values);
      return [];
    },
  });
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: () => selectChain,
      insertInto: () => ({ values: insertChain }),
    },
  });
  return recorded;
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
  process.env.WEBEX_WEBHOOK_SECRET = SECRET;
  mockGetDatabase.mockReset();
});

describe('POST /api/webhooks/webex/[tenantId]', () => {
  it('accepts a signed delivery by inserting exactly one event row', async () => {
    const recorded = stubDb();

    const response = await POST(delivery(VALID_BODY, sign(VALID_BODY)), params());

    expect(response.status).toBe(200);
    expect(recorded.inserted).toHaveLength(1);
    const row = recorded.inserted[0]!;
    expect(row.tenant_id).toBe(TENANT);
    expect(row.source).toBe('webex');
    expect(row.type).toBe('messages.created');
  });

  it('rejects a bad signature with 401 and inserts nothing', async () => {
    const recorded = stubDb();

    const response = await POST(delivery(VALID_BODY, 'not-the-signature'), params());

    expect(response.status).toBe(401);
    expect(recorded.inserted).toHaveLength(0);
  });

  it('rejects a missing signature', async () => {
    stubDb();
    const response = await POST(delivery(VALID_BODY, null), params());
    expect(response.status).toBe(401);
  });

  it('rejects a signed but malformed payload with 400', async () => {
    stubDb();
    const body = JSON.stringify({ resource: 'messages' });
    const response = await POST(delivery(body, sign(body)), params());
    expect(response.status).toBe(400);
  });

  it('answers 503 when the connector is not configured', async () => {
    delete process.env.WEBEX_WEBHOOK_SECRET;
    stubDb();
    const response = await POST(delivery(VALID_BODY, sign(VALID_BODY)), params());
    expect(response.status).toBe(503);
  });

  it('answers 404 for an unknown tenant', async () => {
    stubDb(false);
    const response = await POST(delivery(VALID_BODY, sign(VALID_BODY)), params());
    expect(response.status).toBe(404);
  });
});
