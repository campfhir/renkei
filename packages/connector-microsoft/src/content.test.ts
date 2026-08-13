/**
 * Drive downloads. The security property under test is narrow and absolute:
 * our bearer token must never be sent to the pre-authenticated URL Graph
 * hands back — it is a different origin carrying its own credential, and
 * Azure blob endpoints reject requests bearing both.
 */

import { graphDownload, DRIVE_CONTENT_MAX_BYTES } from './content';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bytesResponse(bytes: Uint8Array, contentType = 'application/pdf'): Response {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': contentType } });
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  name: 'report.pdf',
  size: 12,
  cTag: 'ctag-v2',
  eTag: 'etag-v9',
  lastModifiedDateTime: '2026-08-12T10:00:00Z',
  '@microsoft.graph.downloadUrl': 'https://cdn.example.test/preauth?token=abc',
  ...over,
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('graphDownload', () => {
  it('never sends the bearer token to the pre-authenticated URL', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, item()))
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([1, 2, 3])));

    const result = await graphDownload('secret-token', 'drive-1', 'item-1');
    expect(result.ok).toBe(true);

    const [graphUrl, graphInit] = fetchMock.mock.calls[0]!;
    expect(String(graphUrl)).toContain('/drives/drive-1/items/item-1');
    expect(new Headers(graphInit?.headers).get('Authorization')).toBe('Bearer secret-token');

    const [cdnUrl, cdnInit] = fetchMock.mock.calls[1]!;
    expect(String(cdnUrl)).toBe('https://cdn.example.test/preauth?token=abc');
    expect(new Headers(cdnInit?.headers).get('Authorization')).toBeNull();
  });

  it('returns the item as Graph reports it NOW, so the caller records the downloaded cTag', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, item({ cTag: 'ctag-v3' })))
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([9])));

    const result = await graphDownload('t', 'drive-1', 'item-1');
    // Persisting a stale cTag would mean skipping a version never indexed.
    expect(result.ok && result.val.item.cTag).toBe('ctag-v3');
  });

  it('refuses an oversized item before transferring anything', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, item({ size: DRIVE_CONTENT_MAX_BYTES + 1 })));

    const result = await graphDownload('t', 'drive-1', 'item-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('CONTENT_TOO_LARGE');
    expect(fetchMock).toHaveBeenCalledTimes(1); // metadata only — no download
  });

  it('aborts a body that outgrows the cap despite a small declared size', async () => {
    // A lying or absent Content-Length must not be able to exhaust the heap.
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, item({ size: 4 })))
      .mockResolvedValueOnce(bytesResponse(new Uint8Array(64)));

    const result = await graphDownload('t', 'drive-1', 'item-1', { maxBytes: 8 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('CONTENT_TOO_LARGE');
  });

  it('follows a 302 by hand when no downloadUrl is offered, still unauthenticated', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, item({ '@microsoft.graph.downloadUrl': undefined })))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://cdn.example.test/x' } })
      )
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([7, 7])));

    const result = await graphDownload('secret-token', 'drive-1', 'item-1');

    expect(result.ok && Array.from(result.val.bytes)).toEqual([7, 7]);
    expect(fetchMock.mock.calls[1]![1]?.redirect).toBe('manual');
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get('Authorization')).toBeNull();
  });

  it('propagates a metadata failure with its status on cause', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(404, {}));

    const result = await graphDownload('t', 'drive-1', 'gone');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.cause).toBe(404);
  });
});
