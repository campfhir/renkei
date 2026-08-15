/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The SharePoint half of the watch routes, against a stubbed Graph.
 *
 * Two of these guard traps that a passing build would not catch, because
 * both fail by doing nothing rather than by erroring:
 *
 *   - A library is named by (site, driveId) and the pair is checked against
 *     each other. Accepting a bare driveId would store an unvalidated,
 *     unlabelled watch that fails silently in the background forever — the
 *     thing confluence/watches.ts resolves spaces to avoid.
 *   - Re-index has to discard SharePoint's QUEUED work, which is
 *     `ingest.document` with the scope at the payload's top level. Jira and
 *     Confluence use `ingest.object` with the scope under `metadata`, and
 *     matching that shape here finds nothing, reports zero discarded, and
 *     lets the backlog rebuild everything the purge just deleted.
 */

// kysely ships ESM only and is not transformed for this suite. The routes use
// exactly one thing from it — the `sql` tag, for NOW() — and the stubbed db
// below never inspects what it produces.
jest.mock('kysely', () => ({ sql: () => ({}) }));

jest.mock('@/lib/session', () => ({
  getSessionFromRequest: jest.fn(async () => ({ subject: 'subject-1' })),
}));
jest.mock('@/lib/get-origin', () => ({
  getOrigin: jest.fn(async () => ({ ok: true, val: 'https://renkei.example.com' })),
}));
jest.mock('@/lib/microsoft-app', () => ({ getMicrosoftApp: jest.fn(async () => null) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@renkei/provider-grants', () => ({
  getGrant: jest.fn(async () => ({
    ok: true,
    val: {
      accessToken: 'token-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      metadata: { upn: 'alice@example.com', tid: 'tid-1' },
    },
  })),
  refreshGrantTokens: jest.fn(),
  MICROSOFT: 'microsoft',
  ATLASSIAN: 'atlassian',
  ATLASSIAN_CONFLUENCE: 'atlassian-confluence',
  MicrosoftAdapter: class {},
}));
/**
 * A query builder that accepts any chain and answers the same row.
 *
 * Counting .where() calls to shape the mock is how these stubs rot: adding a
 * filter to a route then breaks the test for a reason that has nothing to do
 * with what it checks. Only two queries reach here — the grant lookup and the
 * watch-ownership lookup — and one row satisfies both.
 */
jest.mock('@renkei/db', () => {
  const row = { provider_account_id: 'acct-1', id: 'watch-1', scope_label: 'Eng / Documents' };
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'executeTakeFirst') return async () => row;
        if (property === 'execute') return async () => [];
        return () => chain;
      },
    }
  );
  return { getDatabase: () => ({ ok: true, val: chain }) };
});

const upsertWatch = jest.fn(async () => ({ ok: true, created: true }));
jest.mock('@/lib/mcp-tools/content-watches', () => ({
  upsertWatch: (...args: unknown[]) => upsertWatch(...(args as [])),
  disableWatch: jest.fn(async () => ({ ok: true, found: true })),
  listWatches: jest.fn(async () => ({ ok: true, watches: [] })),
}));

const discardPending = jest.fn(async () => ({ ok: true, val: 4 }));
jest.mock('@renkei/queue', () => ({
  embeddingJobsQueue: () => ({ purger: { discardPending } }),
}));
jest.mock('@renkei/knowledge', () => ({
  deleteChunksByMetadata: jest.fn(async () => ({ ok: true, val: 12 })),
}));

import { NextRequest } from 'next/server';
import { POST as postWatch } from './route';
import { GET as getOptions } from './options/route';
import { POST as postReindex } from './reindex/route';

interface Route {
  match: string;
  body?: unknown;
  status?: number;
}

let routes: Route[] = [];
let requests: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  routes = [];
  requests = [];
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) return new Response(JSON.stringify({ error: 'no stub' }), { status: 404 });
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const params = Promise.resolve({ tenantId: 'tenant-1' });

function postRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The '?' matters: '/sites/site-1' alone is also a prefix of the site's
// /drives URL, so the site stub would answer the library listing too.
const SITE = { match: '/sites/site-1?', body: { id: 'site-1', displayName: 'Eng' } };
const DRIVES = {
  match: '/drives',
  body: {
    value: [
      { id: 'drive-1', name: 'Documents', webUrl: 'https://x/docs' },
      { id: 'drive-2', name: 'Policies', webUrl: 'https://x/pol' },
    ],
  },
};

describe('POST /watches — sharepoint', () => {
  it('stores the drive keyed and labelled from the site that lists it', async () => {
    routes = [SITE, DRIVES];

    const response = await postWatch(
      postRequest('https://renkei.example.com/api/tenant/tenant-1/watches', {
        provider: 'sharepoint',
        site: 'site-1',
        scopeKey: 'drive-2',
      }),
      { params }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      created: true,
      scopeKey: 'drive-2',
      label: 'Eng / Policies',
    });
    // scope_type 'drive', and the account whose grant the worker will poll
    // with — taken from the same lookup that produced the token.
    expect(upsertWatch).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', subject: 'subject-1', accountId: 'acct-1' },
      'sharepoint',
      'drive',
      'drive-2',
      'Eng / Policies'
    );
  });

  it('refuses a drive the site does not list', async () => {
    // Otherwise a mistyped or stale driveId becomes a watch that polls
    // nothing, forever, with no label to show for it.
    routes = [SITE, DRIVES];

    const response = await postWatch(
      postRequest('https://renkei.example.com/api/tenant/tenant-1/watches', {
        provider: 'sharepoint',
        site: 'site-1',
        scopeKey: 'drive-from-another-site',
      }),
      { params }
    );

    expect(response.status).toBe(400);
    expect(upsertWatch).not.toHaveBeenCalled();
  });

  it('refuses a library named without its site', async () => {
    const response = await postWatch(
      postRequest('https://renkei.example.com/api/tenant/tenant-1/watches', {
        provider: 'sharepoint',
        scopeKey: 'drive-2',
      }),
      { params }
    );

    expect(response.status).toBe(400);
    expect(upsertWatch).not.toHaveBeenCalled();
  });
});

describe('GET /watches/options — sharepoint', () => {
  it('opens on the sites the user follows, with no search term', async () => {
    routes = [
      {
        match: '/me/followedSites',
        body: { value: [{ id: 'site-1', displayName: 'Eng', webUrl: 'https://x/eng' }] },
      },
    ];

    const response = await getOptions(
      new NextRequest(
        'https://renkei.example.com/api/tenant/tenant-1/watches/options?provider=sharepoint'
      ),
      { params }
    );

    await expect(response.json()).resolves.toEqual({
      sites: [{ id: 'site-1', name: 'Eng', webUrl: 'https://x/eng' }],
    });
  });

  it('searches sites when given a query', async () => {
    routes = [{ match: '/sites?search=', body: { value: [] } }];

    await getOptions(
      new NextRequest(
        'https://renkei.example.com/api/tenant/tenant-1/watches/options?provider=sharepoint&q=policies'
      ),
      { params }
    );

    expect(requests[0]).toContain('/sites?search=policies');
  });

  it('lists a site’s libraries keyed by driveId — what a watch stores', async () => {
    routes = [SITE, DRIVES];

    const response = await getOptions(
      new NextRequest(
        'https://renkei.example.com/api/tenant/tenant-1/watches/options?provider=sharepoint&site=site-1'
      ),
      { params }
    );

    await expect(response.json()).resolves.toMatchObject({
      siteId: 'site-1',
      siteName: 'Eng',
      options: [
        { key: 'drive-1', label: 'Documents' },
        { key: 'drive-2', label: 'Policies' },
      ],
    });
  });
});

describe('POST /watches/reindex — sharepoint', () => {
  it('discards the ingest.document work that would rebuild what it purged', async () => {
    const response = await postReindex(
      postRequest('https://renkei.example.com/api/tenant/tenant-1/watches/reindex', {
        provider: 'sharepoint',
        scopeKey: 'drive-2',
      }),
      { params }
    );

    expect(response.status).toBe(200);
    // The message type and the scope path both differ from Jira/Confluence,
    // and a mismatch on either silently discards nothing.
    expect(discardPending).toHaveBeenCalledWith('tenant-1', 'ingest.document', [
      { path: ['provider'], value: 'sharepoint' },
      { path: ['scopeKey'], value: 'drive-2' },
    ]);
  });
});
