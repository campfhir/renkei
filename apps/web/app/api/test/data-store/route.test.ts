/**
 * The test seed route's store calls: methods run in order on the memory
 * store with their Dates revived both ways, `at` sets the store's clock
 * for one call, and anything but a domain method is refused — all behind
 * the same 404 as the table-row path.
 */

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { decodeWire, encodeWire } from '@/lib/data-store-wire';
import { POST } from './route';

const TOKEN = 'route-test-seed-token';
const SUBJECT = 'seed-route@example.test';

function post(body: unknown, token = TOKEN): NextRequest {
  return new NextRequest('http://localhost/api/test/data-store', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-renkei-seed-token': token },
    body: JSON.stringify(body),
  });
}

function call(method: string, args: unknown[], at?: Date) {
  return { method, args: encodeWire(args), ...(at ? { at: at.toISOString() } : {}) };
}

async function resultsOf(response: Response): Promise<unknown[]> {
  const body: unknown = decodeWire(await response.json());
  if (typeof body !== 'object' || body === null || !('results' in body)) return [];
  return Array.isArray(body.results) ? body.results : [];
}

beforeEach(() => {
  process.env.RENKEI_MEMORY_SEED_TOKEN = TOKEN;
  registerDataStore(createMemoryDataStore());
});

afterEach(() => {
  delete process.env.RENKEI_MEMORY_SEED_TOKEN;
  resetDataStore();
});

describe('POST /api/test/data-store with calls', () => {
  it('runs each call in order and answers its result, Dates revived', async () => {
    const expiresAt = new Date('2031-02-03T04:05:06.000Z');
    const response = await POST(
      post({
        calls: [
          call('sessions.create', [
            {
              id: '5eed0000-0000-4000-8000-000000000001',
              subject: SUBJECT,
              roles: ['renkei-user'],
              expiresAt,
            },
          ]),
          call('sessions.find', ['5eed0000-0000-4000-8000-000000000001']),
        ],
      })
    );
    expect(response.status).toBe(200);
    const [created, found] = await resultsOf(response);
    expect(created).toBeUndefined();
    expect(found).toMatchObject({ subject: SUBJECT, expiresAt });
  });

  it('runs a call with `at` as of that moment', async () => {
    const at = new Date('2024-06-01T12:00:00.000Z');
    const id = '5eed0000-0000-4000-8000-000000000002';
    const response = await POST(
      post({
        calls: [
          call(
            'notifications.insert',
            [
              {
                id,
                subject: SUBJECT,
                kind: 'agent_run',
                category: null,
                connector: null,
                tool: null,
                entity: null,
                headline: 'Back then',
                refUrl: null,
                agentId: null,
                agentName: null,
                runId: null,
                meta: null,
              },
            ],
            at
          ),
          call('notifications.find', [SUBJECT, id]),
        ],
      })
    );
    const [, found] = await resultsOf(response);
    expect(found).toMatchObject({ headline: 'Back then', createdAt: at });
    // The clock is the real one again afterwards.
    expect(Math.abs(new Date().getTime() - Date.now())).toBeLessThan(1_000);
    expect(new Date().getFullYear()).toBeGreaterThan(2024);
  });

  it.each([
    ['an unknown domain', 'nope.find'],
    ['an unknown method', 'sessions.nope'],
    ['what is not a domain', 'tables.select'],
    ['a malformed name', 'sessions'],
  ])('refuses %s with a 400 before running anything', async (_label, method) => {
    const response = await POST(
      post({
        calls: [
          call('identities.upsert', [
            { subject: SUBJECT, email: SUBJECT, displayName: null, idpGroups: [] },
          ]),
          call(method, []),
        ],
      })
    );
    expect(response.status).toBe(400);
    const check = await POST(post({ calls: [call('identities.get', [SUBJECT])] }));
    expect(await resultsOf(check)).toEqual([null]);
  });

  it('answers 409 naming the call that rejected', async () => {
    const session = {
      id: '5eed0000-0000-4000-8000-000000000003',
      subject: SUBJECT,
      roles: [],
      expiresAt: new Date(),
    };
    const response = await POST(
      post({ calls: [call('sessions.create', [session]), call('sessions.create', [session])] })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ index: 1 });
  });

  it('is not there without the seed token', async () => {
    const response = await POST(post({ calls: [] }, 'wrong-token-wrong-token-'));
    expect(response.status).toBe(404);
  });
});
