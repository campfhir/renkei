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

/**
 * Components on a request, end to end through the handler.
 *
 * The rule every case here defends: an unusable component costs the
 * COMPONENT and says so, never the request. The servicedeskapi rejects a
 * whole payload for a field the request form does not declare, so sending
 * one blindly would turn "the component did not stick" into "nothing was
 * created" — strictly worse than the silence being fixed.
 */
describe('jsm_create_request components', () => {
  const fieldRoute = (validValues: { value: string; label: string }[] | null) => ({
    match: '/requesttype/165/field',
    body:
      validValues === null
        ? { requestTypeFields: [{ fieldId: 'summary', name: 'Summary' }] }
        : { requestTypeFields: [{ fieldId: 'components', name: 'Components', validValues }] },
  });

  const created = { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-200' } };

  const create = async (components: string[]) => {
    const tools = await toolsOf();
    return tools.get('jsm_create_request')!({
      serviceDeskId: '7',
      requestTypeId: '165',
      summary: 'Wait-time display discrepancy',
      components,
    });
  };

  it('sends resolved ids, not the names it was given', async () => {
    routes = [fieldRoute([{ value: '10042', label: 'Billing' }]), created];
    const result = await create(['billing']);

    expect(result.isError).not.toBe(true);
    const post = requests.find((r) => r.method === 'POST');
    const body = JSON.parse(post?.body ?? '{}') as { requestFieldValues?: Record<string, unknown> };
    expect(body.requestFieldValues?.components).toEqual([{ id: '10042' }]);
  });

  it('creates the request anyway when the form has no components field', async () => {
    routes = [fieldRoute(null), created];
    const result = await create(['Billing']);

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('CAS-200');
    // Said out loud — this is the silence the whole change is about.
    expect(result.content[0]?.text).toContain('no components field');
    const post = requests.find((r) => r.method === 'POST');
    const body = JSON.parse(post?.body ?? '{}') as { requestFieldValues?: Record<string, unknown> };
    // And crucially NOT sent: that would have cost the request itself.
    expect(body.requestFieldValues?.components).toBeUndefined();
  });

  it('files under the good ones and names the bad one', async () => {
    routes = [
      fieldRoute([
        { value: '10042', label: 'Billing' },
        { value: '10043', label: 'Platform' },
      ]),
      created,
    ];
    const result = await create(['Billing', 'Billling']);

    expect(result.isError).not.toBe(true);
    const post = requests.find((r) => r.method === 'POST');
    const body = JSON.parse(post?.body ?? '{}') as { requestFieldValues?: Record<string, unknown> };
    expect(body.requestFieldValues?.components).toEqual([{ id: '10042' }]);
    expect(result.content[0]?.text).toContain('"Billling"');
    // The reply answers "then what?" rather than only "no".
    expect(result.content[0]?.text).toContain('Billing (10042)');
  });

  it('does not look up the form at all when no components were asked for', async () => {
    routes = [created];
    const tools = await toolsOf();
    await tools.get('jsm_create_request')!({
      serviceDeskId: '7',
      requestTypeId: '165',
      summary: 'Wait-time display discrepancy',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
  });
});

describe('jsm_list_components', () => {
  it('answers from the request type when given one, with no project call', async () => {
    // Most specific FIRST: the stub matches by substring in order, and the
    // desk route's match is a prefix of the field URL.
    routes = [
      {
        match: '/requesttype/165/field',
        body: {
          requestTypeFields: [
            { fieldId: 'components', validValues: [{ value: '10042', label: 'Billing' }] },
          ],
        },
      },
      { match: '/servicedesk/7', body: { id: '7', projectKey: 'CAS' } },
    ];
    const tools = await toolsOf();

    const result = await tools.get('jsm_list_components')!({
      serviceDeskId: '7',
      requestTypeId: '165',
    });

    expect(result.content[0]?.text).toContain('Billing (id 10042)');
    // The path that needs no Jira project scope must not touch the
    // platform API — that is the entire reason it is preferred.
    expect(requests.some((r) => r.path.includes('/rest/api/3/project'))).toBe(false);
  });

  it('says a request type cannot carry components rather than listing some anyway', async () => {
    routes = [
      { match: '/requesttype/165/field', body: { requestTypeFields: [{ fieldId: 'summary' }] } },
      { match: '/servicedesk/7', body: { id: '7', projectKey: 'CAS' } },
    ];
    const tools = await toolsOf();

    const result = await tools.get('jsm_list_components')!({
      serviceDeskId: '7',
      requestTypeId: '165',
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('cannot carry one');
    expect(result.content[0]?.text).toContain('jira_update_issue');
  });

  it('falls back to the whole project when no request type is named', async () => {
    routes = [
      { match: '/servicedesk/7', body: { id: '7', projectKey: 'CAS' } },
      {
        match: '/rest/api/3/project/CAS/components',
        body: [{ id: '10042', name: 'Billing' }],
      },
    ];
    const tools = await toolsOf();

    const result = await tools.get('jsm_list_components')!({ serviceDeskId: '7' });

    expect(result.content[0]?.text).toContain('Project CAS has 1 components');
    // And it still points at the narrower question, because having a
    // component is not the same as being able to set one.
    expect(result.content[0]?.text).toContain('requestTypeId');
  });
});
