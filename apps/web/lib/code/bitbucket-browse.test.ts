/**
 * The Code pages' Bitbucket readers against a stubbed BitbucketAuth — the
 * same seam the bitbucket_ tool suite uses. What earns a pin: the
 * workspace listing reads the endpoints Bitbucket's newer tokens accept
 * (the bare /workspaces listing answers them with an anonymous-style 404,
 * which took the whole new-project form down with it), and the
 * search-every-workspace path stands on that same listing.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@/lib/get-origin', () => ({ getOrigin: jest.fn() }));

import type { BitbucketAuth } from '@/lib/mcp-tools/bitbucket/bitbucket-auth';
import { listRepositories, listWorkspaces } from './bitbucket-browse';

interface Route {
  match: string;
  status?: number;
  body?: unknown;
}

let routes: Route[] = [];
let requests: string[] = [];

const stubAuth: BitbucketAuth = {
  kind: 'pat',
  async fetch(_scopes, path) {
    requests.push(path);
    const route = routes.find((candidate) => path.includes(candidate.match));
    if (!route) return new Response(JSON.stringify({}), { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  },
};

const ANONYMOUS_404 = {
  status: 404,
  body: {
    type: 'error',
    error: { message: 'Resource not found', detail: 'There is no API hosted at this URL.' },
  },
};

beforeEach(() => {
  routes = [];
  requests = [];
});

describe('listWorkspaces', () => {
  it('reads /user/workspaces and unwraps each membership row', async () => {
    routes = [
      {
        match: '/user/workspaces',
        body: {
          values: [
            { administrator: true, workspace: { slug: 'nems', name: 'NEMS' } },
            { administrator: false, workspace: { slug: 'acme-labs' } },
          ],
        },
      },
    ];
    const listed = await listWorkspaces(stubAuth);

    expect(listed).toEqual({
      ok: true,
      workspaces: [
        { slug: 'nems', name: 'NEMS' },
        { slug: 'acme-labs', name: 'acme-labs' },
      ],
    });
    expect(requests).toEqual(['/user/workspaces?pagelen=50']);
  });

  it('falls back to the permissions listing when the membership listing refuses the token', async () => {
    // Longer paths first: the stub matches by substring in order.
    routes = [
      {
        match: '/user/permissions/workspaces',
        body: { values: [{ permission: 'member', workspace: { slug: 'nems', name: 'NEMS' } }] },
      },
      { match: '/user/workspaces', ...ANONYMOUS_404 },
    ];
    const listed = await listWorkspaces(stubAuth);

    expect(listed).toEqual({ ok: true, workspaces: [{ slug: 'nems', name: 'NEMS' }] });
    expect(requests).toEqual([
      '/user/workspaces?pagelen=50',
      '/user/permissions/workspaces?pagelen=50',
    ]);
  });

  it('never reads the deprecated bare /workspaces listing', async () => {
    routes = [{ match: '/workspaces', body: { values: [{ slug: 'nems', name: 'NEMS' }] } }];
    await listWorkspaces(stubAuth);

    expect(requests.some((path) => path.startsWith('/workspaces'))).toBe(false);
  });

  it('surfaces the primary listing’s error when both listings refuse', async () => {
    routes = [
      { match: '/user/permissions/workspaces', ...ANONYMOUS_404 },
      { match: '/user/workspaces', ...ANONYMOUS_404 },
    ];
    const listed = await listWorkspaces(stubAuth);

    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error).toContain('without usable credentials');
  });
});

describe('listRepositories', () => {
  it('a search by name with no workspace walks the workspaces the person belongs to', async () => {
    routes = [
      {
        match: '/user/workspaces',
        body: {
          values: [
            { workspace: { slug: 'nems', name: 'NEMS' } },
            { workspace: { slug: 'acme-labs', name: 'Acme Labs' } },
          ],
        },
      },
      {
        match: '/repositories/nems?',
        body: {
          values: [
            {
              full_name: 'nems/billing-service',
              name: 'billing-service',
              project: { key: 'BILL' },
              mainbranch: { name: 'main' },
              updated_on: '2026-08-20T00:00:00Z',
            },
          ],
        },
      },
      { match: '/repositories/acme-labs?', body: { values: [] } },
    ];
    const listed = await listRepositories(stubAuth, { query: 'billing' });

    expect(listed).toEqual({
      ok: true,
      repos: [
        {
          fullName: 'nems/billing-service',
          name: 'billing-service',
          projectKey: 'BILL',
          mainBranch: 'main',
          updatedOn: '2026-08-20T00:00:00Z',
        },
      ],
    });
    expect(requests[0]).toBe('/user/workspaces?pagelen=50');
    expect(requests[1]).toBe(
      `/repositories/nems?pagelen=100&sort=-updated_on&q=${encodeURIComponent('name ~ "billing"')}`
    );
    expect(requests[2]).toContain('/repositories/acme-labs?');
  });

  it('one workspace’s listing is read directly, without listing workspaces', async () => {
    routes = [{ match: '/repositories/nems?', body: { values: [] } }];
    const listed = await listRepositories(stubAuth, { workspace: 'nems', project: 'BILL' });

    expect(listed).toEqual({ ok: true, repos: [] });
    expect(requests).toEqual([
      `/repositories/nems?pagelen=100&sort=-updated_on&q=${encodeURIComponent('project.key = "BILL"')}`,
    ]);
  });
});
