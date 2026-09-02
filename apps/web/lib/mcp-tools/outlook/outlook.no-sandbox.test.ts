/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Outlook, with no sandbox to test against. Mirrors
 * sharepoint/sharepoint.no-sandbox.test.ts and onedrive/onedrive.no-sandbox.
 * test.ts — see those for the full reasoning.
 *
 * Microsoft Graph is delegated-OAuth-only (MSAL), with no personal-token
 * equivalent at all. So there is no real integration test possible here yet;
 * this proves the one thing that IS testable without a sandbox: every
 * registered tool, driven for real through registerOutlookTools, turns a
 * denied credential into a clean errText() rather than crashing.
 *
 * outlook_semantic_search_messages is the one tool that never calls
 * auth.resolve() at all — it searches Renkei's own knowledge index by
 * userEmail, not a live Graph call (see index.ts) — so against `{}` args it
 * fails on "query is required" instead of the denial string every other
 * tool produces. Still isError:true with clean text, so it needs no special
 * case in the loop below; only the "names the actual reason" test picks a
 * tool that actually goes through auth.
 */

// ../common's own import of refreshAtlassianTokenDirect transitively pulls
// in @renkei/db for OTHER exports this suite never touches, and @renkei/db
// imports kysely, which ships ESM-only and jest's CJS runtime cannot parse.
// deniedGraphAuth() denies before any handler reaches a real database call,
// so this mock does nothing useful — it exists purely to keep the module
// graph parseable, same as every other no-sandbox suite in this codebase.
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: false, error: 'no db in this suite' }),
}));
jest.mock('@renkei/connector-microsoft', () => ({
  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
  objectIdOfMicrosoftRefId: (refId: string) => refId,
}));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: async () => null,
  resolveKnowledge: async () => null,
  searchKnowledge: async () => ({ ok: true, val: { hits: [], elided: 0 } }),
}));
jest.mock('../knowledge', () => ({ buildKnowledgeVerifiers: async () => new Map() }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerOutlookTools } from './index';
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
  await registerOutlookTools(server, context(), deniedGraphAuth());
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

/** Every tool registerOutlookTools registers. */
const TOOLS = [
  'outlook_list_mail_folders',
  'outlook_list_messages',
  'outlook_get_message',
  'outlook_list_attachments',
  'outlook_get_attachment',
  'outlook_bulk_list_attachments',
  'outlook_search_messages',
  'outlook_bulk_search_messages',
  'outlook_semantic_search_messages',
  'outlook_list_events',
  'outlook_get_event',
  'outlook_list_task_lists',
  'outlook_list_tasks',
  'outlook_search_users',
  'outlook_get_user',
  'outlook_list_groups',
  'outlook_list_group_members',
  'outlook_send_mail',
  'outlook_reply_message',
  'outlook_reply_all_message',
  'outlook_forward_message',
  'outlook_send_mail_preview',
  'outlook_reply_preview',
  'outlook_reply_all_preview',
  'outlook_forward_preview',
  'outlook_send_draft_confirm',
  'outlook_discard_draft_confirm',
  'outlook_mark_message',
  'outlook_flag_message',
  'outlook_categorize_message',
  'outlook_move_message',
  'outlook_start_bulk_mail_job',
  'outlook_get_bulk_mail_job',
  'outlook_request_draft_attachment_upload',
  'outlook_create_mail_folder',
  'outlook_rename_mail_folder',
  'outlook_delete_mail_folder',
  'outlook_create_event',
  'outlook_find_meeting_times',
  'outlook_respond_event',
  'outlook_cancel_event_preview',
  'outlook_cancel_event_confirm',
];

describe('every Outlook tool, against a denied credential', () => {
  it('covers every tool registerOutlookTools actually registers', async () => {
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
    const result = await (await tools()).get('outlook_list_mail_folders')!({});

    expect(textOf(result)).toContain('No Microsoft test credential is configured');
  });
});
