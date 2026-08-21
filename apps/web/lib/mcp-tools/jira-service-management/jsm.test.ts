/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jsm_create_request against a stubbed JsmAuth — the desk-id resolution
 * seam. The GET endpoints take the project KEY in their URL path, so a
 * model that used "CAS" for jsm_get_request_type_fields naturally passes
 * it to create too — but POST /request wants the NUMERIC id in the body
 * and answers a bare 400 for a key, an error that reads like the fields
 * were wrong. The handler must resolve the key, not forward it.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
// jsm.ts imports helpers from ../common, which transitively pulls in
// @renkei/db (ESM-only kysely) for exports this suite never touches.
jest.mock('../common', () => ({
  getCachedDisplayName: () => 'Test User',
  issueUrl: (site: string, key: string) => `${site}/browse/${key}`,
  requestUrl: (site: string, key: string) => `${site}/servicedesk/customer/portal/${key}`,
  withPresentationHint: (text: string) => text,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerJsmTools } from './jsm';
import type { JsmAuth } from './jsm-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

interface Route {
  match: string;
  status?: number;
  body?: unknown;
}

let routes: Route[] = [];
let requests: { path: string; method: string; body: string | null }[] = [];

const stubAuth: JsmAuth = {
  kind: 'pat',
  async fetch(_scopes, path, init) {
    requests.push({
      path,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const route = routes.find((candidate) => path.includes(candidate.match));
    if (!route) return new Response(JSON.stringify({}), { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  },
};

async function toolsOf(): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const context = {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    siteUrl: 'https://example.atlassian.net',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
  } as unknown as MCPToolContext;
  await registerJsmTools(server, context, stubAuth);
  return registered;
}

beforeEach(() => {
  routes = [];
  requests = [];
});

describe('jsm_create_request desk-id resolution', () => {
  it('resolves a project key to the numeric id before posting', async () => {
    routes = [
      { match: '/servicedesk/CAS', body: { id: '7', projectKey: 'CAS' } },
      { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-101' } },
    ];
    const tools = await toolsOf();

    const result = await tools.get('jsm_create_request')!({
      serviceDeskId: 'CAS',
      requestTypeId: '165',
      summary: 'Wait-time display discrepancy',
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('CAS-101');
    const post = requests.find((r) => r.method === 'POST');
    expect(post).toBeDefined();
    const body = JSON.parse(post?.body ?? '{}') as Record<string, unknown>;
    expect(body.serviceDeskId).toBe('7');
  });

  it('posts a numeric id straight through without a lookup', async () => {
    routes = [{ match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-102' } }];
    const tools = await toolsOf();

    const result = await tools.get('jsm_create_request')!({
      serviceDeskId: '7',
      requestTypeId: '165',
      summary: 'Wait-time display discrepancy',
    });

    expect(result.isError).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
  });

  it('says the desk could not be resolved instead of forwarding the key', async () => {
    routes = [{ match: '/rest/servicedeskapi/request', body: { issueKey: 'never' } }];
    const tools = await toolsOf();

    const result = await tools.get('jsm_create_request')!({
      serviceDeskId: 'NOPE',
      requestTypeId: '165',
      summary: 'Wait-time display discrepancy',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('could not be resolved');
    // The bare key must never reach the create endpoint.
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });
});
