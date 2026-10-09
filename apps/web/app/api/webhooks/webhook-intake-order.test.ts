/**
 * Every inbound webhook route refuses the cheap cases BEFORE it reads the
 * database or decrypts a connector config (lib/webhook-intake.ts): a
 * missing or malformed signature header, a body over the cap, a flood.
 * The database is mocked to throw on any use, so the assertion is literal:
 * none of these requests may reach it.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/queue', () => ({
  webhookEventsQueue: () => ({ producer: { enqueue: jest.fn() } }),
}));
jest.mock('@renkei/connector-config', () => ({ readConnectorConfigCached: jest.fn() }));

import { NextRequest } from 'next/server';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { WEBHOOK_LIMITS, WEBHOOK_MAX_BODY_BYTES } from '@/lib/webhook-intake';
import { POST as githubPost } from './github/[tenantId]/route';
import { POST as bitbucketPost } from './bitbucket/[tenantId]/route';
import { POST as zoomPost } from './zoom/[tenantId]/route';
import { POST as webexPost } from './webex/[tenantId]/user/[accountId]/route';
import { POST as microsoftPost } from './microsoft/[tenantId]/[accountId]/route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { readConnectorConfigCached: mockReadConfig } = jest.requireMock<{
  readConnectorConfigCached: jest.Mock;
}>('@renkei/connector-config');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = 'acct-1';
const HEX64 = 'a'.repeat(64);

/**
 * Every route's context, as a superset: a handler that destructures only
 * `tenantId` accepts it, and the two per-account routes read both.
 */
type RouteParams = { tenantId: string; accountId: string };
type Handler = (
  request: NextRequest,
  context: { params: Promise<RouteParams> }
) => Promise<Response>;

interface Route {
  name: string;
  post: Handler;
  path: string;
  params: RouteParams;
  /** Headers that pass the shape check (so the body cap case gets that far). */
  validHeaders: Record<string, string>;
  /** A credential header present but of the wrong shape; null when the provider has none. */
  malformedHeaders: Record<string, string> | null;
}

const ROUTES: Route[] = [
  {
    name: 'github',
    post: githubPost,
    path: `/api/webhooks/github/${TENANT}`,
    params: { tenantId: TENANT, accountId: ACCOUNT },
    validHeaders: { 'x-hub-signature-256': `sha256=${HEX64}`, 'x-github-event': 'workflow_run' },
    malformedHeaders: { 'x-hub-signature-256': 'sha256=not-hex' },
  },
  {
    name: 'bitbucket',
    post: bitbucketPost,
    path: `/api/webhooks/bitbucket/${TENANT}`,
    params: { tenantId: TENANT, accountId: ACCOUNT },
    validHeaders: {
      'x-renkei-webhook-secret': 'shared',
      'x-event-key': 'repo:commit_status_updated',
    },
    malformedHeaders: { 'x-renkei-webhook-secret': 'x'.repeat(513) },
  },
  {
    name: 'zoom',
    post: zoomPost,
    path: `/api/webhooks/zoom/${TENANT}`,
    params: { tenantId: TENANT, accountId: ACCOUNT },
    validHeaders: { 'x-zm-signature': `v0=${HEX64}`, 'x-zm-request-timestamp': '1700000000' },
    malformedHeaders: { 'x-zm-signature': `v0=${HEX64}`, 'x-zm-request-timestamp': 'yesterday' },
  },
  {
    name: 'webex',
    post: webexPost,
    path: `/api/webhooks/webex/${TENANT}/user/${ACCOUNT}`,
    params: { tenantId: TENANT, accountId: ACCOUNT },
    validHeaders: { 'x-spark-signature': 'b'.repeat(40) },
    malformedHeaders: { 'x-spark-signature': 'short' },
  },
  {
    name: 'microsoft',
    post: microsoftPost,
    path: `/api/webhooks/microsoft/${TENANT}/${ACCOUNT}`,
    params: { tenantId: TENANT, accountId: ACCOUNT },
    validHeaders: {},
    malformedHeaders: null,
  },
];

function deliver(
  route: Route,
  options: { headers?: Record<string, string>; body?: string; contentLength?: number } = {}
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': '203.0.113.7',
    ...(options.headers ?? {}),
  };
  if (options.contentLength !== undefined)
    headers['content-length'] = String(options.contentLength);
  const request = new NextRequest(`http://localhost${route.path}`, {
    method: 'POST',
    headers,
    body: options.body ?? '{"value":[]}',
  });
  return route.post(request, { params: Promise.resolve(route.params) });
}

beforeEach(() => {
  resetInboundLimits();
  mockGetDatabase.mockReset().mockImplementation(() => {
    throw new Error('database reached before the intake checks');
  });
  mockReadConfig.mockReset().mockImplementation(() => {
    throw new Error('connector config read before the intake checks');
  });
});

describe.each(ROUTES.filter((route) => route.malformedHeaders !== null))(
  '$name webhook: credential header before any read',
  (route) => {
    it('refuses a delivery with no signature header without touching the database', async () => {
      const response = await deliver(route, { headers: {} });
      expect(response.status).toBe(401);
      expect(mockGetDatabase).not.toHaveBeenCalled();
      expect(mockReadConfig).not.toHaveBeenCalled();
    });

    it('refuses a header of the wrong shape the same way', async () => {
      const response = await deliver(route, { headers: route.malformedHeaders ?? {} });
      expect(response.status).toBe(401);
      expect(mockGetDatabase).not.toHaveBeenCalled();
      expect(mockReadConfig).not.toHaveBeenCalled();
    });
  }
);

describe.each(ROUTES)('$name webhook: body cap and throttle', (route) => {
  it('answers 413 to a declared body over the cap, before the database', async () => {
    const response = await deliver(route, {
      headers: route.validHeaders,
      contentLength: WEBHOOK_MAX_BODY_BYTES + 1,
    });
    expect(response.status).toBe(413);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('answers 413 to a body that actually exceeds the cap, before the database', async () => {
    const response = await deliver(route, {
      headers: route.validHeaders,
      body: `{"pad":"${'x'.repeat(WEBHOOK_MAX_BODY_BYTES)}"}`,
    });
    expect(response.status).toBe(413);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('answers 429 once the per-client window is spent, before the database', async () => {
    // Spend the budget with requests that fail cheaply (no body of note);
    // only the verdict matters here.
    for (let i = 0; i < WEBHOOK_LIMITS.perClient.limit; i += 1) {
      await deliver(route, {
        headers: route.validHeaders,
        contentLength: WEBHOOK_MAX_BODY_BYTES + 1,
      });
    }
    const response = await deliver(route, { headers: route.validHeaders });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });
});
