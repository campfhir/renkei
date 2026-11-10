/**
 * A code project's commits (GET /api/code/projects/:id/commits), on the
 * memory store with the code host's adapter stood in: the project's own
 * branch, how far the Commits page's "Load more" may ask (`max`, from 30,
 * at most 100), whether there is more, the card's one newest commit, and
 * a host that cannot be read answered as a 502 with its own reason
 * (commits-page.model.ts shows it).
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/code/repo-host', () => ({ hostAdapterFor: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { HostCommit } from '@/lib/code/repo-host';
import { GET } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { hostAdapterFor: mockAdapterFor } = jest.requireMock<{ hostAdapterFor: jest.Mock }>(
  '@/lib/code/repo-host'
);

const ME = 'member@example.com';
const listCommits = jest.fn();

const commit = (sha: string): HostCommit => ({
  sha,
  message: `Commit ${sha}`,
  author: 'octocat',
  date: '2026-09-01T00:00:00.000Z',
  url: `https://github.com/acme/site/commit/${sha}`,
});

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
  mockAdapterFor.mockReturnValue({ listCommits });
  listCommits.mockResolvedValue({ ok: true, commits: [commit('a'), commit('b')], hasMore: true });
});

afterEach(() => resetDataStore());

function codeProject(branch = 'release'): Promise<string> {
  return getDataStore().chatProjects.create({
    ownerSubject: ME,
    name: 'Site',
    description: null,
    toolConfig: null,
    repo: { provider: 'github', fullName: 'acme/site', branch },
  });
}

function read(projectId: string, query = '') {
  return GET(new NextRequest(`http://test.local/api/code/projects/${projectId}/commits${query}`), {
    params: Promise.resolve({ projectId }),
  });
}

describe('GET /api/code/projects/:id/commits', () => {
  it('lists a page of the project branch’s commits, and whether there are more', async () => {
    const projectId = await codeProject();

    const response = await read(projectId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commits: [commit('a'), commit('b')], hasMore: true });
    expect(listCommits).toHaveBeenCalledWith('acme/site', { ref: 'release', max: 30 });
  });

  it('asks the host for as many as Load more widened the page to, up to 100', async () => {
    const projectId = await codeProject();
    await read(projectId, '?max=60');
    expect(listCommits).toHaveBeenLastCalledWith('acme/site', { ref: 'release', max: 60 });
    await read(projectId, '?max=500');
    expect(listCommits).toHaveBeenLastCalledWith('acme/site', { ref: 'release', max: 100 });
    for (const bad of ['?max=0', '?max=-5', '?max=lots']) {
      await read(projectId, bad);
      expect(listCommits).toHaveBeenLastCalledWith('acme/site', { ref: 'release', max: 30 });
    }
  });

  it('reads the repository’s default branch when the project names none', async () => {
    const projectId = await codeProject('');
    await read(projectId);
    expect(listCommits).toHaveBeenLastCalledWith('acme/site', { ref: undefined, max: 30 });
  });

  it('answers the card just the newest commit', async () => {
    const projectId = await codeProject();
    expect(await (await read(projectId, '?view=summary')).json()).toEqual({
      mostRecent: commit('a'),
    });
    expect(listCommits).toHaveBeenLastCalledWith('acme/site', { ref: 'release', max: 1 });
  });

  it('passes the host’s reason on when it cannot be read, as a 502', async () => {
    listCommits.mockResolvedValue({ ok: false, error: 'GitHub is not connected.' });
    const projectId = await codeProject();
    const response = await read(projectId);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('GitHub is not connected.');
  });
});
