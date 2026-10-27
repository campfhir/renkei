/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Upload slots: the token must exist only in the returned instructions —
 * the row keeps its sha256 — and the status tool must scope by
 * subject so a foreign upload id reads as nonexistent.
 */

jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: jest.fn(() => '') }));

import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
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

const UPLOAD_ID = '00000000-0000-4000-8000-000000000001';

let store: ReturnType<typeof createMemoryDataStore>;

/** One slot row, as a minted slot leaves it. */
function slotRow(extra: Record<string, unknown> = {}) {
  return {
    id: UPLOAD_ID,
    token_hash: 'hash-1',
    subject: 'subject-1',
    account_id: 'acct-1',
    kind: 'onbase-document',
    destination: JSON.stringify({}),
    filename: 'report.pdf',
    content_type: 'application/pdf',
    max_bytes: 1024,
    expires_at: new Date(Date.now() + 60_000),
    ...extra,
  };
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
  store = createMemoryDataStore();
  registerDataStore(store);
  mockGetPublicBaseUrl.mockReset();
  mockGetPublicBaseUrl.mockReturnValue('');
});

afterAll(() => {
  resetDataStore();
});

describe('createUploadSlot', () => {
  it('stores only the sha256 of the token and hands both byte paths back', async () => {
    const slot = await createUploadSlot(
      context(),
      'jira-attachment',
      { issueKey: 'PROJ-1' },
      { filename: 'report.pdf', contentType: 'application/pdf' }
    );

    if (!slot.ok) throw new Error(slot.error);

    // The bearer appears once in the curl line and once in the fragment link.
    const tokenMatch = /Bearer ([A-Za-z0-9_-]+)'/.exec(slot.instructions);
    if (!tokenMatch) throw new Error('instructions carry no bearer token');
    const token = tokenMatch[1]!;
    const hash = createHash('sha256').update(token).digest('hex');
    expect(slot.instructions).not.toContain(hash);

    // The slot answers to the token's hash, and to nothing else.
    expect(await store.uploadSlots.claim(slot.uploadId, { tokenHash: token })).toBeNull();
    const claimed = await store.uploadSlots.claim(slot.uploadId, { tokenHash: hash });
    expect(claimed).toMatchObject({
      id: slot.uploadId,
      kind: 'jira-attachment',
      destination: { issueKey: 'PROJ-1' },
      subject: 'subject-1',
      accountId: 'acct-1',
      contentType: 'application/pdf',
    });

    expect(slot.instructions).toContain(
      `https://renkei.example/api/upload/${slot.uploadId}#${token}`
    );
    expect(slot.instructions).toContain('curl -sS -X POST --data-binary');
    expect(slot.instructions).toContain('check_file_upload');
  });

  it('refuses to mint without a signed-in subject', async () => {
    const slot = await createUploadSlot(
      context({ subject: undefined }),
      'jira-attachment',
      { issueKey: 'PROJ-1' },
      { filename: 'report.pdf' }
    );
    expect(slot.ok).toBe(false);
  });

  it('refuses to mint when no public base URL is known', async () => {
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

  it('a miss, and someone else’s slot, both read as nonexistent', async () => {
    const handler = await statusHandler();
    const missing = await handler({ uploadId: UPLOAD_ID });
    await store.seed({ upload_slots: [slotRow({ subject: 'someone-else' })] });
    const foreign = await handler({ uploadId: UPLOAD_ID });

    for (const result of [missing, foreign]) {
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe('No such upload.');
    }
  });

  it('reports a completed slot with its destination outcome', async () => {
    await store.seed({
      upload_slots: [
        slotRow({
          kind: 'jira-attachment',
          status: 'completed',
          result: 'Attached "report.pdf" to PROJ-1.',
          completed_at: new Date(),
        }),
      ],
    });
    const handler = await statusHandler();

    const result = await handler({ uploadId: UPLOAD_ID });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('completed');
    expect(result.content[0]?.text).toContain('Attached "report.pdf" to PROJ-1.');
  });

  it('reports a pending slot past its expiry as expired', async () => {
    await store.seed({ upload_slots: [slotRow({ expires_at: new Date(Date.now() - 60_000) })] });
    const handler = await statusHandler();

    const result = await handler({ uploadId: UPLOAD_ID });

    expect(result.content[0]?.text).toContain('expired');
  });
});

describe('claimPendingUploadSlotByOwner', () => {
  it('claims by subject, once, never by a bearer token', async () => {
    await store.seed({ upload_slots: [slotRow()] });

    const claimed = await claimPendingUploadSlotByOwner(context(), UPLOAD_ID);

    if (!claimed.ok) throw new Error(claimed.error);
    expect(claimed.val).toEqual({
      id: UPLOAD_ID,
      subject: 'subject-1',
      account_id: 'acct-1',
      kind: 'onbase-document',
      destination: {},
      filename: 'report.pdf',
      content_type: 'application/pdf',
      max_bytes: 1024,
    });
    expect((await store.uploadSlots.get(UPLOAD_ID))?.status).toBe('completed');
    expect((await claimPendingUploadSlotByOwner(context(), UPLOAD_ID)).ok).toBe(false);
  });

  it('refuses a foreign, wrong, expired, or already-used id with one message', async () => {
    await store.seed({
      upload_slots: [slotRow({ subject: 'someone-else' })],
    });

    const claimed = await claimPendingUploadSlotByOwner(context(), UPLOAD_ID);

    expect(claimed.ok).toBe(false);
    if (claimed.ok) throw new Error('expected a failure');
    expect(claimed.error).toContain('No pending upload');
    expect((await store.uploadSlots.get(UPLOAD_ID))?.status).toBe('pending');
  });

  it('refuses without a signed-in subject', async () => {
    await store.seed({ upload_slots: [slotRow()] });

    const claimed = await claimPendingUploadSlotByOwner(context({ subject: undefined }), UPLOAD_ID);

    expect(claimed.ok).toBe(false);
  });
});
