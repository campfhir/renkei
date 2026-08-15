/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthJsmAuth`, `describeJsmAuthFailure`, `serviceDeskScopes` and
 * `customerScopes` in isolation. Mirrors ops-auth.test.ts's shape (same
 * two-member interface) — there is no denied/no-sandbox tier here (unlike
 * WebEx/Zoom/Graph): classic JSM has a real sandbox, exercised end to end
 * in jsm.integration.test.ts instead.
 */

import {
  oauthJsmAuth,
  describeJsmAuthFailure,
  serviceDeskScopes,
  customerScopes,
} from './jsm-auth';
import type { MCPToolContext } from '../common';

jest.mock('../common', () => ({
  jiraFetch: jest.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
}));

const { jiraFetch } = jest.requireMock('../common') as { jiraFetch: jest.Mock };

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({
    apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
    accessToken: 'token-1',
    grantedScopes: undefined,
    ...overrides,
  }) as unknown as MCPToolContext;

describe('serviceDeskScopes / customerScopes', () => {
  it('read-only tools need only the read scope', () => {
    expect(serviceDeskScopes('jsm_list_requests', true)).toEqual([
      'read:request:jira-service-management',
    ]);
    expect(customerScopes('jsm_list_customers', true)).toEqual([
      'read:customer:jira-service-management',
    ]);
  });

  it('mutating tools need read and write', () => {
    expect(serviceDeskScopes('jsm_create_request', false)).toEqual([
      'read:request:jira-service-management',
      'write:request:jira-service-management',
    ]);
    expect(customerScopes('jsm_create_customer', false)).toEqual([
      'read:customer:jira-service-management',
      'write:customer:jira-service-management',
    ]);
  });
});

describe('oauthJsmAuth', () => {
  beforeEach(() => jiraFetch.mockClear());

  it('kind is "oauth"', () => {
    expect(oauthJsmAuth(context()).kind).toBe('oauth');
  });

  it('calls jiraFetch against apiBaseUrl + path when no granted-scopes list is present', async () => {
    const auth = oauthJsmAuth(context());

    const response = await auth.fetch(['read:request:jira-service-management'], '/rest/foo');

    expect(response.ok).toBe(true);
    expect(jiraFetch).toHaveBeenCalledWith(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/foo',
      'token-1',
      undefined
    );
  });

  it('denies locally, without calling jiraFetch, when the grant lacks a required scope', async () => {
    const auth = oauthJsmAuth(context({ grantedScopes: ['read:request:jira-service-management'] }));

    const response = await auth.fetch(
      ['read:request:jira-service-management', 'write:request:jira-service-management'],
      '/rest/foo'
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
    expect(jiraFetch).not.toHaveBeenCalled();
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('write:request:jira-service-management');
  });

  it('proceeds when every required scope is granted', async () => {
    const auth = oauthJsmAuth(
      context({
        grantedScopes: [
          'read:request:jira-service-management',
          'write:request:jira-service-management',
        ],
      })
    );

    const response = await auth.fetch(
      ['read:request:jira-service-management', 'write:request:jira-service-management'],
      '/rest/foo'
    );

    expect(response.ok).toBe(true);
    expect(jiraFetch).toHaveBeenCalledTimes(1);
  });
});

describe('describeJsmAuthFailure', () => {
  it('extracts the message from a local authFailure() body', async () => {
    const response = new Response(JSON.stringify({ message: 'no scope for you' }), { status: 403 });

    expect(await describeJsmAuthFailure(response)).toBe('no scope for you');
  });

  it('falls back to the status code when the body carries no message', async () => {
    const response = new Response('not json', { status: 500 });

    expect(await describeJsmAuthFailure(response)).toBe('JSM API answered 500');
  });
});
