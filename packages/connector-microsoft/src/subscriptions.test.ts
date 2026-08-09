/**
 * The subscription lifecycle's golden request shapes: create POSTs the full
 * registration with a computed expiration, renew PATCHes only the
 * expiration, and delete treats "already gone" (404) as success — Graph
 * reaps expired subscriptions itself.
 */

import {
  GRAPH_SUBSCRIPTION_MINUTES,
  createGraphSubscription,
  renewGraphSubscription,
  deleteGraphSubscription,
  listGraphSubscriptions,
} from './subscriptions';
import { GRAPH_BASE_URL } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createGraphSubscription', () => {
  it('POSTs the registration and returns id + expiry', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, {
        id: 'sub-1',
        expirationDateTime: '2026-08-12T00:00:00Z',
      })
    );

    const result = await createGraphSubscription('token-1', {
      resource: "/me/mailFolders('inbox')/messages",
      changeType: 'created,updated',
      notificationUrl: 'https://renkei.example.com/hooks/graph',
      lifecycleNotificationUrl: 'https://renkei.example.com/hooks/graph-lifecycle',
      clientState: 'state-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.id).toBe('sub-1');
      expect(result.val.expiresAt.toISOString()).toBe('2026-08-12T00:00:00.000Z');
    }

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${GRAPH_BASE_URL}/subscriptions`);
    expect(init?.method).toBe('POST');
    const payload = JSON.parse(String(init?.body));
    expect(payload.resource).toBe("/me/mailFolders('inbox')/messages");
    expect(payload.changeType).toBe('created,updated');
    expect(payload.notificationUrl).toBe('https://renkei.example.com/hooks/graph');
    expect(payload.lifecycleNotificationUrl).toBe(
      'https://renkei.example.com/hooks/graph-lifecycle'
    );
    expect(payload.clientState).toBe('state-1');
    // Default lifetime lands within a minute of GRAPH_SUBSCRIPTION_MINUTES out.
    const expiration = new Date(payload.expirationDateTime).getTime();
    const expected = Date.now() + GRAPH_SUBSCRIPTION_MINUTES * 60 * 1000;
    expect(Math.abs(expiration - expected)).toBeLessThan(60 * 1000);
  });

  it('fails when the response is missing id or expiry', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(201, { id: 'sub-1' }));

    const result = await createGraphSubscription('token-1', {
      resource: 'r',
      changeType: 'created',
      notificationUrl: 'https://n.example.com',
      lifecycleNotificationUrl: 'https://l.example.com',
      clientState: 's',
    });

    expect(result.ok).toBe(false);
  });
});

describe('renewGraphSubscription', () => {
  it('PATCHes only a new expiration and returns the granted one', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { expirationDateTime: '2026-08-15T00:00:00Z' }));

    const result = await renewGraphSubscription('token-1', 'sub-1', 120);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.expiresAt.toISOString()).toBe('2026-08-15T00:00:00.000Z');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${GRAPH_BASE_URL}/subscriptions/sub-1`);
    expect(init?.method).toBe('PATCH');
    const payload = JSON.parse(String(init?.body));
    expect(Object.keys(payload)).toEqual(['expirationDateTime']);
    const expiration = new Date(payload.expirationDateTime).getTime();
    expect(Math.abs(expiration - (Date.now() + 120 * 60 * 1000))).toBeLessThan(60 * 1000);
  });
});

describe('deleteGraphSubscription', () => {
  it('DELETEs and succeeds on 204', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await deleteGraphSubscription('token-1', 'sub-1');

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${GRAPH_BASE_URL}/subscriptions/sub-1`);
    expect(init?.method).toBe('DELETE');
  });

  it('treats a 404 as already deleted', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(404, { error: { code: 'ResourceNotFound' } }));

    const result = await deleteGraphSubscription('token-1', 'sub-gone');

    expect(result.ok).toBe(true);
  });

  it('still fails on other errors', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(500, {}));

    const result = await deleteGraphSubscription('token-1', 'sub-1');

    expect(result.ok).toBe(false);
  });
});

describe('listGraphSubscriptions', () => {
  it('returns the value[] rows it can read', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        value: [
          {
            id: 'sub-1',
            resource: 'r-1',
            expirationDateTime: '2026-08-12T00:00:00Z',
            clientState: 'state-1',
          },
          { id: 'sub-2', resource: 'r-2', expirationDateTime: '2026-08-13T00:00:00Z' },
          { notAnId: true },
        ],
      })
    );

    const result = await listGraphSubscriptions('token-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val).toEqual([
        {
          id: 'sub-1',
          resource: 'r-1',
          expirationDateTime: '2026-08-12T00:00:00Z',
          clientState: 'state-1',
        },
        { id: 'sub-2', resource: 'r-2', expirationDateTime: '2026-08-13T00:00:00Z' },
      ]);
    }
  });

  it('fails when value[] is missing', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}));

    expect((await listGraphSubscriptions('token-1')).ok).toBe(false);
  });
});
