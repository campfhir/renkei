/**
 * The upload-session runner: chunks are 320KiB-multiples PUT sequentially
 * with correct Content-Range headers and no Authorization header, the final
 * chunk's response body is the created item, and a failed chunk cancels the
 * session (best-effort DELETE) instead of leaving it dangling.
 */

jest.mock('./client', () => ({ graphRequest: jest.fn() }));

import { graphUploadViaSession, UPLOAD_SESSION_CHUNK_BYTES } from './upload-session';

const { graphRequest: graphRequestMock } = jest.requireMock<{ graphRequest: jest.Mock }>(
  './client'
);

function installFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>): void {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  global.fetch = handler as unknown as typeof fetch;
}

interface Put {
  method: string;
  range: string | undefined;
  auth: string | undefined;
  size: number;
}

let puts: Put[] = [];
let deletes = 0;
/** Status served per PUT index; default: 202 for non-final, 201 final. */
let statusFor: (index: number, isFinal: boolean) => number = (_i, isFinal) => (isFinal ? 201 : 202);

beforeEach(() => {
  puts = [];
  deletes = 0;
  statusFor = (_i, isFinal) => (isFinal ? 201 : 202);
  graphRequestMock.mockReset();
  graphRequestMock.mockResolvedValue({ ok: true, val: { uploadUrl: 'https://up.example/session' } });

  installFetch(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      deletes += 1;
      return { ok: true, status: 204, json: async () => ({}) };
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const body = init?.body as Uint8Array;
    puts.push({
      method: init?.method ?? 'GET',
      range: headers['Content-Range'],
      auth: headers.Authorization,
      size: body.byteLength,
    });
    const isFinal = Boolean(headers['Content-Range']?.endsWith(`/${TOTAL}`) &&
      headers['Content-Range']?.includes(`-${TOTAL - 1}/`));
    const status = statusFor(puts.length - 1, isFinal);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ id: 'item-1', name: 'big.bin' }),
    };
  });
});

const TOTAL = UPLOAD_SESSION_CHUNK_BYTES + 1234; // two chunks: one full, one tail

describe('graphUploadViaSession', () => {
  it('PUTs sequential 320KiB-multiple chunks with ranges and no auth header', async () => {
    const bytes = new Uint8Array(TOTAL).fill(7);
    const result = await graphUploadViaSession(
      'token',
      '/drives/d1/items/p1:/big.bin:/createUploadSession',
      { item: {} },
      bytes
    );

    if (!result.ok) throw new Error('expected success');
    expect(result.val.id).toBe('item-1');
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatchObject({
      method: 'PUT',
      range: `bytes 0-${UPLOAD_SESSION_CHUNK_BYTES - 1}/${TOTAL}`,
      size: UPLOAD_SESSION_CHUNK_BYTES,
      auth: undefined,
    });
    expect(puts[1]).toMatchObject({
      range: `bytes ${UPLOAD_SESSION_CHUNK_BYTES}-${TOTAL - 1}/${TOTAL}`,
      size: 1234,
    });
    expect(UPLOAD_SESSION_CHUNK_BYTES % (320 * 1024)).toBe(0);
  });

  it('cancels the session when a chunk fails', async () => {
    statusFor = () => 500;
    const result = await graphUploadViaSession('token', '/path', {}, new Uint8Array(10));
    expect(result.ok).toBe(false);
    expect(deletes).toBe(1);
  });

  it('propagates a session-creation failure', async () => {
    graphRequestMock.mockResolvedValue({ ok: false, err: { message: 'nope' } });
    const result = await graphUploadViaSession('token', '/path', {}, new Uint8Array(10));
    expect(result.ok).toBe(false);
    expect(puts).toHaveLength(0);
  });
});
