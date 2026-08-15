/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * WebEx, with no sandbox to test against.
 *
 * There is no WebEx equivalent of the personal API token that makes
 * jira-service-management/ops.integration.test.ts possible — Cisco's OAuth
 * app has no PAT-style credential a script can hold. Until a sandbox WebEx
 * account exists (a stored OAuth credential this suite could inject the same
 * way ops.integration.test.ts injects patJsmOpsAuth — see webex-auth.ts's
 * docblock), there is nothing to run a REAL integration test against.
 *
 * What IS testable without one: that `deniedWebexAuth` — every call refused,
 * on purpose — drives the ACTUAL registered tool handlers (the same closures
 * registry.ts wires up in production, via the same registerWebexUserTools
 * this suite calls directly) to a clean errText(), never a thrown exception,
 * a garbled message, or a wrong isError. That is a real regression this
 * suite catches: a handler that skipped the `if (!response.ok)` check and
 * tried to read a field off a denied Response's body would crash here.
 *
 * This is a normal `pnpm test` suite, not `pnpm test:integration` — it needs
 * no credentials and no network, so there's no reason to gate it behind the
 * lane that does.
 */

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: false, error: 'no db in this suite' }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerWebexUserTools } from './index';
import { deniedWebexAuth } from './webex-auth';
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
  await registerWebexUserTools(server, context(), deniedWebexAuth());
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

/** One plausible call per tool — enough to reach its auth.fetch(), never a live API. */
const CALLS: { tool: string; args: Record<string, unknown> }[] = [
  { tool: 'webex_list_rooms', args: {} },
  { tool: 'webex_list_messages', args: { roomId: 'room-1' } },
  { tool: 'webex_get_message', args: { messageId: 'msg-1' } },
  { tool: 'webex_capture_message', args: { messageId: 'msg-1' } },
  { tool: 'webex_send_message', args: { roomId: 'room-1', markdown: 'hi' } },
  { tool: 'webex_list_meetings', args: {} },
  { tool: 'webex_list_transcripts', args: {} },
  { tool: 'webex_get_transcript', args: { transcriptId: 'tr-1' } },
  { tool: 'webex_list_recordings', args: {} },
];

describe('every WebEx tool, against a denied credential', () => {
  it('covers every tool registerWebexUserTools actually registers', async () => {
    // A guard on the list above, not on the tools: a new tool added to
    // index.ts and not added to CALLS would otherwise go unchecked here
    // with nothing failing to say so.
    const registered = [...(await tools()).keys()].sort();
    expect(CALLS.map((c) => c.tool).sort()).toEqual(registered);
  });

  it.each(CALLS)('$tool fails cleanly, not by throwing', async ({ tool, args }) => {
    const handler = (await tools()).get(tool)!;

    const result = await handler(args);

    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
    expect(textOf(result)).not.toContain('undefined');
    expect(textOf(result)).not.toContain('[object Object]');
  });

  it('names the actual reason, not a bare status code', async () => {
    const result = await (await tools()).get('webex_list_rooms')!({});

    expect(textOf(result)).toContain('No WebEx test credential is configured');
  });
});
