/**
 * A person's own opt-in to a pull request's pipeline outcome
 * (GET/POST/DELETE /api/code/projects/:id/pr-subscriptions), on the memory
 * store: what pr-subscriptions.spec.ts used to show through two pages — a
 * subscription made in one place is the same one read in the other, Fix
 * and Merge never stand without the subscription, unsubscribing ends it,
 * and each person sees only their own. The row's own rules are
 * pr-subscribe.model.test.ts.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { grantResourceAccess } from '@/lib/chat/access';
import { DELETE, GET, POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const ME = 'member@example.com';
const OTHER = 'other@example.com';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  signedIn(ME);
});

afterEach(() => resetDataStore());

function signedIn(subject: string) {
  mockGetSession.mockResolvedValue({ subject, roles: ['renkei-user'] });
}

function codeProject(owner = ME): Promise<string> {
  return getDataStore().chatProjects.create({
    ownerSubject: owner,
    name: 'PR subscriptions',
    description: null,
    toolConfig: null,
    repo: { provider: 'atlassian-bitbucket', fullName: 'acme/pr-subscriptions', branch: 'main' },
  });
}

const params = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const url = (projectId: string, query = '') =>
  `http://test.local/api/code/projects/${projectId}/pr-subscriptions${query}`;

async function read(projectId: string, prNumber: number | string) {
  return GET(new NextRequest(url(projectId, `?prNumber=${prNumber}`)), params(projectId));
}

function send(method: 'POST' | 'DELETE', projectId: string, body: unknown) {
  const handler = method === 'POST' ? POST : DELETE;
  return handler(
    new NextRequest(url(projectId), { method, body: JSON.stringify(body) }),
    params(projectId)
  );
}

describe('/api/code/projects/:id/pr-subscriptions', () => {
  it('a PR nobody subscribed to reads as no subscription and no outcome', async () => {
    const projectId = await codeProject();
    expect(await (await read(projectId, 90)).json()).toEqual({
      subscription: null,
      lastEvent: null,
    });
  });

  it('subscribing with Fix on is read back the same, from anywhere', async () => {
    const projectId = await codeProject();
    const saved = await send('POST', projectId, {
      prNumber: 90,
      watchPipelines: true,
      autoFix: true,
      autoMerge: false,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      subscription: { watchPipelines: true, autoFix: true, autoMerge: false },
    });
    expect(await (await read(projectId, 90)).json()).toEqual({
      subscription: { watchPipelines: true, autoFix: true, autoMerge: false },
      lastEvent: null,
    });
  });

  it('Fix and Merge are not kept without the subscription', async () => {
    const projectId = await codeProject();
    const saved = await send('POST', projectId, {
      prNumber: 91,
      watchPipelines: false,
      autoFix: true,
      autoMerge: true,
    });
    expect((await saved.json()).subscription).toEqual({
      watchPipelines: false,
      autoFix: false,
      autoMerge: false,
    });
  });

  it('unsubscribing ends it', async () => {
    const projectId = await codeProject();
    await send('POST', projectId, { prNumber: 90, watchPipelines: true, autoMerge: true });
    expect((await send('DELETE', projectId, { prNumber: 90 })).status).toBe(200);
    expect((await (await read(projectId, 90)).json()).subscription).toBeNull();
  });

  it('each person reads only their own', async () => {
    const projectId = await codeProject();
    expect(
      await grantResourceAccess(ME, 'chat_project', projectId, {
        granteeSubject: OTHER,
        role: 'viewer',
        expiresAt: null,
      })
    ).not.toBe('NOT_FOUND');
    await send('POST', projectId, { prNumber: 90, watchPipelines: true });
    signedIn(OTHER);
    const theirs = await read(projectId, 90);
    expect(theirs.status).toBe(200);
    expect((await theirs.json()).subscription).toBeNull();
  });

  it('needs to know which pull request', async () => {
    const projectId = await codeProject();
    expect((await read(projectId, 'x')).status).toBe(400);
    expect((await send('POST', projectId, { watchPipelines: true })).status).toBe(400);
    expect((await send('DELETE', projectId, { prNumber: -1 })).status).toBe(400);
  });

  it('is only for a project the person can reach', async () => {
    const someoneElses = await codeProject(OTHER);
    expect((await read(someoneElses, 90)).status).toBe(404);
    expect((await send('POST', someoneElses, { prNumber: 90 })).status).toBe(404);
  });
});
