/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Usage tracking.
 *
 * The properties worth pinning are all about NOT interfering: the wrapper
 * must not change what a tool returns, must not swallow a throw, must not
 * fail a call when the database is down, and must never record an argument.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

const inserted: Record<string, unknown>[] = [];
let dbAvailable = true;

jest.mock('@renkei/db', () => ({
  getDatabase: () =>
    dbAvailable
      ? {
          ok: true,
          val: {
            insertInto: () => ({
              values: (row: Record<string, unknown>) => {
                inserted.push(row);
                return { execute: async () => [] };
              },
            }),
          },
        }
      : { ok: false },
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { withUsageTracking } from './usage-tracking';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** The loose shape the tests drive, since the SDK's own overloads are a union. */
type LooseServer = { registerTool: (name: string, config: unknown, handler?: Handler) => void };

function harness() {
  const registered = new Map<string, Handler | undefined>();
  const raw = {
    registerTool: (name: string, _config: unknown, handler?: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const wrapped = withUsageTracking(raw, { tenantId: 'tenant-1', subject: 'subject-1' });
  const server = wrapped as unknown as LooseServer;
  return { server, registered };
}

/** Let the un-awaited insert settle before asserting on it. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  inserted.length = 0;
  dbAvailable = true;
});

describe('withUsageTracking', () => {
  it('records who called what, and how long it took', async () => {
    const { server, registered } = harness();
    server.registerTool('jira_search_issues', {}, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    await registered.get('jira_search_issues')!({ jql: 'project = ENG' });
    await flush();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      tenant_id: 'tenant-1',
      subject: 'subject-1',
      tool: 'jira_search_issues',
      connector: 'jira',
      status: 'ok',
    });
    expect(typeof inserted[0]!.duration_ms).toBe('number');
  });

  it('never records arguments or results', async () => {
    // The whole privacy line: identity and outcome are attributed, content is
    // not recorded at all. A JQL string is content.
    const { server, registered } = harness();
    server.registerTool('jira_search_issues', {}, async () => ({
      content: [{ type: 'text', text: 'SECRET RESULT' }],
    }));

    await registered.get('jira_search_issues')!({ jql: 'assignee = SECRET_PERSON' });
    await flush();

    const serialised = JSON.stringify(inserted[0]);
    expect(serialised).not.toContain('SECRET_PERSON');
    expect(serialised).not.toContain('SECRET RESULT');
    expect(serialised).not.toContain('jql');
  });

  it('reads failure from isError rather than assuming a throw', async () => {
    // MCP handlers signal failure by returning isError, so a status derived
    // only from throws would report every failed call as a success.
    const { server, registered } = harness();
    server.registerTool('outlook_send_mail', {}, async () => ({
      content: [{ type: 'text', text: 'nope' }],
      isError: true,
    }));

    await registered.get('outlook_send_mail')!({});
    await flush();

    expect(inserted[0]).toMatchObject({ status: 'error', connector: 'microsoft' });
  });

  it('keeps a brief error summary on failures, and never on successes', async () => {
    // The caller-facing troubleshooting line: a failure carries the message
    // errText built (collapsed to one line), a success carries NOTHING —
    // successful results are content and stay unrecorded.
    const { server, registered } = harness();
    server.registerTool('sharepoint_read_document', {}, async () => ({
      content: [{ type: 'text', text: 'Could not download\n  "plan.docx".' }],
      isError: true,
    }));
    server.registerTool('sharepoint_get_document', {}, async () => ({
      content: [{ type: 'text', text: 'SECRET CONTENT' }],
    }));

    await registered.get('sharepoint_read_document')!({});
    await registered.get('sharepoint_get_document')!({});
    await flush();

    expect(inserted[0]!.error_summary).toBe('Could not download "plan.docx".');
    expect(inserted[1]!.error_summary).toBeNull();
  });

  it('caps the error summary at the schema limit', async () => {
    const { server, registered } = harness();
    server.registerTool('jira_get_issue', {}, async () => ({
      content: [{ type: 'text', text: 'x'.repeat(2000) }],
      isError: true,
    }));

    await registered.get('jira_get_issue')!({});
    await flush();

    expect(String(inserted[0]!.error_summary)).toHaveLength(500);
  });

  it('records a throw and lets it propagate untouched', async () => {
    const { server, registered } = harness();
    server.registerTool('zoom_get_transcript', {}, async () => {
      throw new Error('boom');
    });

    await expect(registered.get('zoom_get_transcript')!({})).rejects.toThrow('boom');
    await flush();

    // A failure that took ten seconds is the interesting kind.
    expect(inserted[0]).toMatchObject({
      status: 'error',
      tool: 'zoom_get_transcript',
      // The thrown message is the only trace a crash leaves; without it the
      // row says "failed" and nothing else.
      error_summary: 'boom',
    });
  });

  it('returns the handler’s own result unchanged', async () => {
    const { server, registered } = harness();
    const payload = { content: [{ type: 'text', text: 'exact' }], extra: 1 };
    server.registerTool('jira_get_issue', {}, async () => payload);

    expect(await registered.get('jira_get_issue')!({})).toBe(payload);
  });

  it('still runs the tool when the database is unavailable', async () => {
    // Telemetry going down must not take tool calls with it.
    dbAvailable = false;
    const { server, registered } = harness();
    server.registerTool('jira_get_issue', {}, async () => ({ content: [] }));

    await expect(registered.get('jira_get_issue')!({})).resolves.toBeDefined();
    await flush();
    expect(inserted).toHaveLength(0);
  });

  it('passes a registration with no handler straight through', () => {
    const { server, registered } = harness();
    // Registration shapes vary and the wrapper must not assume every one
    // carries a callable — it forwards untouched rather than wrapping
    // undefined in a timer that would throw on first call.
    expect(() => server.registerTool('weird_tool', {})).not.toThrow();
    expect(registered.get('weird_tool')).toBeUndefined();
  });
});

describe('tool-call logging never affects the tool call', () => {
  it('runs the tool and returns its result even when identity lookup explodes', async () => {
    // This file's @renkei/db mock exports no describeActor at all, so the
    // logging path throws on every call — which is exactly the point: a log
    // line must never be able to take a working tool down with it.
    const { server, registered } = harness();
    server.registerTool('jira_get_issue', { title: 'Jira · Read — Get issue' }, async () => ({
      content: [{ type: 'text', text: 'PROJ-1' }],
    }));

    const result = await registered.get('jira_get_issue')!({});
    expect(JSON.stringify(result)).toContain('PROJ-1');
    await flush();
  });
});
