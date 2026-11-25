/**
 * A person's high-risk lists (GET/PUT /api/preferences/high-risk), on the
 * memory store: one kind replaced whole, the other left alone, what is
 * not a list refused.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET, PUT } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

let me: string;

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  me = `alice-${randomUUID()}`;
  mockGetSession.mockImplementation(async () => ({ subject: me, roles: ['renkei-user'] }));
});

afterEach(() => resetDataStore());

const put = (body: unknown) =>
  PUT(
    new NextRequest('http://test.local/api/preferences/high-risk', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );
const get = async (kind: string) =>
  (await GET(new NextRequest(`http://test.local/api/preferences/high-risk?kind=${kind}`))).json();

describe('GET/PUT /api/preferences/high-risk', () => {
  it('starts with no departures from the default for either kind', async () => {
    expect(await get('agents')).toEqual({ marked: [], unmarked: [] });
    expect(await get('code')).toEqual({ marked: [], unmarked: [] });
  });

  it('replaces one kind wholesale and answers what it stored, leaving the other alone', async () => {
    const response = await put({
      kind: 'code',
      marked: ['code_git_push'],
      unmarked: ['github_create_pull_request', 'github_create_pull_request'],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      marked: ['code_git_push'],
      unmarked: ['github_create_pull_request'],
    });
    expect(await get('code')).toEqual({
      marked: ['code_git_push'],
      unmarked: ['github_create_pull_request'],
    });
    expect(await get('agents')).toEqual({ marked: [], unmarked: [] });
  });

  it('refuses an unknown kind or lists that are not lists', async () => {
    expect((await put({ kind: 'chat', marked: [], unmarked: [] })).status).toBe(400);
    expect((await put({ kind: 'agents', marked: 'x', unmarked: [] })).status).toBe(400);
    expect(
      (await GET(new NextRequest('http://test.local/api/preferences/high-risk?kind=x'))).status
    ).toBe(400);
  });
});
