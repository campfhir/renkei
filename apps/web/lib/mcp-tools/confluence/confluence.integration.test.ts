/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Confluence page tools, against a REAL Atlassian sandbox.
 *
 * Proves the DI conversion end to end: that `patConfluenceAuth` — a
 * personal API token, Basic auth — actually authenticates through
 * client.ts's real `confluenceRequest` (which now sends `access.authHeader`
 * rather than a hardcoded `Bearer ${accessToken}`), and that the real
 * registered `confluence_*` page tools work unmodified against it. Nothing
 * here mocks confluence/client.ts or confluence/pages.ts — a bug in either
 * fails this exactly as it would in production.
 *
 * Confirmed directly against the sandbox before writing this file: Basic
 * auth works on both the bare `/wiki/api/v2/...` path and the
 * `api.atlassian.com/ex/confluence/{cloudId}/wiki/...` gateway (unlike JSM
 * Ops, there is no gateway-vs-bare-base trap for Confluence) — but a
 * personal token does NOT work as a Bearer token (404 on both paths), which
 * is why ConfluenceAccess carries a full `authHeader` now instead of
 * client.ts assuming Bearer.
 *
 * The sandbox's Confluence product had zero spaces on it (confirmed via
 * probe) — so unlike ops.integration.test.ts's fixture-schedule-in-an-
 * existing-product setup, this suite creates its own disposable SPACE first
 * (via client.ts's confluencePost, hitting the v1 `/rest/api/space` — the
 * v2 API has no space-create endpoint), then a page inside it, and deletes
 * the space in afterAll. Space deletion is Confluence's own long-running
 * async job; this suite fires it and does not wait for it to finish
 * draining — matching how ops.integration.test.ts treats fixture teardown
 * as best-effort.
 *
 * Needs TEST_JIRA_USER_NAME, TEST_JIRA_API_TOKEN and
 * TEST_JIRA_SANDBOX_API_BASE_URL in .env.development; run with
 * `pnpm test:integration`. Skips itself, rather than failing, when those are
 * absent — `pnpm test` never depends on this file.
 */

// pages.ts imports withPresentationHint from ../common, which transitively
// imports @renkei/db for OTHER exports this file never touches — and
// @renkei/db imports kysely, which ships ESM-only and jest's CJS runtime
// cannot parse. Same guard ops.integration.test.ts uses.
jest.mock('kysely', () => ({ sql: () => ({}) }));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerPageTools } from './pages';
import { confluencePost, confluenceDelete } from './client';
import type { ConfluenceAuth } from './confluence-auth';
import type { MCPToolContext } from '../common';
import {
  sandboxCredentials,
  resolveCloudId,
  resolveOwnAccountId,
  patConfluenceAuth,
  type SandboxCredentials,
} from '../test-support/atlassian-sandbox';

jest.setTimeout(30_000);

const creds = sandboxCredentials();

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

async function toolsOf(
  context: MCPToolContext,
  auth: ConfluenceAuth
): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerPageTools(server, context, auth);
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

// Named so a skip shows WHY in test output, not just that it happened.
const SUITE_NAME = creds
  ? 'Confluence page tools (sandbox integration)'
  : 'Confluence page tools (sandbox integration) — SKIPPED: set TEST_JIRA_USER_NAME, ' +
    'TEST_JIRA_API_TOKEN and TEST_JIRA_SANDBOX_API_BASE_URL in .env.development';
const describeOrSkip = creds ? describe : describe.skip;

describeOrSkip(SUITE_NAME, () => {
  let auth: ConfluenceAuth;
  let context: MCPToolContext;
  let spaceKey: string;
  let spaceId: string;
  let tools: Map<string, Handler>;

  beforeAll(async () => {
    if (!creds) throw new Error('unreachable — suite should have skipped');
    const testCreds: SandboxCredentials = creds;
    const cloudId = await resolveCloudId(testCreds);
    const myAccountId = await resolveOwnAccountId(testCreds);
    auth = patConfluenceAuth(testCreds, cloudId, myAccountId);

    // tenantId/subject are log context only — auth carries everything
    // HTTP-related.
    context = {
      tenantId: 'integration-test',
      subject: 'integration-test',
    } as unknown as MCPToolContext;

    const access = await auth.resolve();
    if (typeof access === 'string')
      throw new Error(`patConfluenceAuth could not resolve: ${access}`);

    spaceKey = `RKIT${Date.now()}`;
    const space = await confluencePost(context, access, '/rest/api/space', {
      key: spaceKey,
      name: 'Renkei integration test space',
      description: {
        plain: {
          value: 'disposable — created by confluence.integration.test.ts',
          representation: 'plain',
        },
      },
    });
    if (!space.ok || !space.body) {
      throw new Error(`Could not create the fixture space: ${!space.ok ? space.error : 'no body'}`);
    }
    const id = space.body.id;
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new Error(`Fixture space response carried no id: ${JSON.stringify(space.body)}`);
    }
    spaceId = String(id);

    tools = await toolsOf(context, auth);
  });

  afterAll(async () => {
    if (!auth || !spaceKey) return;
    const access = await auth.resolve();
    if (typeof access === 'string') return;
    const result = await confluenceDelete(context, access, `/rest/api/space/${spaceKey}`);
    if (!result.ok) {
      throw new Error(
        `Could not delete fixture space ${spaceKey}: ${result.error}. It is left behind in the sandbox — remove it manually.`
      );
    }
  });

  describe('confluence_create_page', () => {
    it('creates a real page through Basic-auth PAT credentials', async () => {
      const result = await tools.get('confluence_create_page')!({
        spaceId,
        title: 'Renkei integration test page',
        markdown: 'Hello from **confluence.integration.test.ts**.',
      });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('Created "Renkei integration test page"');
    });
  });

  describe('confluence_get_page / confluence_update_page — the lifecycle this id feeds', () => {
    let pageId: string;

    beforeAll(async () => {
      const created = await tools.get('confluence_create_page')!({
        spaceId,
        title: 'Renkei lifecycle test page',
        markdown: 'Original content.',
      });
      const match = /\(id (\S+)\)/.exec(textOf(created));
      pageId = match?.[1] ?? '';
      expect(pageId).not.toBe('');
    });

    it('reads back the page it just created, content and all', async () => {
      const result = await tools.get('confluence_get_page')!({ pageId });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('Renkei lifecycle test page');
      expect(textOf(result)).toContain('Original content.');
    });

    it('replaces the body and bumps the version', async () => {
      const result = await tools.get('confluence_update_page')!({
        pageId,
        markdown: 'Replaced content.',
      });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('v2');

      const reread = await tools.get('confluence_get_page')!({ pageId });
      expect(textOf(reread)).toContain('Replaced content.');
      expect(textOf(reread)).not.toContain('Original content.');
    });

    it('moves the page to Trash, then purges it permanently', async () => {
      const trashed = await tools.get('confluence_delete_page')!({ pageId });
      expect(trashed.isError).not.toBe(true);
      expect(textOf(trashed)).toContain('Trash');

      const purged = await tools.get('confluence_delete_page')!({ pageId, purge: true });
      expect(purged.isError).not.toBe(true);
      expect(textOf(purged)).toContain('permanently deleted');
    });
  });
});
