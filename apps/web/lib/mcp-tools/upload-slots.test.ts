/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Upload slots: the token must exist only in the returned instructions —
 * the row keeps its sha256 — and the status tool must scope by tenant AND
 * subject so a foreign upload id reads as nonexistent.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: jest.fn(() => '') }));

import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from './common';
import { createUploadSlot, hashUploadToken, registerUploadStatusTool } from './upload-slots';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getPublicBaseUrl: mockGetPublicBaseUrl } = jest.requireMock<{
  getPublicBaseUrl: jest.Mock;
}>('@renkei/settings');

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

interface Recorded {
  inserted: Record<string, unknown> | null;
  filters: Array<[string, string, unknown]>;
}

/** Minimal Kysely stand-in recording the insert and the select's filters. */
function stubDb(selectRow: Record<string, unknown> | undefined): Recorded {
  const recorded: Recorded = { inserted: null, filters: [] };
  const selectChain = {
    select: () => selectChain,
    where(column: string, op: string, value: unknown) {
      recorded.filters.push([column, op, value]);
      return selectChain;
    },
    executeTakeFirst: async () => selectRow,
  };
  const db = {
    insertInto: () => ({
      values(values: Record<string, unknown>) {
        recorded.inserted = values;
        return { execute: async () => [] };
      },
    }),
    selectFrom: () => selectChain,
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return recorded;
}

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    subject: 'subject-1',
    origin: 'https://renkei.example',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
    ...overrides,
  }) as unknown as MCPToolContext;

beforeEach(() => {
  mockGetDatabase.mockReset();
  mockGetPublicBaseUrl.mockReset();
  mockGetPublicBaseUrl.mockReturnValue('');
});

describe('createUploadSlot', () => {
  it('stores only the sha256 of the token and hands both byte paths back', async () => {
    const recorded = stubDb(undefined);

    const slot = await createUploadSlot(
      context(),
      'jira-attachment',
      { issueKey: 'PROJ-1' },
      { filename: 'report.pdf', contentType: 'application/pdf' }
    );

    if (!slot.ok) throw new Error(slot.error);
    const inserted = recorded.inserted;
    if (!inserted) throw new Error('nothing was inserted');

    // The bearer appears once in the curl line and once in the fragment link.
    const tokenMatch = /Bearer ([A-Za-z0-9_-]+)'/.exec(slot.instructions);
    if (!tokenMatch) throw new Error('instructions carry no bearer token');
    const token = tokenMatch[1]!;
    expect(inserted.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(String(inserted.token_hash)).not.toBe(token);
    expect(slot.instructions).not.toContain(String(inserted.token_hash));

    expect(inserted.id).toBe(slot.uploadId);
    expect(inserted.kind).toBe('jira-attachment');
    expect(inserted.destination).toBe(JSON.stringify({ issueKey: 'PROJ-1' }));
    expect(inserted.tenant_id).toBe('tenant-1');
    expect(inserted.subject).toBe('subject-1');

    expect(slot.instructions).toContain(
      `https://renkei.example/api/upload/${slot.uploadId}#${token}`
    );
    expect(slot.instructions).toContain('curl -sS -X POST --data-binary');
    expect(slot.instructions).toContain('check_file_upload');
  });

  it('refuses to mint without a signed-in subject', async () => {
    stubDb(undefined);
    const slot = await createUploadSlot(
      context({ subject: undefined }),
      'jira-attachment',
      { issueKey: 'PROJ-1' },
      { filename: 'report.pdf' }
    );
    expect(slot.ok).toBe(false);
  });

  it('refuses to mint when no public base URL is known', async () => {
    stubDb(undefined);
    const slot = await createUploadSlot(
      context({ origin: undefined }),
      'jira-attachment',
      { issueKey: 'PROJ-1' },
      { filename: 'report.pdf' }
    );
    if (slot.ok) throw new Error('expected a failure');
    expect(slot.error).toContain('PUBLIC_BASE_URL');
  });

  it('hashUploadToken is plain sha256 hex — what the route recomputes', () => {
    expect(hashUploadToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});

describe('check_file_upload', () => {
  async function statusHandler(): Promise<ToolHandler> {
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _def: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerUploadStatusTool(server, context());
    const handler = handlers.get('check_file_upload');
    if (!handler) throw new Error('check_file_upload was not registered');
    return handler;
  }

  it('scopes the lookup by tenant AND subject, and a miss reads as nonexistent', async () => {
    const recorded = stubDb(undefined);
    const handler = await statusHandler();

    const result = await handler({ uploadId: '00000000-0000-4000-8000-000000000001' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('No such upload.');
    expect(recorded.filters).toContainEqual(['tenant_id', '=', 'tenant-1']);
    expect(recorded.filters).toContainEqual(['subject', '=', 'subject-1']);
  });

  it('reports a completed slot with its destination outcome', async () => {
    stubDb({
      id: 'upload-1',
      kind: 'jira-attachment',
      filename: 'report.pdf',
      status: 'completed',
      result: 'Attached "report.pdf" to PROJ-1.',
      expires_at: new Date(Date.now() + 60_000),
      completed_at: new Date(),
    });
    const handler = await statusHandler();

    const result = await handler({ uploadId: '00000000-0000-4000-8000-000000000001' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('completed');
    expect(result.content[0]?.text).toContain('Attached "report.pdf" to PROJ-1.');
  });

  it('reports a pending slot past its expiry as expired', async () => {
    stubDb({
      id: 'upload-1',
      kind: 'jira-attachment',
      filename: 'report.pdf',
      status: 'pending',
      result: null,
      expires_at: new Date(Date.now() - 60_000),
      completed_at: null,
    });
    const handler = await statusHandler();

    const result = await handler({ uploadId: '00000000-0000-4000-8000-000000000001' });

    expect(result.content[0]?.text).toContain('expired');
  });
});
