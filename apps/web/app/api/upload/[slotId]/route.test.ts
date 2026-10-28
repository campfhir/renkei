/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The out-of-band upload endpoint. What matters here:
 *
 * - the claim is single-use and indistinguishable on miss (410 for wrong
 *   token, expired, reused, and nonexistent alike),
 * - an oversized body is refused at 413 before the executor ever runs,
 * - the executor's outcome is written back to the slot row.
 */

jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: jest.fn(() => '') }));
jest.mock('@/lib/upload-executors', () => ({ completeUploadSlot: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { hashUploadToken } from '@/lib/mcp-tools/upload-slots';
import { GET, POST } from './route';

const { completeUploadSlot: mockCompleteUploadSlot } = jest.requireMock<{
  completeUploadSlot: jest.Mock;
}>('@/lib/upload-executors');

const SLOT_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'token-abc';

let store: ReturnType<typeof createMemoryDataStore>;

/** A memory store holding one slot, minted for TOKEN. */
async function seedSlot(extra: Record<string, unknown> = {}): Promise<void> {
  await store.seed({
    upload_slots: [
      {
        id: SLOT_ID,
        token_hash: hashUploadToken(TOKEN),
        subject: 'subject-1',
        account_id: 'acct-1',
        kind: 'jira-attachment',
        destination: { issueKey: 'PROJ-1' },
        filename: 'report.pdf',
        content_type: 'application/pdf',
        max_bytes: 1024,
        expires_at: new Date(Date.now() + 60_000),
        status: 'pending',
        result: null,
        completed_at: null,
        created_at: new Date(),
        ...extra,
      },
    ],
  });
}

function post(body: BodyInit | null, token?: string): Promise<Response> {
  return POST(
    new NextRequest(`https://renkei.example/api/upload/${SLOT_ID}`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    }),
    { params: Promise.resolve({ slotId: SLOT_ID }) }
  );
}

function get(): Promise<Response> {
  return GET(new NextRequest(`https://renkei.example/api/upload/${SLOT_ID}`), {
    params: Promise.resolve({ slotId: SLOT_ID }),
  });
}

beforeEach(() => {
  store = createMemoryDataStore();
  registerDataStore(store);
  mockCompleteUploadSlot.mockReset();
});

afterAll(() => {
  resetDataStore();
});

describe('POST /api/upload/[slotId]', () => {
  it('requires the bearer token in the Authorization header', async () => {
    await seedSlot();
    const response = await post('bytes');
    expect(response.status).toBe(401);
    expect(mockCompleteUploadSlot).not.toHaveBeenCalled();
    expect((await store.uploadSlots.get(SLOT_ID))?.status).toBe('pending');
  });

  it('answers 410 for wrong token / expired / reused / missing alike', async () => {
    const wrong = await post('bytes', 'wrong-token');
    await seedSlot({ expires_at: new Date(Date.now() - 1_000) });
    const expired = await post('bytes', TOKEN);
    for (const response of [wrong, expired]) {
      expect(response.status).toBe(410);
      const body = (await response.json()) as { detail: string };
      // One message on purpose — the reasons are indistinguishable.
      expect(body.detail).toContain('wrong token, expired, or already used');
    }
    expect(mockCompleteUploadSlot).not.toHaveBeenCalled();
  });

  it('claims with the token, once: a second POST is refused', async () => {
    await seedSlot();
    mockCompleteUploadSlot.mockResolvedValue({ ok: true, detail: 'done' });
    expect((await post('bytes', 'not-the-token')).status).toBe(410);
    expect((await post('bytes', TOKEN)).status).toBe(200);
    expect((await post('bytes', TOKEN)).status).toBe(410);
    expect(mockCompleteUploadSlot).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized body at 413 before the executor runs', async () => {
    await seedSlot({ max_bytes: 10 });

    const response = await post(Buffer.alloc(32), TOKEN);

    expect(response.status).toBe(413);
    expect(mockCompleteUploadSlot).not.toHaveBeenCalled();
    const slot = await store.uploadSlots.get(SLOT_ID);
    expect(slot?.status).toBe('failed');
    expect(slot?.result).toContain('10-byte limit');
  });

  it('hands the bytes to completeUploadSlot and reports its outcome', async () => {
    await seedSlot();
    mockCompleteUploadSlot.mockResolvedValue({
      ok: true,
      detail: 'Attached "report.pdf" to PROJ-1.',
    });

    const response = await post(Buffer.from('file-bytes'), TOKEN);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(true);
    expect(body.detail).toContain('PROJ-1');
    const [claimed, bytes] = mockCompleteUploadSlot.mock.calls[0] as [
      { id: string; destination: unknown; max_bytes: number },
      Buffer,
    ];
    expect(claimed.id).toBe(SLOT_ID);
    expect(claimed.destination).toEqual({ issueKey: 'PROJ-1' });
    expect(claimed.max_bytes).toBe(1024);
    expect(Buffer.from(bytes).toString()).toBe('file-bytes');
  });

  it('answers 502 when completeUploadSlot reports a failed outcome', async () => {
    await seedSlot();
    mockCompleteUploadSlot.mockResolvedValue({ ok: false, detail: 'Jira said no.' });

    const response = await post(Buffer.from('file-bytes'), TOKEN);

    expect(response.status).toBe(502);
    const body = (await response.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toBe('Jira said no.');
  });
});

describe('GET /api/upload/[slotId]', () => {
  it('serves the upload page for a pending slot', async () => {
    await seedSlot();

    const response = await get();

    const html = await response.text();
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('report.pdf');
    expect(html).toContain('type="file"');
    // The page lifts the token from the fragment — never from a query param.
    expect(html).toContain('location.hash');
  });

  it('explains a used slot without offering an upload control', async () => {
    await seedSlot({ status: 'completed' });

    const html = await (await get()).text();
    expect(html).toContain('already completed');
    expect(html).not.toContain('type="file"');
  });

  it('explains a missing slot without offering an upload control', async () => {
    const html = await (await get()).text();
    expect(html).toContain('not found');
    expect(html).not.toContain('type="file"');
  });
});
