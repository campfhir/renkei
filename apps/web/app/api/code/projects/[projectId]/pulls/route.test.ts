/**
 * A code project's pull requests (GET /api/code/projects/:id/pulls), on
 * the memory store with the code host's adapter stood in: the summary the
 * project page's card reads, the full list the Pulls page reads, and a
 * host that cannot be read — no grant, or an API failure — answered as a
 * 502 carrying the host's own reason, which the card and page show
 * (pulls-summary.model.ts, pulls-page.model.ts). Only a member's project.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/code/repo-host', () => ({ hostAdapterFor: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { HostPullRequest } from '@/lib/code/repo-host';
import { GET } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { hostAdapterFor: mockAdapterFor } = jest.requireMock<{ hostAdapterFor: jest.Mock }>(
  '@/lib/code/repo-host'
);

const ME = 'member@example.com';
const listPullRequests = jest.fn();

const pr = (number: number): HostPullRequest => ({
  number,
  title: `PR ${number}`,
  state: 'open',
  draft: false,
  sourceBranch: `feat/${number}`,
  destinationBranch: 'main',
  author: 'octocat',
  updatedAt: '2026-09-01T00:00:00.000Z',
  url: `https://github.com/acme/site/pull/${number}`,
});

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
  mockAdapterFor.mockReturnValue({ listPullRequests });
});

afterEach(() => resetDataStore());

function codeProject(owner = ME): Promise<string> {
  return getDataStore().chatProjects.create({
    ownerSubject: owner,
    name: 'Site',
    description: null,
    toolConfig: null,
    repo: { provider: 'github', fullName: 'acme/site', branch: 'main' },
  });
}

function read(projectId: string, query = '') {
  return GET(new NextRequest(`http://test.local/api/code/projects/${projectId}/pulls${query}`), {
    params: Promise.resolve({ projectId }),
  });
}

describe('GET /api/code/projects/:id/pulls', () => {
  it('lists the open pull requests with the person’s own grant on the project’s host', async () => {
    listPullRequests.mockResolvedValue({
      ok: true,
      pullRequests: [pr(42), pr(41)],
      hasMore: false,
    });
    const projectId = await codeProject();

    const response = await read(projectId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pullRequests: [pr(42), pr(41)], hasMore: false });
    expect(mockAdapterFor).toHaveBeenCalledWith('github', expect.objectContaining({ subject: ME }));
    expect(listPullRequests).toHaveBeenCalledWith('acme/site', { state: 'open', max: 25 });
  });

  it('answers the card just the count, whether there are more, and the most recent', async () => {
    listPullRequests.mockResolvedValue({ ok: true, pullRequests: [pr(42), pr(41)], hasMore: true });
    const projectId = await codeProject();

    expect(await (await read(projectId, '?view=summary')).json()).toEqual({
      openCount: 2,
      hasMore: true,
      mostRecent: pr(42),
    });
  });

  it('answers no most recent when none are open', async () => {
    listPullRequests.mockResolvedValue({ ok: true, pullRequests: [], hasMore: false });
    const projectId = await codeProject();
    expect(await (await read(projectId, '?view=summary')).json()).toEqual({
      openCount: 0,
      hasMore: false,
      mostRecent: null,
    });
  });

  it('passes the host’s reason on when it cannot be read, as a 502', async () => {
    const reason = 'GitHub is not connected. Connect it on the Connectors page, then try again.';
    listPullRequests.mockResolvedValue({ ok: false, error: reason });
    const projectId = await codeProject();

    for (const query of ['', '?view=summary']) {
      const response = await read(projectId, query);
      expect(response.status).toBe(502);
      expect((await response.json()).error).toBe(reason);
    }
  });

  it('refuses a host it has no adapter for', async () => {
    mockAdapterFor.mockReturnValue(null);
    const projectId = await codeProject();
    const response = await read(projectId);
    expect(response.status).toBe(409);
  });

  it('is only for a project the person can reach', async () => {
    const someoneElses = await codeProject('owner@example.com');
    expect((await read(someoneElses)).status).toBe(404);
    expect(listPullRequests).not.toHaveBeenCalled();
  });
});
