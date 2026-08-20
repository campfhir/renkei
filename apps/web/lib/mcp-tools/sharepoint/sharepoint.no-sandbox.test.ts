/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * SharePoint, with no sandbox to test against. Mirrors
 * webex/webex.no-sandbox.test.ts and zoom/zoom.no-sandbox.test.ts — see
 * those for the full reasoning.
 *
 * Microsoft Graph is delegated-OAuth-only (MSAL), with no personal-token
 * equivalent at all — not even the Basic-auth escape hatch Jira's Ops API
 * happened to offer. So there is no real integration test possible here yet;
 * this proves the one thing that IS testable without a sandbox: every
 * registered tool, driven for real through registerSharePointTools, turns a
 * denied credential into a clean errText() rather than crashing.
 */

// watches.ts pulls in content-watches.ts, which imports `sql` from kysely
// directly — ESM-only, unparseable by this suite's CJS runtime. index.ts's
// own import of withPresentationHint from ../common reaches @renkei/db the
// same transitive way every other no-sandbox suite in this codebase does.
// Neither mock does anything useful: deniedGraphAuth() denies before any
// handler reaches a real database call, so both exist purely to keep the
// module graph parseable.
jest.mock('kysely', () => ({ sql: () => ({}) }));
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: false, error: 'no db in this suite' }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerSharePointTools } from './index';
import { deniedGraphAuth } from '../graph/graph-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const context = (): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject: 'subject-1',
  }) as unknown as MCPToolContext;

async function tools(): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerSharePointTools(server, context(), deniedGraphAuth());
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

/**
 * Every tool registerSharePointTools registers. `{}` for every one: auth
 * always resolves first (see index.ts and its constituent files), so this
 * test's own harness — which calls handlers directly and never runs zod
 * validation — never reaches code that would need real arguments.
 */
const TOOLS = [
  // sites.ts
  'sharepoint_find_sites',
  'sharepoint_list_libraries',
  'sharepoint_list_site_navigation',
  // pages.ts
  'sharepoint_list_pages',
  'sharepoint_read_page',
  'sharepoint_create_page',
  'sharepoint_update_page',
  'sharepoint_publish_page',
  'sharepoint_delete_page',
  // metadata.ts
  'sharepoint_get_document_metadata',
  'sharepoint_list_columns',
  'sharepoint_update_document_metadata',
  // watches.ts
  'sharepoint_watch_library',
  'sharepoint_unwatch_library',
  'sharepoint_list_watches',
  // graph/documents.ts, prefix='sharepoint'
  'sharepoint_list_folder',
  'sharepoint_get_document',
  'sharepoint_read_document',
  'sharepoint_download_document',
  'sharepoint_search_documents',
  'sharepoint_create_folder',
  'sharepoint_rename_document',
  'sharepoint_move_document',
  'sharepoint_copy_document',
  'sharepoint_delete_document',
  'sharepoint_request_document_upload',
  'sharepoint_list_document_access',
  'sharepoint_share_document',
  'sharepoint_add_user_to_document',
  'sharepoint_remove_user_from_document',
];

describe('every SharePoint tool, against a denied credential', () => {
  it('covers every tool registerSharePointTools actually registers', async () => {
    const registered = [...(await tools()).keys()].sort();
    expect([...TOOLS].sort()).toEqual(registered);
  });

  it.each(TOOLS)('%s fails cleanly, not by throwing', async (tool) => {
    const handler = (await tools()).get(tool)!;

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
    expect(textOf(result)).not.toContain('undefined');
    expect(textOf(result)).not.toContain('[object Object]');
  });

  it('names the actual reason, not a bare status code', async () => {
    const result = await (await tools()).get('sharepoint_find_sites')!({});

    expect(textOf(result)).toContain('No Microsoft test credential is configured');
  });
});
