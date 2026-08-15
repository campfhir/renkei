/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Classic JSM tools (service desks, requests, comments) against a REAL
 * Atlassian sandbox.
 *
 * Proves the DI conversion end to end: that `patJsmAuth` — a personal API
 * token, Basic auth, against the SAME gateway URL
 * (api.atlassian.com/ex/jira/{cloudId}) production's `oauthJsmAuth` builds —
 * actually authenticates, and that the real registered `jsm_*` tools work
 * unmodified against it. Nothing here mocks jsm.ts or ../common — a bug in
 * either fails this exactly as it would in production.
 *
 * Confirmed directly against the sandbox before writing this file: unlike
 * JSM Ops, this gateway accepts Basic auth fine (no gateway-vs-bare-base
 * trap here) — but a personal token does NOT work as a Bearer token (401),
 * which is why `patJsmAuth` bypasses `jiraFetch` (which always sends
 * `Bearer ${token}`) entirely rather than trying to route Basic auth
 * through it.
 *
 * The sandbox carries real service desk projects (a copy of the org's own
 * Atlassian site) — this suite creates one disposable REQUEST on the
 * "Development" service desk's generic "General Request or Inquiry" type
 * (the only one confirmed to need nothing beyond summary/description) and
 * deletes the underlying issue in afterAll via the plain Jira issue DELETE
 * endpoint — there is no delete-a-request call in the servicedeskapi itself,
 * but every request IS a Jira issue underneath.
 *
 * Needs TEST_JIRA_USER_NAME, TEST_JIRA_API_TOKEN and
 * TEST_JIRA_SANDBOX_API_BASE_URL in .env.development; run with
 * `pnpm test:integration`. Skips itself, rather than failing, when those are
 * absent — `pnpm test` never depends on this file.
 */

// jsm.ts imports withPresentationHint from ../common, which transitively
// imports @renkei/db for OTHER exports this file never touches — and
// @renkei/db imports kysely, which ships ESM-only and jest's CJS runtime
// cannot parse. Same guard ops.integration.test.ts and
// confluence.integration.test.ts use.
jest.mock('kysely', () => ({ sql: () => ({}) }));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerJsmTools } from './jsm';
import type { JsmAuth } from './jsm-auth';
import type { MCPToolContext } from '../common';
import {
  sandboxCredentials,
  resolveCloudId,
  patJsmAuth,
  type SandboxCredentials,
} from '../test-support/atlassian-sandbox';

jest.setTimeout(30_000);

const creds = sandboxCredentials();

// This sandbox's known-good fixture: a service desk (Development) whose
// generic request type needs only summary/description, confirmed by
// reading its own field list before writing this file — every other
// request type on this site's other service desks carries clinical
// custom fields this suite has no business inventing values for.
const SERVICE_DESK_ID = '244';
const REQUEST_TYPE_ID = '1111';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

async function toolsOf(context: MCPToolContext, auth: JsmAuth): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerJsmTools(server, context, auth);
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

async function deleteFixtureIssue(creds: SandboxCredentials, issueKey: string): Promise<void> {
  const authHeader = `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')}`;
  const response = await fetch(`${creds.baseUrl}/rest/api/3/issue/${issueKey}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Could not delete fixture issue ${issueKey}: HTTP ${response.status}. It is left behind in the sandbox — remove it manually.`
    );
  }
}

// Named so a skip shows WHY in test output, not just that it happened.
const SUITE_NAME = creds
  ? 'Classic JSM tools (sandbox integration)'
  : 'Classic JSM tools (sandbox integration) — SKIPPED: set TEST_JIRA_USER_NAME, ' +
    'TEST_JIRA_API_TOKEN and TEST_JIRA_SANDBOX_API_BASE_URL in .env.development';
const describeOrSkip = creds ? describe : describe.skip;

describeOrSkip(SUITE_NAME, () => {
  let auth: JsmAuth;
  let tools: Map<string, Handler>;
  let issueKey: string;

  beforeAll(async () => {
    if (!creds) throw new Error('unreachable — suite should have skipped');
    const testCreds: SandboxCredentials = creds;
    const cloudId = await resolveCloudId(testCreds);
    auth = patJsmAuth(testCreds, cloudId);

    // siteUrl/tenantId/accountId are used for logging and the portal link
    // only — auth carries everything HTTP-related.
    const context = {
      tenantId: 'integration-test',
      accountId: 'integration-test',
      siteUrl: testCreds.baseUrl,
      apiBaseUrl: '',
      accessToken: '',
      maxJqlResults: 100,
    } as unknown as MCPToolContext;
    tools = await toolsOf(context, auth);
  });

  afterAll(async () => {
    if (!creds || !issueKey) return;
    await deleteFixtureIssue(creds, issueKey);
  });

  describe('jsm_list_service_desks', () => {
    it('lists real service desks through Basic-auth PAT credentials', async () => {
      const result = await tools.get('jsm_list_service_desks')!({});

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('serviceDeskId: 244');
    });
  });

  describe('jsm_create_request → jsm_get_request/jsm_add_request_comment/jsm_list_request_transitions', () => {
    beforeAll(async () => {
      const created = await tools.get('jsm_create_request')!({
        serviceDeskId: SERVICE_DESK_ID,
        requestTypeId: REQUEST_TYPE_ID,
        summary: 'Renkei integration test request',
        description: 'disposable — created by jsm.integration.test.ts',
      });
      const match = /Created request (\S+)/.exec(textOf(created));
      issueKey = match?.[1] ?? '';
      expect(issueKey).not.toBe('');
    });

    it('reads back the request it just created', async () => {
      const result = await tools.get('jsm_get_request')!({ issueKey });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain(issueKey);
      expect(textOf(result)).toContain('Renkei integration test request');
    });

    it('adds a comment that actually lands', async () => {
      const result = await tools.get('jsm_add_request_comment')!({
        issueKey,
        comment: 'Comment from jsm.integration.test.ts',
      });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('Comment added');
    });

    it('lists real transitions for the request', async () => {
      const result = await tools.get('jsm_list_request_transitions')!({ issueKey });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('available transitions');
    });
  });
});
