/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Zoom tools' own rendering and wizard logic, against a stub `ZoomAuth` —
 * uninterested in how auth works, which is zoom-auth.test.ts's job. Mirrors
 * webex/webex.test.ts.
 *
 * zoom_get_transcript and zoom_get_meeting_summary are the documented
 * exception (see index.ts's header): they never touch the stub auth at all,
 * so this file mocks resolveZoomAccess and ZoomClient directly for those two.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
// index.ts's OWN import of withPresentationHint from ../common transitively
// pulls in @renkei/db (via tenant-operations.ts) for an export this file
// never touches — and @renkei/db imports kysely, ESM-only and untransformed
// here. No zoom tool writes to the database (unlike WebEx's capture_message,
// which needs a real DB mock for its own test), so this exists purely to
// short-circuit that chain before it reaches kysely.
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: false, error: 'unused in this suite' }),
}));
// Replaced wholesale, not via requireActual: the real zoom-auth.ts imports
// @renkei/db for OTHER exports this file never touches, and @renkei/db
// imports kysely, which is ESM-only and untransformed here. Only
// resolveZoomAccess is needed — the ZoomClient-exception-path tools call it
// directly (see index.ts); every other tool uses the stubAuth() below and
// never touches this module at all.
jest.mock('./zoom-auth', () => ({
  resolveZoomAccess: jest.fn(async () => ({
    accessToken: 'raw-token',
    email: 'alice@example.com',
  })),
  ZOOM_API_BASE: 'https://api.zoom.us/v2',
}));

const mockGetMeetingTranscript = jest.fn();
const mockDownloadFromUrl = jest.fn();
const mockGetMeetingSummary = jest.fn();
jest.mock('@renkei/connector-zoom', () => ({
  ZoomClient: class {
    getMeetingTranscript = mockGetMeetingTranscript;
    downloadFromUrl = mockDownloadFromUrl;
    getMeetingSummary = mockGetMeetingSummary;
  },
  encodeZoomMeetingId: (id: string) => encodeURIComponent(id),
  vttToText: (vtt: string) => vtt.replace(/^WEBVTT\n\n/, '').trim(),
}));

const mockCall = jest.fn();

import type { McpServer } from '@modelcontextprotocol/server';
import { registerZoomTools, zoomScopeFor } from './index';
import type { ZoomAuth } from './zoom-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

function stubAuth(): ZoomAuth {
  return {
    kind: 'oauth',
    fetch: (_scopes, path, init) => mockCall(path, init),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const context = (): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject: 'subject-1',
  }) as unknown as MCPToolContext;

async function toolsOf(auth: ZoomAuth = stubAuth()): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerZoomTools(server, context(), auth);
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

beforeEach(() => {
  jest.clearAllMocks();
  mockCall.mockResolvedValue(jsonResponse({ meetings: [] }));
});

describe('zoom_list_meetings', () => {
  it('renders meetings with their ids', async () => {
    mockCall.mockResolvedValue(
      jsonResponse({
        meetings: [
          { id: 123, uuid: 'uuid-1', topic: 'Standup', start_time: '2026-08-10T09:00:00Z' },
        ],
      })
    );
    const tools = await toolsOf();

    const text = textOf(await tools.get('zoom_list_meetings')!({}));

    expect(text).toContain('Standup');
    expect(text).toContain('id: 123');
    expect(text).toContain('uuid: uuid-1');
  });
});

describe('zoom_create_meeting', () => {
  it('sends the topic and duration as Zoom expects them', async () => {
    mockCall.mockResolvedValue(jsonResponse({ id: 999, topic: 'Planning', start_time: 't' }));
    const tools = await toolsOf();

    await tools.get('zoom_create_meeting')!({
      topic: 'Planning',
      startTime: '2026-08-20T15:00:00Z',
      durationMinutes: 30,
    });

    const [, init] = mockCall.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ topic: 'Planning', type: 2, duration: 30 });
  });
});

describe('zoom_update_meeting', () => {
  it('refuses an update with nothing to change', async () => {
    const tools = await toolsOf();

    const result = await tools.get('zoom_update_meeting')!({ meetingId: '123' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Nothing to update');
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('a failed call', () => {
  it('surfaces Zoom’s own message, not a bare status', async () => {
    mockCall.mockResolvedValue(
      jsonResponse({ message: 'Meeting does not exist.', code: 3001 }, 404)
    );
    const tools = await toolsOf();

    const result = await tools.get('zoom_get_meeting')!({ meetingId: '123' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Meeting does not exist.');
  });
});

describe('zoom_get_transcript — the ZoomClient exception path', () => {
  it('never calls the injected auth, and still renders a real transcript', async () => {
    mockGetMeetingTranscript.mockResolvedValue({ ok: true, val: { downloadUrl: 'https://x/y' } });
    mockDownloadFromUrl.mockResolvedValue({ ok: true, val: 'WEBVTT\n\nHello there.' });
    const tools = await toolsOf();

    const result = await tools.get('zoom_get_transcript')!({ meetingId: '123' });

    expect(mockCall).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('Hello there.');
  });

  it('reports a missing transcript by name, not a generic failure', async () => {
    mockGetMeetingTranscript.mockResolvedValue({ ok: false, err: { type: 'NOT_FOUND' } });
    const tools = await toolsOf();

    const result = await tools.get('zoom_get_transcript')!({ meetingId: '123' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No transcript for that meeting');
  });
});

describe('zoom_get_meeting_summary — the ZoomClient exception path', () => {
  it('resolves a numeric id to a UUID before asking for the summary', async () => {
    mockCall.mockResolvedValue(jsonResponse({ uuid: 'resolved-uuid' })); // unused by this tool
    mockGetMeetingSummary.mockResolvedValue({
      ok: true,
      val: { summary_title: 'Standup', summary_overview: 'Discussed the sprint.' },
    });
    const tools = await toolsOf();
    const realFetch = global.fetch;
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ uuid: 'resolved-uuid' }), { status: 200 })
    ) as unknown as typeof fetch;

    await tools.get('zoom_get_meeting_summary')!({ meetingId: '123' });

    expect(mockGetMeetingSummary).toHaveBeenCalledWith('resolved-uuid');
    global.fetch = realFetch;
  });
});

describe('zoom_bulk_get_notes', () => {
  it('fetches every note in one call and renders each as a section', async () => {
    mockCall.mockImplementation(async (path: string) => {
      const noteId = decodeURIComponent(path.split('/notes/')[1]?.split('/')[0] ?? '');
      return jsonResponse({
        note_name: `Notes for ${noteId}`,
        manual_note_content: `manual ${noteId}`,
        generated_note_content: `recap ${noteId}`,
      });
    });
    const tools = await toolsOf();

    const result = await tools.get('zoom_bulk_get_notes')!({ noteIds: ['n-1', 'n-2', 'n-3'] });

    const text = textOf(result);
    expect(text).toContain('3 note(s)');
    for (const id of ['n-1', 'n-2', 'n-3']) {
      expect(text).toContain(`Notes for ${id}`);
      expect(text).toContain(`manual ${id}`);
      expect(text).toContain(`recap ${id}`);
    }
    expect(mockCall).toHaveBeenCalledTimes(3);
  });

  it('reports per-note failures without failing the whole batch', async () => {
    mockCall.mockImplementation(async (path: string) =>
      path.includes('n-bad')
        ? jsonResponse({ message: 'not found' }, 404)
        : jsonResponse({ note_name: 'Good note', generated_note_content: 'recap' })
    );
    const tools = await toolsOf();

    const result = await tools.get('zoom_bulk_get_notes')!({ noteIds: ['n-ok', 'n-bad'] });

    const text = textOf(result);
    expect(text).toContain('Good note');
    expect(text).toContain('1 could not be fetched');
    expect(text).toContain('Could not fetch');
    expect(result.isError).not.toBe(true);
  });

  it('deduplicates ids before fetching', async () => {
    mockCall.mockResolvedValue(jsonResponse({ note_name: 'One', generated_note_content: 'x' }));
    const tools = await toolsOf();

    await tools.get('zoom_bulk_get_notes')!({ noteIds: ['n-1', 'n-1', 'n-1'] });

    expect(mockCall).toHaveBeenCalledTimes(1);
  });
});

describe('zoomScopeFor', () => {
  it('gives each acting tool its own scope, not a shared default', () => {
    expect(zoomScopeFor('zoom_create_meeting')).toEqual(['meeting:write:meeting']);
    expect(zoomScopeFor('zoom_delete_meeting')).toEqual(['meeting:delete:meeting']);
  });

  it('falls back to a read-only default for anything unmapped', () => {
    expect(zoomScopeFor('zoom_totally_unknown_tool')).toEqual(['user:read:user']);
  });
});
