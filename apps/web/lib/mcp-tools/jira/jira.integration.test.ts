/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Plain Jira tools (projects, issues, comments) against a REAL Atlassian
 * sandbox.
 *
 * Proves the DI conversion end to end: that `patJiraAuth` — a personal API
 * token, Basic auth, against the SAME gateway URL
 * (api.atlassian.com/ex/jira/{cloudId}) production's `oauthJiraAuth` builds —
 * actually authenticates, and that the real registered `jira_*` tools work
 * unmodified against it. Nothing here mocks read.ts/write.ts/project.ts or
 * ../common — a bug in either fails this exactly as it would in production.
 *
 * Confirmed directly against the sandbox before writing this file: plain
 * Jira sits behind the identical gateway classic JSM does, which already
 * confirmed Basic auth works fine there (unlike Ops's gateway) — nothing new
 * to confirm for auth itself. CHG ("Change Advisory Board") is a plain
 * business project — not a service desk — this credential has create
 * permission on (APT, a candidate business project, does not); its Change
 * Management issue type requires a description alongside summary, confirmed
 * by a create attempt against the real sandbox before writing this test.
 *
 * Needs TEST_JIRA_USER_NAME, TEST_JIRA_API_TOKEN and
 * TEST_JIRA_SANDBOX_API_BASE_URL in .env.development; run with
 * `pnpm test:integration`. Skips itself, rather than failing, when those are
 * absent — `pnpm test` never depends on this file.
 */

// read.ts/write.ts/project.ts import from ../common, which transitively
// imports @renkei/db for OTHER exports this file never touches — and
// @renkei/db imports kysely, which ships ESM-only and jest's CJS runtime
// cannot parse. Same guard jsm.integration.test.ts and
// confluence.integration.test.ts use.
jest.mock('kysely', () => ({ sql: () => ({}) }));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerReadTools } from './read';
import { registerProjectTools } from './project';
import { registerWriteTools } from './write';
import type { JiraAuth } from './jira-auth';
import type { MCPToolContext } from '../common';
import {
  sandboxCredentials,
  resolveCloudId,
  patJiraAuth,
  type SandboxCredentials,
} from '../test-support/atlassian-sandbox';

jest.setTimeout(30_000);

const creds = sandboxCredentials();

// This sandbox's known-good fixture: a plain business project (not a
// service desk) whose Task issue type needs only project/issuetype/summary,
// confirmed by reading its own issue types before writing this file.
const PROJECT_KEY = 'CHG';
const ISSUE_TYPE = 'Change Management';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

async function toolsOf(context: MCPToolContext, auth: JiraAuth): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerReadTools(server, context, auth);
  await registerProjectTools(server, context, auth);
  await registerWriteTools(server, context, auth);
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

// Named so a skip shows WHY in test output, not just that it happened.
const SUITE_NAME = creds
  ? 'Plain Jira tools (sandbox integration)'
  : 'Plain Jira tools (sandbox integration) — SKIPPED: set TEST_JIRA_USER_NAME, ' +
    'TEST_JIRA_API_TOKEN and TEST_JIRA_SANDBOX_API_BASE_URL in .env.development';
const describeOrSkip = creds ? describe : describe.skip;

describeOrSkip(SUITE_NAME, () => {
  let auth: JiraAuth;
  let tools: Map<string, Handler>;
  let issueKey: string;

  beforeAll(async () => {
    if (!creds) throw new Error('unreachable — suite should have skipped');
    const testCreds: SandboxCredentials = creds;
    const cloudId = await resolveCloudId(testCreds);
    auth = patJiraAuth(testCreds, cloudId);

    // siteUrl/tenantId/accountId are used for logging and the issue link
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
    const result = await tools.get('jira_delete_issue')!({ issueKey });
    if (result.isError) {
      throw new Error(
        `Could not delete fixture issue ${issueKey}: ${textOf(result)}. It is left behind in the sandbox — remove it manually.`
      );
    }
  });

  describe('jira_list_projects', () => {
    it('lists real projects through Basic-auth PAT credentials', async () => {
      const result = await tools.get('jira_list_projects')!({});

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain(`key: ${PROJECT_KEY}`);
    });
  });

  describe('jira_create_issue → jira_get_issue/jira_add_comment/jira_list_transitions', () => {
    beforeAll(async () => {
      const created = await tools.get('jira_create_issue')!({
        projectKey: PROJECT_KEY,
        issueType: ISSUE_TYPE,
        summary: 'Renkei integration test issue',
        description: 'Disposable — created by jira.integration.test.ts',
      });
      const match = /Created issue (\S+)/.exec(textOf(created));
      issueKey = match?.[1] ?? '';
      expect(issueKey).not.toBe('');
    });

    it('reads back the issue it just created', async () => {
      const result = await tools.get('jira_get_issue')!({ issueKey });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain(issueKey);
      expect(textOf(result)).toContain('Renkei integration test issue');
    });

    it('adds a comment that actually lands', async () => {
      const result = await tools.get('jira_add_comment')!({
        issueKey,
        comment: 'Comment from jira.integration.test.ts',
      });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('Comment added');
    });

    it('lists real transitions for the issue', async () => {
      const result = await tools.get('jira_list_transitions')!({ issueKey });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('available transitions');
    });

    it('updates the issue summary', async () => {
      const result = await tools.get('jira_update_issue')!({
        issueKey,
        summary: 'Renkei integration test issue (updated)',
      });

      expect(result.isError).not.toBe(true);
      const reread = await tools.get('jira_get_issue')!({ issueKey });
      expect(textOf(reread)).toContain('Renkei integration test issue (updated)');
    });
  });
});
