/**
 * The drive ACL verifier. Every test here is really the same question asked
 * from a different angle: does anything OTHER than an affirmative 200 from
 * Graph, asked with the caller's own token, ever result in disclosure?
 */

import { createSharepointAccessVerifier } from './drive-verifier';
import { GRAPH_BASE_URL } from './client';
import type { SourceRef } from '@renkei/gates';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A $batch envelope: Graph answers 200 even when sub-requests fail. */
function batchResponse(statuses: number[]): Response {
  return jsonResponse(200, {
    responses: statuses.map((status, index) => ({ id: String(index), status })),
  });
}

const ref = (refId: string): SourceRef => ({ provider: 'sharepoint', refId });
const lookup = async () => ({ accessToken: 'caller-token' });

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createSharepointAccessVerifier', () => {
  it('keeps only the refs Graph answered 200 for', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(batchResponse([200, 403]));

    const verifier = createSharepointAccessVerifier(lookup);
    const result = await verifier.verifyAccess('alice@example.com', [
      ref('drive-1/allowed'),
      ref('drive-1/forbidden'),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.map((r) => r.refId)).toEqual(['drive-1/allowed']);
    }
  });

  it('asks with the CALLER’s token — the response is the permission answer', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(batchResponse([200]));

    const verifier = createSharepointAccessVerifier(async () => ({ accessToken: 'alice-token' }));
    await verifier.verifyAccess('alice@example.com', [ref('drive-1/item-1')]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${GRAPH_BASE_URL}/$batch`);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer alice-token');
  });

  it('collapses many chunks of one document into a single sub-request', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(batchResponse([200]));

    const verifier = createSharepointAccessVerifier(lookup);
    const result = await verifier.verifyAccess('alice@example.com', [
      ref('drive-1/item-1#0001'),
      ref('drive-1/item-1#0002'),
      ref('drive-1/item-1#0003'),
    ]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.requests).toHaveLength(1);
    // …and one grant releases every chunk of that document.
    expect(result.ok && result.val).toHaveLength(3);
  });

  it('denies everything when the caller has no Microsoft grant', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    const verifier = createSharepointAccessVerifier(async () => null);
    const result = await verifier.verifyAccess('nograt@example.com', [ref('drive-1/item-1')]);

    expect(result.ok && result.val).toEqual([]);
    // No credential, no disclosure — and no wasted Graph call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies when a lookup throws rather than propagating the failure', async () => {
    const verifier = createSharepointAccessVerifier(async () => {
      throw new Error('token refresh exploded');
    });
    const result = await verifier.verifyAccess('alice@example.com', [ref('drive-1/item-1')]);
    expect(result.ok && result.val).toEqual([]);
  });

  it('denies a batch that fails outright, without failing batches that answered', async () => {
    // 25 distinct documents => two batches (20 + 5). First fails, second answers.
    const refs = Array.from({ length: 25 }, (_, i) => ref(`drive-1/item-${i}`));
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(batchResponse(Array.from({ length: 5 }, () => 200)));

    const verifier = createSharepointAccessVerifier(lookup);
    const result = await verifier.verifyAccess('alice@example.com', refs);

    expect(result.ok).toBe(true);
    // The 20 in the broken batch are unverified, hence denied; the 5 that
    // answered are allowed. One bad batch must not deny a good one.
    if (result.ok) expect(result.val).toHaveLength(5);
  });

  it('never exceeds Graph’s 20-sub-request batch limit', async () => {
    const refs = Array.from({ length: 45 }, (_, i) => ref(`drive-1/item-${i}`));
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => batchResponse(Array.from({ length: 20 }, () => 404)));

    const verifier = createSharepointAccessVerifier(lookup);
    await verifier.verifyAccess('alice@example.com', refs);

    expect(fetchMock).toHaveBeenCalledTimes(3); // 20 + 20 + 5
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String(init?.body));
      expect(body.requests.length).toBeLessThanOrEqual(20);
    }
  });

  it('denies malformed refs without asking Graph about them', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    const verifier = createSharepointAccessVerifier(lookup);
    const result = await verifier.verifyAccess('alice@example.com', [ref('malformed')]);

    expect(result.ok && result.val).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('imposes its own timeout, well inside the gate’s 3s budget', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(batchResponse([200]));

    const verifier = createSharepointAccessVerifier(lookup);
    await verifier.verifyAccess('alice@example.com', [ref('drive-1/item-1')]);

    // Without its own signal this would inherit client.ts's 15s timeout and
    // burn the whole verification budget on one slow batch.
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeDefined();
  });
});
