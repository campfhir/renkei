/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The bulk mail job pair's contracts: the submit tool takes EXACTLY one
 * selection mode, writes the row + queue message as an atomic-feeling pair
 * (an enqueue failure fails the row rather than leaving a zombie), and the
 * status tool's lookup is scoped by tenant AND subject — a foreign job id
 * reads as nonexistent.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const enqueueMock = jest.fn();
jest.mock('@renkei/queue', () => ({
  webhookEventsQueue: () => ({ producer: { enqueue: enqueueMock } }),
}));
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/connector-microsoft', () => ({ BATCH_CHUNK_SIZE: 20 }));

import { getDatabase } from '@renkei/db';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import { ACT_META_KEY } from '@renkei/tool-outcomes';
import { bulkJobLabel, registerBulkJobTools } from './bulk-jobs';

const getDatabaseMock = getDatabase as jest.Mock;

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

let inserted: Record<string, unknown>[] = [];
let updates: Record<string, unknown>[] = [];
/** What the status lookup sees; the recorded wheres prove the scoping. */
let statusRow: Record<string, unknown> | undefined;
let statusWheres: [string, string, unknown][] = [];

function fakeDb() {
  return {
    insertInto: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { execute: async () => undefined };
      },
    }),
    updateTable: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => ({ execute: async () => undefined }) };
      },
    }),
    selectFrom: () => ({
      selectAll: () => {
        const chain = {
          where: (column: string, op: string, value: unknown) => {
            statusWheres.push([column, op, value]);
            return chain;
          },
          executeTakeFirst: async () => {
            // The fake enforces the same rule as SQL: every predicate must hold.
            if (!statusRow) return undefined;
            for (const [column, , value] of statusWheres) {
              if (statusRow[column] !== value) return undefined;
            }
            return statusRow;
          },
        };
        return chain;
      },
    }),
  };
}

function stubAuth(): GraphAuth {
  return {
    resolve: async () => ({ accessToken: 'token', upn: 'user@example.com', accountId: 'acct-1' }),
  } as unknown as GraphAuth;
}

function tools(): Map<string, ToolHandler> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const context = {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    subject: 'user-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
  } as unknown as MCPToolContext;
  registerBulkJobTools(server, context, stubAuth());
  return registered;
}

const textOf = (result: ToolResult): string => result.content[0]?.text ?? '';

beforeEach(() => {
  jest.clearAllMocks();
  inserted = [];
  updates = [];
  statusRow = undefined;
  statusWheres = [];
  getDatabaseMock.mockReturnValue({ ok: true, val: fakeDb() });
  enqueueMock.mockResolvedValue({ ok: true, val: undefined });
});

describe('outlook_start_bulk_mail_job', () => {
  it('rejects both-or-neither selection modes', async () => {
    const submit = tools().get('outlook_start_bulk_mail_job')!;
    const neither = await submit({ action: 'markRead' });
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toContain('exactly one');

    const both = await submit({
      action: 'markRead',
      messageIds: ['m1'],
      filters: { isRead: false },
    });
    expect(both.isError).toBe(true);
    expect(inserted).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('writes the row and enqueues a bare jobId pointer with a per-mailbox ordering key', async () => {
    const submit = tools().get('outlook_start_bulk_mail_job')!;
    const result = await submit({ action: 'archive', messageIds: ['m1', 'm2'] });

    expect(result.isError).toBeUndefined();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      tenant_id: 'tenant-1',
      subject: 'user-1',
      account_id: 'acct-1',
      action: 'archive',
    });
    const jobId = String(inserted[0].id);
    expect(textOf(result)).toContain(jobId);
    expect(enqueueMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      source: 'mailjobs',
      type: 'bulk-action',
      payload: { jobId },
      orderingKey: 'mailjob:tenant-1:acct-1',
    });
  });

  it('fails the row instead of leaving a zombie when the enqueue fails', async () => {
    enqueueMock.mockResolvedValue({ ok: false, err: { message: 'queue down' } });
    const submit = tools().get('outlook_start_bulk_mail_job')!;
    const result = await submit({ action: 'markRead', messageIds: ['m1'] });

    expect(result.isError).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('failed');
  });

  it('tells the owner what was queued, not that mail was sent', async () => {
    // The notification feed reads this receipt. A job marks, flags, files
    // or archives — "sending" was the wording before, and it was wrong on
    // every one of the five actions.
    const submit = tools().get('outlook_start_bulk_mail_job')!;
    const archive = await submit({
      action: 'archive',
      filters: { folder: 'inbox', from: 'no-reply@example.com', isRead: true },
    });
    expect(archive._meta?.[ACT_META_KEY]).toEqual({
      label: 'Started archiving a batch of email',
    });

    const unread = await submit({ action: 'markRead', isRead: false, messageIds: ['m1'] });
    expect(unread._meta?.[ACT_META_KEY]).toEqual({
      label: 'Started marking a batch of email unread',
    });
  });

  it('words every action, without the selection in the sentence', () => {
    expect(bulkJobLabel('markRead', { isRead: true })).toBe(
      'Started marking a batch of email read'
    );
    expect(bulkJobLabel('flag', {})).toBe('Started flagging a batch of email');
    expect(bulkJobLabel('categorize', {})).toBe('Started categorising a batch of email');
    expect(bulkJobLabel('move', { destinationFolder: 'x' })).toBe(
      'Started filing a batch of email'
    );
    expect(bulkJobLabel('archive', {})).toBe('Started archiving a batch of email');
    for (const action of ['markRead', 'flag', 'categorize', 'move', 'archive']) {
      expect(bulkJobLabel(action, {})).not.toMatch(/send/i);
    }
  });

  it('validates per-action parameters before any I/O', async () => {
    const submit = tools().get('outlook_start_bulk_mail_job')!;
    const move = await submit({ action: 'move', messageIds: ['m1'] });
    expect(move.isError).toBe(true);
    expect(textOf(move)).toContain('destinationFolder');

    const categorize = await submit({ action: 'categorize', messageIds: ['m1'] });
    expect(categorize.isError).toBe(true);
    expect(inserted).toHaveLength(0);
  });
});

describe('outlook_get_bulk_mail_job', () => {
  const JOB_ID = '7a6a5d51-0000-4000-8000-000000000001';

  it('scopes the lookup by tenant AND subject — a foreign job reads as nonexistent', async () => {
    statusRow = {
      id: JOB_ID,
      tenant_id: 'tenant-1',
      subject: 'someone-else',
      action: 'markRead',
      status: 'succeeded',
      total: 3,
      succeeded: 3,
      failed: 0,
      failures: [],
      last_error: null,
      started_at: null,
      finished_at: null,
    };
    const status = tools().get('outlook_get_bulk_mail_job')!;
    const result = await status({ jobId: JOB_ID });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('No such job.');
    expect(statusWheres.map(([column]) => column).sort()).toEqual(['id', 'subject', 'tenant_id']);
  });

  it('renders progress, failures, and a poll hint while running', async () => {
    statusRow = {
      id: JOB_ID,
      tenant_id: 'tenant-1',
      subject: 'user-1',
      action: 'archive',
      status: 'running',
      total: 100,
      succeeded: 40,
      failed: 2,
      failures: [{ id: 'm7', error: 'gone' }],
      last_error: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    const status = tools().get('outlook_get_bulk_mail_job')!;
    const result = await status({ jobId: JOB_ID });

    const text = textOf(result);
    expect(text).toContain('running');
    expect(text).toContain('40 succeeded, 2 failed of 100');
    expect(text).toContain('m7: gone');
    expect(text).toContain('Poll again');
  });
});
