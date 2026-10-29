/**
 * The browser suite's sign-in: a fresh identity and session on the memory
 * store, the cookie set — and a 404 for anything else.
 */

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { POST } from './route';

const TOKEN = 'route-test-seed-token';

function post(body: unknown, token = TOKEN): NextRequest {
  return new NextRequest('http://localhost/api/test/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-renkei-seed-token': token },
    body: JSON.stringify(body),
  });
}

async function signedIn(response: Response): Promise<{ subject: string; sessionId: string }> {
  const body: unknown = await response.json();
  const subject = typeof body === 'object' && body !== null ? Reflect.get(body, 'subject') : null;
  const sessionId =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'sessionId') : null;
  if (typeof subject !== 'string' || typeof sessionId !== 'string') throw new Error('no session');
  return { subject, sessionId };
}

beforeEach(() => {
  process.env.RENKEI_MEMORY_SEED_TOKEN = TOKEN;
  registerDataStore(createMemoryDataStore());
});

afterEach(() => {
  delete process.env.RENKEI_MEMORY_SEED_TOKEN;
  resetDataStore();
});

describe('POST /api/test/session', () => {
  it('creates an identity and a session with the asked roles, and sets the cookie', async () => {
    const response = await POST(
      post({ roles: ['renkei-user', 'renkei-operator'], displayName: 'Ada Tester' })
    );
    expect(response.status).toBe(200);
    const { subject, sessionId } = await signedIn(response);
    expect(response.headers.get('set-cookie')).toContain(`renkei_session=${sessionId}`);

    const identity = await getDataStore().identities.get(subject);
    expect(identity).toMatchObject({ email: subject, displayName: 'Ada Tester' });
    const session = await getDataStore().sessions.find(sessionId);
    expect(session).toMatchObject({ subject, roles: ['renkei-user', 'renkei-operator'] });
  });

  it('gives every call a subject of its own', async () => {
    const first = await signedIn(await POST(post({})));
    const second = await signedIn(await POST(post({})));
    expect(first.subject).not.toBe(second.subject);
  });

  it('is a 404 with the wrong token', async () => {
    expect((await POST(post({}, 'wrong-token'))).status).toBe(404);
  });

  it('is a 404 without a seed token configured', async () => {
    delete process.env.RENKEI_MEMORY_SEED_TOKEN;
    expect((await POST(post({}, ''))).status).toBe(404);
  });

  it('is a 404 when the process is not on the memory store', async () => {
    registerDataStore({ ...createMemoryDataStore(), kind: 'postgres' });
    expect((await POST(post({}))).status).toBe(404);
  });
});
