/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The out-of-band upload endpoint. What matters here:
 *
 * - the claim is single-use and indistinguishable on miss (410 for wrong
 *   token, expired, reused, and nonexistent alike),
 * - an oversized body is refused at 413 before the executor ever runs,
 * - the executor's outcome is written back to the slot row.
 */

jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: jest.fn(() => '') }));
jest.mock('@/lib/upload-executors', () => ({ executeUpload: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { NextRequest } from 'next/server';
import { hashUploadToken } from '@/lib/mcp-tools/upload-slots';
import { GET, POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { executeUpload: mockExecuteUpload } = jest.requireMock<{ executeUpload: jest.Mock }>(
  '@/lib/upload-executors'
);

interface Recorded {
  claimFilters: Array<[string, string, unknown]>;
  finishes: Array<Record<string, unknown>>;
}

/**
 * Kysely stand-in for the route's two UPDATE shapes (the conditional claim
 * with .returning(), then the outcome write) plus GET's slot lookup.
 */
function stubDb(
  claim: Record<string, unknown> | undefined,
  selectRow?: Record<string, unknown>
): Recorded {
  const recorded: Recorded = { claimFilters: [], finishes: [] };
  const db = {
    updateTable: () => {
      let values: Record<string, unknown> = {};
      const chain = {
        set(next: Record<string, unknown>) {
          values = next;
          return chain;
        },
        where(column: string, op: string, value: unknown) {
          recorded.claimFilters.push([column, op, value]);
          return chain;
        },
        returning: () => chain,
        executeTakeFirst: async () => claim,
        execute: async () => {
          recorded.finishes.push(values);
          return [];
        },
      };
      return chain;
    },
    selectFrom: () => {
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => selectRow,
      };
      return chain;
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return recorded;
}

const CLAIMED = {
  id: 'slot-1',
  tenant_id: 'tenant-1',
  subject: 'subject-1',
  account_id: 'acct-1',
  kind: 'jira-attachment',
  destination: { issueKey: 'PROJ-1' },
  filename: 'report.pdf',
  content_type: 'application/pdf',
  max_bytes: 1024,
};

function post(body: BodyInit | null, token?: string): Promise<Response> {
  return POST(
    new NextRequest('https://renkei.example/api/upload/slot-1', {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    }),
    { params: Promise.resolve({ slotId: 'slot-1' }) }
  );
}

beforeEach(() => {
  mockGetDatabase.mockReset();
  mockExecuteUpload.mockReset();
});

describe('POST /api/upload/[slotId]', () => {
  it('requires the bearer token in the Authorization header', async () => {
    stubDb(CLAIMED);
    const response = await post('bytes');
    expect(response.status).toBe(401);
    expect(mockExecuteUpload).not.toHaveBeenCalled();
  });

  it('answers 410 for wrong token / expired / reused alike', async () => {
    stubDb(undefined);
    const response = await post('bytes', 'wrong-token');
    expect(response.status).toBe(410);
    const body = (await response.json()) as { detail: string };
    // One message on purpose — the reasons are indistinguishable.
    expect(body.detail).toContain('wrong token, expired, or already used');
    expect(mockExecuteUpload).not.toHaveBeenCalled();
  });

  it('claims with the HASH of the presented token, never the token', async () => {
    const recorded = stubDb(CLAIMED);
    mockExecuteUpload.mockResolvedValue({ ok: true, detail: 'done' });

    await post('bytes', 'token-abc');

    expect(recorded.claimFilters).toContainEqual(['token_hash', '=', hashUploadToken('token-abc')]);
    expect(recorded.claimFilters).toContainEqual(['status', '=', 'pending']);
    expect(
      recorded.claimFilters.some(([, , value]) => value === 'token-abc')
    ).toBe(false);
  });

  it('refuses an oversized body at 413 before the executor runs', async () => {
    const recorded = stubDb({ ...CLAIMED, max_bytes: 10 });

    const response = await post(Buffer.alloc(32), 'token-abc');

    expect(response.status).toBe(413);
    expect(mockExecuteUpload).not.toHaveBeenCalled();
    expect(recorded.finishes[0]?.status).toBe('failed');
  });

  it('hands the bytes to the executor and reports its outcome', async () => {
    const recorded = stubDb(CLAIMED);
    mockExecuteUpload.mockResolvedValue({ ok: true, detail: 'Attached "report.pdf" to PROJ-1.' });

    const response = await post(Buffer.from('file-bytes'), 'token-abc');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(true);
    expect(body.detail).toContain('PROJ-1');
    const [, , bytes] = mockExecuteUpload.mock.calls[0] as [unknown, unknown, Buffer];
    expect(Buffer.from(bytes).toString()).toBe('file-bytes');
    expect(recorded.finishes[0]?.status).toBe('completed');
  });

  it('writes a failed outcome to the slot and answers 502', async () => {
    const recorded = stubDb(CLAIMED);
    mockExecuteUpload.mockResolvedValue({ ok: false, detail: 'Jira said no.' });

    const response = await post(Buffer.from('file-bytes'), 'token-abc');

    expect(response.status).toBe(502);
    expect(recorded.finishes[0]?.status).toBe('failed');
    expect(recorded.finishes[0]?.result).toBe('Jira said no.');
  });
});

describe('GET /api/upload/[slotId]', () => {
  it('serves the upload page for a pending slot', async () => {
    stubDb(undefined, {
      id: 'slot-1',
      filename: 'report.pdf',
      kind: 'jira-attachment',
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000),
    });

    const response = await GET(
      new NextRequest('https://renkei.example/api/upload/slot-1'),
      { params: Promise.resolve({ slotId: 'slot-1' }) }
    );

    const html = await response.text();
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('report.pdf');
    expect(html).toContain('type="file"');
    // The page lifts the token from the fragment — never from a query param.
    expect(html).toContain('location.hash');
  });

  it('explains a missing slot without offering an upload control', async () => {
    stubDb(undefined, undefined);

    const response = await GET(
      new NextRequest('https://renkei.example/api/upload/slot-1'),
      { params: Promise.resolve({ slotId: 'slot-1' }) }
    );

    const html = await response.text();
    expect(html).toContain('not found');
    expect(html).not.toContain('type="file"');
  });
});
