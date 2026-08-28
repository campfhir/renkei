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
  JiraApiError: class JiraApiError extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message);
      this.name = 'JiraApiError';
    }
  },
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerJsmTools } from './jsm';
import type { JsmAuth } from './jsm-auth';
import { JiraApiError, type MCPToolContext } from '../common';
import { clearFieldSchemaCache } from '../jira/field-schema';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

interface Route {
  match: string;
  status?: number;
  body?: unknown;
  /** Throw JiraApiError with this status instead of answering — how the
   *  real jiraFetch reports a genuine API rejection. */
  throwStatus?: number;
  /** Consume this route on first match, for first-call-fails sequences. */
  once?: boolean;
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
    const index = routes.findIndex((candidate) => path.includes(candidate.match));
    const route = index >= 0 ? routes[index] : undefined;
    if (route?.once) routes.splice(index, 1);
    if (route?.throwStatus !== undefined) {
      throw new JiraApiError('Jira rejected the payload', route.throwStatus);
    }
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
  clearFieldSchemaCache();
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

/**
 * Reporter, assignee, and priority — the fields the ticket-creating agents
 * kept describing in prose because the tool had no input for them. The rule
 * is the components rule: a value that cannot land costs itself and a note,
 * never the request.
 */
describe('jsm_create_request reporter, assignee, and priority', () => {
  const create = async (extra: Record<string, unknown>) => {
    const tools = await toolsOf();
    return tools.get('jsm_create_request')!({
      serviceDeskId: '7',
      requestTypeId: '165',
      summary: 'Wait-time display discrepancy',
      ...extra,
    });
  };

  it('raises the request on behalf of the reporter', async () => {
    routes = [{ match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-300' } }];
    const result = await create({ reporter: 'scott@nems.org' });

    expect(result.isError).not.toBe(true);
    const post = requests.find((r) => r.method === 'POST');
    const body = JSON.parse(post?.body ?? '{}') as Record<string, unknown>;
    expect(body.raiseOnBehalfOf).toBe('scott@nems.org');
    expect(result.content[0]?.text).toContain('on behalf of scott@nems.org');
  });

  it('a reporter Jira rejects costs the reporter, not the request', async () => {
    routes = [
      { match: '/rest/servicedeskapi/request', throwStatus: 400, once: true },
      { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-301' } },
    ];
    const result = await create({ reporter: 'nobody@nems.org' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('CAS-301');
    expect(result.content[0]?.text).toContain('Reporter was not set');
    const retry = requests.filter((r) => r.method === 'POST')[1];
    const body = JSON.parse(retry?.body ?? '{}') as Record<string, unknown>;
    expect(body.raiseOnBehalfOf).toBeUndefined();
  });

  it('sets the assignee with a platform edit after the create', async () => {
    routes = [
      { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-302' } },
      {
        match: '/rest/api/3/user/search',
        body: [{ accountId: 'acc-9', emailAddress: 'hiro@nems.org', displayName: 'Hiro' }],
      },
      { match: '/rest/api/3/issue/CAS-302/assignee', body: {} },
    ];
    const result = await create({ assignee: 'hiro@nems.org' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('Assignee: set');
    const put = requests.find((r) => r.path.endsWith('/assignee'));
    expect(put?.method).toBe('PUT');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ accountId: 'acc-9' });
  });

  it('a denied platform edit costs the assignee and says so, not the request', async () => {
    routes = [
      { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-303' } },
      {
        match: '/rest/api/3/user/search',
        body: [{ accountId: 'acc-9', emailAddress: 'hiro@nems.org', displayName: 'Hiro' }],
      },
      {
        match: '/assignee',
        status: 403,
        body: { message: 'This call needs write:issue:jira' },
      },
    ];
    const result = await create({ assignee: 'hiro@nems.org' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('CAS-303');
    expect(result.content[0]?.text).toContain('Assignee was not set — This call needs');
  });

  it('sets priority through the form when the request type carries it', async () => {
    routes = [
      {
        match: '/requesttype/165/field',
        body: {
          requestTypeFields: [{ fieldId: 'priority', validValues: [{ value: '2', label: 'High' }] }],
        },
      },
      { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-304' } },
    ];
    const result = await create({ priority: 'high' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('Priority: set');
    const post = requests.find((r) => r.method === 'POST');
    const body = JSON.parse(post?.body ?? '{}') as { requestFieldValues?: Record<string, unknown> };
    expect(body.requestFieldValues?.priority).toEqual({ id: '2' });
  });

  it('falls back to a platform edit when the form has no priority field', async () => {
    routes = [
      { match: '/requesttype/165/field', body: { requestTypeFields: [{ fieldId: 'summary' }] } },
      { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-305' } },
      { match: '/rest/api/3/issue/CAS-305', body: {} },
    ];
    const result = await create({ priority: 'High' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('Priority: set');
    const post = requests.find((r) => r.method === 'POST');
    const postBody = JSON.parse(post?.body ?? '{}') as {
      requestFieldValues?: Record<string, unknown>;
    };
    // Never sent through the form it is not on — that would cost the request.
    expect(postBody.requestFieldValues?.priority).toBeUndefined();
    const put = requests.find((r) => r.method === 'PUT');
    expect(put?.path).toContain('/rest/api/3/issue/CAS-305');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ fields: { priority: { name: 'High' } } });
  });

  it('sets story points and custom fields with a platform edit after the create', async () => {
    routes = [
      { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-310' } },
      {
        match: '/rest/api/3/field',
        body: [
          { id: 'customfield_10016', name: 'Story point estimate', schema: { type: 'number' } },
          { id: 'customfield_12016', name: 'Decision', schema: { type: 'string' } },
        ],
      },
      { match: '/rest/api/3/issue/CAS-310', body: {} },
    ];
    const result = await create({ storyPoints: 5, fields: { Decision: 'Approved' } });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('Story point estimate → 5');
    const put = requests.find((r) => r.method === 'PUT');
    expect(put?.path).toContain('/rest/api/3/issue/CAS-310');
    const body = JSON.parse(put?.body ?? '{}') as { fields?: Record<string, unknown> };
    expect(body.fields?.customfield_10016).toBe(5);
    expect(body.fields?.customfield_12016).toBe('Approved');
  });

  it('an unreadable field schema costs the extras and says so, not the request', async () => {
    routes = [
      { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-311' } },
      {
        match: '/rest/api/3/field',
        status: 403,
        body: { message: 'This call needs read:issue:jira' },
      },
    ];
    const result = await create({ storyPoints: 5 });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('CAS-311');
    expect(result.content[0]?.text).toContain('Extra fields were not set');
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('names the accepted priorities when the given one does not match the form', async () => {
    routes = [
      {
        match: '/requesttype/165/field',
        body: {
          requestTypeFields: [
            { fieldId: 'priority', validValues: [{ value: '2', label: 'High' }] },
          ],
        },
      },
      { match: '/rest/servicedeskapi/request', body: { issueKey: 'CAS-306' } },
    ];
    const result = await create({ priority: 'Urgent' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('Priority was not set');
    expect(result.content[0]?.text).toContain('High (2)');
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
