/**
 * Drive downloads. The security property under test is narrow and absolute:
 * the grant's credential must never be sent to the pre-authenticated URL
 * Graph hands back — it is a different origin carrying its own credential,
 * and Azure blob endpoints reject requests bearing both. Concretely: Graph
 * calls go through the grant's fetcher, CDN byte fetches go through plain
 * `fetch`, and never the other way round.
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

function fakeAuth() {
  const send = jest.fn<Promise<Response>, [string, RequestInit?]>();
  return Object.assign(send, { grantKey: 'grant-1' });
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
  it('asks Graph through the grant fetcher and the CDN through plain fetch, unauthenticated', async () => {
    const auth = fakeAuth().mockResolvedValueOnce(jsonResponse(200, item()));
    const cdn = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([1, 2, 3])));

    const result = await graphDownload(auth, 'drive-1', 'item-1');
    expect(result.ok).toBe(true);

    expect(auth).toHaveBeenCalledTimes(1);
    const [graphUrl, graphInit] = auth.mock.calls[0]!;
    expect(graphUrl).toContain('/drives/drive-1/items/item-1');
    expect(new Headers(graphInit?.headers).get('Authorization')).toBeNull();

    expect(cdn).toHaveBeenCalledTimes(1);
    const [cdnUrl, cdnInit] = cdn.mock.calls[0]!;
    expect(String(cdnUrl)).toBe('https://cdn.example.test/preauth?token=abc');
    expect(new Headers(cdnInit?.headers).get('Authorization')).toBeNull();
  });

  it('returns the item as Graph reports it NOW, so the caller records the downloaded cTag', async () => {
    const auth = fakeAuth().mockResolvedValueOnce(jsonResponse(200, item({ cTag: 'ctag-v3' })));
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(bytesResponse(new Uint8Array([9])));

    const result = await graphDownload(auth, 'drive-1', 'item-1');
    // Persisting a stale cTag would mean skipping a version never indexed.
    expect(result.ok && result.val.item.cTag).toBe('ctag-v3');
  });

  it('refuses an oversized item before transferring anything', async () => {
    const auth = fakeAuth().mockResolvedValueOnce(
      jsonResponse(200, item({ size: DRIVE_CONTENT_MAX_BYTES + 1 }))
    );
    const cdn = jest.spyOn(globalThis, 'fetch');

    const result = await graphDownload(auth, 'drive-1', 'item-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('CONTENT_TOO_LARGE');
    expect(auth).toHaveBeenCalledTimes(1); // metadata only…
    expect(cdn).not.toHaveBeenCalled(); // …no download
  });

  it('aborts a body that outgrows the cap despite a small declared size', async () => {
    // A lying or absent Content-Length must not be able to exhaust the heap.
    const auth = fakeAuth().mockResolvedValueOnce(jsonResponse(200, item({ size: 4 })));
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(bytesResponse(new Uint8Array(64)));

    const result = await graphDownload(auth, 'drive-1', 'item-1', { maxBytes: 8 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('CONTENT_TOO_LARGE');
  });

  it('follows a 302 by hand when no downloadUrl is offered, still unauthenticated', async () => {
    const auth = fakeAuth()
      .mockResolvedValueOnce(jsonResponse(200, item({ '@microsoft.graph.downloadUrl': undefined })))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://cdn.example.test/x' } })
      );
    const cdn = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([7, 7])));

    const result = await graphDownload(auth, 'drive-1', 'item-1');

    expect(result.ok && Array.from(result.val.bytes)).toEqual([7, 7]);
    // The /content request rides the grant, asks for the 3xx back untouched…
    const [contentUrl, contentInit] = auth.mock.calls[1]!;
    expect(contentUrl).toContain('/drives/drive-1/items/item-1/content');
    expect(contentInit?.redirect).toBe('manual');
    expect(new Headers(contentInit?.headers).get('Authorization')).toBeNull();
    // …and the Location it names is fetched bare, outside the grant.
    expect(cdn).toHaveBeenCalledTimes(1);
    expect(String(cdn.mock.calls[0]![0])).toBe('https://cdn.example.test/x');
    expect(new Headers(cdn.mock.calls[0]![1]?.headers).get('Authorization')).toBeNull();
  });

  it('propagates a metadata failure with its status on cause', async () => {
    const auth = fakeAuth().mockResolvedValueOnce(jsonResponse(404, {}));

    const result = await graphDownload(auth, 'drive-1', 'gone');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.cause).toBe(404);
  });
});
