/**
 * The Activity page's search (searchLogs), on the memory store: who sees
 * which lines. A person with no Jira grant is shown their own activity —
 * the lines the app wrote under their subject, such as a failed upload the
 * browser reported — rather than turned away, and nobody else's; an
 * operator sees the tenant. activity-logs.spec.ts checked the first half
 * through the page before; it keeps the browser's report of a failed
 * request end to end and the phone-width open
 * (app/api/logs/client/route.test.ts holds what that route accepts).
 */

jest.mock('@/lib/session', () => ({ getSessionFromCookies: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { searchLogs } from './actions';

const { getSessionFromCookies: mockSession } = jest.requireMock<{
  getSessionFromCookies: jest.Mock;
}>('@/lib/session');

let me: string;
let other: string;

async function logged(message: string, attrs: Record<string, string>): Promise<void> {
  const writer = getDataStore().activityLogs.writer({ level: 'info' });
  await writer.write({
    level: 'error',
    message,
    template: message,
    secureMessage: false,
    attrs,
    // A moment ago: a search without an end reads up to now, exclusive.
    timestamp: new Date(Date.now() - 1_000),
    application: 'renkei',
  });
}

const search = {
  expr: null,
  levels: [],
  start: null,
  end: null,
  sort: 'desc' as const,
};

beforeEach(async () => {
  registerDataStore(createMemoryDataStore());
  me = `me-${randomUUID()}`;
  other = `other-${randomUUID()}`;
  await logged('PUT /api/chat/attachments failed: object store unavailable', {
    component: 'client/fetch',
    subject: me,
  });
  await logged('someone else’s failure', { component: 'client/fetch', subject: other });
});

afterEach(() => {
  resetDataStore();
  jest.clearAllMocks();
});

describe('Activity', () => {
  it('a person without a Jira grant sees their own activity, not a refusal', async () => {
    mockSession.mockResolvedValue({ subject: me, roles: ['renkei-user'] });
    const result = await searchLogs(search);
    expect(result.error).toBeNull();
    expect(result.scope).toEqual({ role: 'renkei-user', accountId: null });
    expect(result.logs.map((row) => row.message)).toEqual([
      'PUT /api/chat/attachments failed: object store unavailable',
    ]);
  });

  it('a person cannot widen their search to someone else’s account', async () => {
    mockSession.mockResolvedValue({ subject: me, roles: ['renkei-user'] });
    const result = await searchLogs({ ...search, accountId: 'acct-of-someone-else' });
    expect(result.scope).toEqual({ role: 'renkei-user', accountId: null });
    expect(result.logs.map((row) => row.message)).not.toContain('someone else’s failure');
  });

  it('an operator sees the whole tenant', async () => {
    mockSession.mockResolvedValue({ subject: me, roles: ['renkei-user', 'renkei-operator'] });
    const result = await searchLogs(search);
    expect(result.error).toBeNull();
    expect(result.scope).toEqual({ role: 'renkei-operator', accountId: null });
    expect(result.logs.map((row) => row.message).sort()).toEqual(
      [
        'PUT /api/chat/attachments failed: object store unavailable',
        'someone else’s failure',
      ].sort()
    );
  });

  it('asks a signed-out caller to sign in', async () => {
    mockSession.mockResolvedValue(null);
    expect(await searchLogs(search)).toMatchObject({ logs: [], signedOut: true });
  });

  it('turns away a session with no role in the tenant', async () => {
    mockSession.mockResolvedValue({ subject: me, roles: [] });
    expect(await searchLogs(search)).toMatchObject({
      logs: [],
      error: 'Your account has no role in this tenant',
    });
  });
});
