/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Zoom, with no sandbox to test against. Mirrors webex/webex.no-sandbox.test.ts
 * — see that file for the full reasoning on why this exists and what it can
 * and cannot prove without a real credential.
 *
 * Two tools — zoom_get_transcript and zoom_get_meeting_summary — bypass the
 * injected ZoomAuth entirely (see index.ts's header and zoom-auth.ts's for
 * why: ZoomClient has no injectable transport). Under deniedZoomAuth() they
 * still fail cleanly, but via resolveZoomAccess's OWN "not connected"
 * message rather than deniedZoomAuth's — a real, already-existing failure
 * mode, not a gap this suite papers over. @renkei/db is mocked to make that
 * failure deterministic rather than an accidental real connection attempt.
 */

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: false, error: 'no db in this suite' }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerZoomTools } from './index';
import { deniedZoomAuth } from './zoom-auth';
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
  await registerZoomTools(server, context(), deniedZoomAuth());
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

/** One plausible call per tool — enough to reach auth, never a live API. */
const CALLS: { tool: string; args: Record<string, unknown> }[] = [
  { tool: 'zoom_list_meetings', args: {} },
  { tool: 'zoom_get_meeting', args: { meetingId: '123' } },
  {
    tool: 'zoom_create_meeting',
    args: { topic: 'Standup', startTime: '2026-08-20T15:00:00Z', durationMinutes: 15 },
  },
  { tool: 'zoom_update_meeting', args: { meetingId: '123', topic: 'Renamed' } },
  { tool: 'zoom_delete_meeting', args: { meetingId: '123' } },
  { tool: 'zoom_list_recordings', args: {} },
  { tool: 'zoom_get_transcript', args: { meetingId: '123' } },
  { tool: 'zoom_get_meeting_summary', args: { meetingId: '123' } },
  { tool: 'zoom_search_notes', args: {} },
  { tool: 'zoom_list_notes', args: { meetingId: '123' } },
  { tool: 'zoom_get_note', args: { noteId: 'note-1' } },
  { tool: 'zoom_get_doc', args: { fileId: 'file-1' } },
  { tool: 'zoom_create_doc', args: { name: 'Doc', markdown: 'hi' } },
  { tool: 'zoom_append_to_doc', args: { fileId: 'file-1', text: 'more' } },
];

describe('every Zoom tool, against a denied credential', () => {
  it('covers every tool registerZoomTools actually registers', async () => {
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

  it('names the actual reason for a tool routed through ZoomAuth', async () => {
    const result = await (await tools()).get('zoom_list_meetings')!({});

    expect(textOf(result)).toContain('No Zoom test credential is configured');
  });
});
