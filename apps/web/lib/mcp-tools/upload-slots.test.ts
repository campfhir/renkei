/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Upload slots: the token must exist only in the returned instructions —
 * the row keeps its sha256 — and the status tool must scope by
 * subject so a foreign upload id reads as nonexistent. Run against a
 * memory data store.
 */

jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: jest.fn(() => '') }));

import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type NewUploadSlot,
} from '@renkei/db';
import type { MCPToolContext } from './common';
import {
  claimPendingUploadSlotByOwner,
  createUploadSlot,
  hashUploadToken,
  registerUploadStatusTool,
} from './upload-slots';

const { getPublicBaseUrl: mockGetPublicBaseUrl } = jest.requireMock<{
  getPublicBaseUrl: jest.Mock;
}>('@renkei/settings');

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

const UPLOAD = '00000000-0000-4000-8000-000000000001';

function slotRow(fields: Record<string, unknown> = {}) {
  return {
    id: UPLOAD,
    token_hash: 'h',
    subject: 'subject-1',
    account_id: 'acct-1',
    kind: 'jira-attachment',
    destination: JSON.stringify({}),
    filename: 'report.pdf',
    content_type: 'application/pdf',
    max_bytes: 1024,
    expires_at: new Date(Date.now() + 60_000),
    ...fields,
  };
}

let store: ReturnType<typeof createMemoryDataStore>;
let created: NewUploadSlot[];

/** A memory store holding these slots, recording what was created. */
async function withSlots(rows: ReturnType<typeof slotRow>[]): Promise<void> {
  store = createMemoryDataStore();
  await store.seed({ upload_slots: rows });
  created = [];
  registerDataStore({
    ...store,
    uploadSlots: {
      ...store.uploadSlots,
      create: (slot) => {
        created.push(slot);
        return store.uploadSlots.create(slot);
      },
    },
  });
}

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({
    accountId: 'acct-1',
    subject: 'subject-1',
    origin: 'https://renkei.example',
    siteUrl: '',
    apiBaseUrl: '',
    jiraAuth: null,
    maxJqlResults: 100,
    ...overrides,
  }) as unknown as MCPToolContext;

beforeEach(() => {
  mockGetPublicBaseUrl.mockReset();
  mockGetPublicBaseUrl.mockReturnValue('');
});

afterAll(() => {
  resetDataStore();
});

describe('createUploadSlot', () => {
  it('stores only the sha256 of the token and hands both byte paths back', async () => {
    await withSlots([]);

    const slot = await createUploadSlot(
      context(),
      'jira-attachment',
      { issueKey: 'PROJ-1' },
      { filename: 'report.pdf', contentType: 'application/pdf' }
    );

    if (!slot.ok) throw new Error(slot.error);
    const [inserted] = created;
    if (!inserted) throw new Error('nothing was inserted');

    // The bearer appears once in the curl line and once in the fragment link.
    const tokenMatch = /Bearer ([A-Za-z0-9_-]+)'/.exec(slot.instructions);
    if (!tokenMatch) throw new Error('instructions carry no bearer token');
    const token = tokenMatch[1]!;
    expect(inserted.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(inserted.tokenHash).not.toBe(token);
    expect(slot.instructions).not.toContain(inserted.tokenHash);

    const stored = await store.uploadSlots.get(slot.uploadId);
    expect(stored).toMatchObject({
      id: slot.uploadId,
      kind: 'jira-attachment',
      destination: { issueKey: 'PROJ-1' },
      subject: 'subject-1',
      status: 'pending',
    });

    expect(slot.instructions).toContain(
      `https://renkei.example/api/upload/${slot.uploadId}#${token}`
    );
    expect(slot.instructions).toContain('curl -sS -X POST --data-binary');
    expect(slot.instructions).toContain('check_file_upload');
  });

  it('refuses to mint without a signed-in subject', async () => {
    await withSlots([]);
    const slot = await createUploadSlot(
      context({ subject: undefined }),
      'jira-attachment',
      { issueKey: 'PROJ-1' },
      { filename: 'report.pdf' }
    );
    expect(slot.ok).toBe(false);
    expect(created).toEqual([]);
  });

  it('refuses to mint when no public base URL is known', async () => {
    await withSlots([]);
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

  it('scopes the lookup by subject, and a foreign id reads as nonexistent', async () => {
    await withSlots([slotRow({ subject: 'someone-else', status: 'completed', result: 'done' })]);
    const handler = await statusHandler();

    const result = await handler({ uploadId: UPLOAD });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('No such upload.');
  });

  it('reports a completed slot with its destination outcome', async () => {
    await withSlots([
      slotRow({
        status: 'completed',
        result: 'Attached "report.pdf" to PROJ-1.',
        completed_at: new Date(),
      }),
    ]);
    const handler = await statusHandler();

    const result = await handler({ uploadId: UPLOAD });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('completed');
    expect(result.content[0]?.text).toContain('Attached "report.pdf" to PROJ-1.');
  });

  it('reports a pending slot past its expiry as expired', async () => {
    await withSlots([slotRow({ expires_at: new Date(Date.now() - 60_000) })]);
    const handler = await statusHandler();

    const result = await handler({ uploadId: UPLOAD });

    expect(result.content[0]?.text).toContain('expired');
  });
});

describe('claimPendingUploadSlotByOwner', () => {
  it('claims by subject, never by a bearer token', async () => {
    await withSlots([slotRow({ kind: 'onbase-document' })]);

    const claimed = await claimPendingUploadSlotByOwner(context(), UPLOAD);

    if (!claimed.ok) throw new Error(claimed.error);
    expect(claimed.val).toEqual({
      id: UPLOAD,
      subject: 'subject-1',
      account_id: 'acct-1',
      kind: 'onbase-document',
      destination: {},
      filename: 'report.pdf',
      content_type: 'application/pdf',
      max_bytes: 1024,
    });
    expect((await store.uploadSlots.get(UPLOAD))?.status).toBe('completed');
  });

  it('refuses a foreign, expired, or already-used id with one message', async () => {
    for (const row of [
      slotRow({ subject: 'someone-else' }),
      slotRow({ expires_at: new Date(Date.now() - 60_000) }),
      slotRow({ status: 'completed' }),
    ]) {
      await withSlots([row]);
      const claimed = await claimPendingUploadSlotByOwner(context(), UPLOAD);
      if (claimed.ok) throw new Error('expected a failure');
      expect(claimed.error).toContain('No pending upload');
    }
  });

  it('refuses without a signed-in subject', async () => {
    await withSlots([slotRow()]);

    const claimed = await claimPendingUploadSlotByOwner(context({ subject: undefined }), UPLOAD);

    expect(claimed.ok).toBe(false);
    expect((await store.uploadSlots.get(UPLOAD))?.status).toBe('pending');
  });
});
