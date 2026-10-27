/**
 * Browser-session resolution: the idle timeout (org setting
 * `sessionIdleTimeoutMinutes`) ends a session that has gone unused, inside
 * the absolute 30-day lifetime, and a settings outage falls back to the
 * default rather than to "never".
 */

jest.mock('@renkei/settings', () => ({
  getOrgSettings: jest.fn(),
  DEFAULT_ORG_SETTINGS: { sessionIdleTimeoutMinutes: 720 },
}));
jest.mock('next/headers', () => ({ cookies: jest.fn() }));

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { getSessionById } from './session';

const { getOrgSettings: mockGetOrgSettings } = jest.requireMock<{ getOrgSettings: jest.Mock }>(
  '@renkei/settings'
);
const HOUR = 60 * 60 * 1000;

interface SessionFixture {
  id: string;
  subject: string;
  roles: string[];
  expiresAt: Date;
  lastUsedAt: Date;
}

/** A memory data store holding this one session, recording what was deleted and touched. */
async function stubStore(row: SessionFixture) {
  const deleted: string[] = [];
  const touched: Date[] = [];
  const store = createMemoryDataStore();
  await store.sessions.create(row);
  await store.sessions.touch(row.id, row.lastUsedAt);
  registerDataStore({
    ...store,
    sessions: {
      ...store.sessions,
      delete: (id) => {
        deleted.push(id);
        return store.sessions.delete(id);
      },
      touch: (id, at) => {
        touched.push(at);
        return store.sessions.touch(id, at);
      },
    },
  });
  return { deleted, touched };
}

function sessionRow(lastUsedAgoMs: number): SessionFixture {
  return {
    id: 'sess-1',
    subject: 'alice@example.com',
    roles: ['renkei-user'],
    expiresAt: new Date(Date.now() + 29 * 24 * HOUR),
    lastUsedAt: new Date(Date.now() - lastUsedAgoMs),
  };
}

afterAll(() => {
  resetDataStore();
});

describe('getSessionById idle timeout', () => {
  beforeEach(() => {
    mockGetOrgSettings.mockReset();
    mockGetOrgSettings.mockResolvedValue({ ok: true, val: { sessionIdleTimeoutMinutes: 720 } });
  });

  it('resolves a session used within the idle window and touches last_used_at', async () => {
    const { deleted, touched } = await stubStore(sessionRow(2 * HOUR));
    const session = await getSessionById('sess-1');
    expect(session?.subject).toBe('alice@example.com');
    expect(deleted).toEqual([]);
    expect(touched).toHaveLength(1);
    expect(touched[0]).toBeInstanceOf(Date);
  });

  it('ends a session idle past the org timeout even though its absolute lifetime remains', async () => {
    const { deleted, touched } = await stubStore(sessionRow(13 * HOUR));
    const session = await getSessionById('sess-1');
    expect(session).toBeNull();
    expect(deleted).toEqual(['sess-1']);
    expect(touched).toEqual([]);
  });

  it('honours a shorter org timeout', async () => {
    mockGetOrgSettings.mockResolvedValue({ ok: true, val: { sessionIdleTimeoutMinutes: 30 } });
    const { deleted } = await stubStore(sessionRow(HOUR));
    expect(await getSessionById('sess-1')).toBeNull();
    expect(deleted).toEqual(['sess-1']);
  });

  it('falls back to the default timeout when settings cannot be read', async () => {
    mockGetOrgSettings.mockResolvedValue({ ok: false, err: 'DB_ERROR' });
    await stubStore(sessionRow(2 * HOUR));
    expect(await getSessionById('sess-1')).not.toBeNull();
    const { deleted } = await stubStore(sessionRow(13 * HOUR));
    expect(await getSessionById('sess-1')).toBeNull();
    expect(deleted).toEqual(['sess-1']);
  });

  it('still ends a session past its absolute expiry regardless of use', async () => {
    const { deleted } = await stubStore({
      ...sessionRow(0),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await getSessionById('sess-1')).toBeNull();
    expect(deleted).toEqual(['sess-1']);
  });
});
