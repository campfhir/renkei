/**
 * Browser-session resolution: the idle timeout (org setting
 * `sessionIdleTimeoutMinutes`) ends a session that has gone unused, inside
 * the absolute 30-day lifetime, and a settings outage falls back to the
 * default rather than to "never".
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/settings', () => ({
  getOrgSettings: jest.fn(),
  DEFAULT_ORG_SETTINGS: { sessionIdleTimeoutMinutes: 720 },
}));
jest.mock('next/headers', () => ({ cookies: jest.fn() }));

import { getSessionById } from './session';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getOrgSettings: mockGetOrgSettings } = jest.requireMock<{ getOrgSettings: jest.Mock }>(
  '@renkei/settings'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const HOUR = 60 * 60 * 1000;

function stubDb(row: Record<string, unknown> | undefined) {
  const deleted: string[] = [];
  const touched: Array<Record<string, unknown>> = [];
  const db = {
    selectFrom() {
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => row,
      };
      return chain;
    },
    deleteFrom() {
      return {
        where(_c: string, _o: string, id: string) {
          deleted.push(id);
          return { execute: async () => undefined };
        },
      };
    },
    updateTable() {
      const chain = {
        set(values: Record<string, unknown>) {
          touched.push(values);
          return chain;
        },
        where: () => chain,
        execute: async () => undefined,
      };
      return chain;
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return { deleted, touched };
}

function sessionRow(lastUsedAgoMs: number) {
  return {
    id: 'sess-1',
    subject: 'alice@example.com',
    roles: ['renkei-user'],
    expires_at: new Date(Date.now() + 29 * 24 * HOUR),
    last_used_at: new Date(Date.now() - lastUsedAgoMs),
  };
}

describe('getSessionById idle timeout', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetOrgSettings.mockReset();
    mockGetOrgSettings.mockResolvedValue({ ok: true, val: { sessionIdleTimeoutMinutes: 720 } });
  });

  it('resolves a session used within the idle window and touches last_used_at', async () => {
    const { deleted, touched } = stubDb(sessionRow(2 * HOUR));
    const session = await getSessionById('sess-1');
    expect(session?.subject).toBe('alice@example.com');
    expect(deleted).toEqual([]);
    expect(touched).toHaveLength(1);
    expect(touched[0].last_used_at).toBeInstanceOf(Date);
  });

  it('ends a session idle past the org timeout even though its absolute lifetime remains', async () => {
    const { deleted, touched } = stubDb(sessionRow(13 * HOUR));
    const session = await getSessionById('sess-1');
    expect(session).toBeNull();
    expect(deleted).toEqual(['sess-1']);
    expect(touched).toEqual([]);
  });

  it('honours a shorter org timeout', async () => {
    mockGetOrgSettings.mockResolvedValue({ ok: true, val: { sessionIdleTimeoutMinutes: 30 } });
    const { deleted } = stubDb(sessionRow(HOUR));
    expect(await getSessionById('sess-1')).toBeNull();
    expect(deleted).toEqual(['sess-1']);
  });

  it('falls back to the default timeout when settings cannot be read', async () => {
    mockGetOrgSettings.mockResolvedValue({ ok: false, err: 'DB_ERROR' });
    stubDb(sessionRow(2 * HOUR));
    expect(await getSessionById('sess-1')).not.toBeNull();
    const { deleted } = stubDb(sessionRow(13 * HOUR));
    expect(await getSessionById('sess-1')).toBeNull();
    expect(deleted).toEqual(['sess-1']);
  });

  it('still ends a session past its absolute expiry regardless of use', async () => {
    const { deleted } = stubDb({ ...sessionRow(0), expires_at: new Date(Date.now() - 1000) });
    expect(await getSessionById('sess-1')).toBeNull();
    expect(deleted).toEqual(['sess-1']);
  });
});
