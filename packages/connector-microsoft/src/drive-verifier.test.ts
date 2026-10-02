/**
 * The drive ACL verifier. Every test here is really the same question asked
 * from a different angle: does anything OTHER than an affirmative 200 from
 * Graph, asked through the caller's own grant, ever result in disclosure?
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

function fakeAuth(grantKey = 'grant-caller') {
  const send = jest.fn<Promise<Response>, [string, RequestInit?]>();
  return Object.assign(send, { grantKey });
}

const ref = (refId: string): SourceRef => ({ provider: 'sharepoint', refId });

let auth: ReturnType<typeof fakeAuth>;
const lookup = async () => ({ auth });

beforeEach(() => {
  auth = fakeAuth();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createSharepointAccessVerifier', () => {
  it('keeps only the refs Graph answered 200 for', async () => {
    auth.mockResolvedValue(batchResponse([200, 403]));

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

  it('asks through the CALLER’s grant — the response is the permission answer', async () => {
    const alice = fakeAuth('grant-alice').mockResolvedValue(batchResponse([200]));
    const globalFetch = jest.spyOn(globalThis, 'fetch');

    const verifier = createSharepointAccessVerifier(async () => ({ auth: alice }));
    await verifier.verifyAccess('alice@example.com', [ref('drive-1/item-1')]);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(alice).toHaveBeenCalledTimes(1);
    const [url, init] = alice.mock.calls[0]!;
    expect(url).toBe(`${GRAPH_BASE_URL}/$batch`);
    // The delegate behind the grant attaches the credential; we never do.
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
  });

  it('collapses many chunks of one document into a single sub-request', async () => {
    auth.mockResolvedValue(batchResponse([200]));

    const verifier = createSharepointAccessVerifier(lookup);
    const result = await verifier.verifyAccess('alice@example.com', [
      ref('drive-1/item-1#0001'),
      ref('drive-1/item-1#0002'),
      ref('drive-1/item-1#0003'),
    ]);

    const body = JSON.parse(String(auth.mock.calls[0]![1]?.body));
    expect(body.requests).toHaveLength(1);
    // …and one grant releases every chunk of that document.
    expect(result.ok && result.val).toHaveLength(3);
  });

  it('denies everything when the caller has no Microsoft grant', async () => {
    const globalFetch = jest.spyOn(globalThis, 'fetch');

    const verifier = createSharepointAccessVerifier(async () => null);
    const result = await verifier.verifyAccess('nograt@example.com', [ref('drive-1/item-1')]);

    expect(result.ok && result.val).toEqual([]);
    // No credential, no disclosure — and no wasted Graph call.
    expect(auth).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('denies when a lookup throws rather than propagating the failure', async () => {
    const verifier = createSharepointAccessVerifier(async () => {
      throw new Error('grant lookup exploded');
    });
    const result = await verifier.verifyAccess('alice@example.com', [ref('drive-1/item-1')]);
    expect(result.ok && result.val).toEqual([]);
  });

  it('denies a batch that fails outright, without failing batches that answered', async () => {
    // 25 distinct documents => two batches (20 + 5). First fails, second answers.
    const refs = Array.from({ length: 25 }, (_, i) => ref(`drive-1/item-${i}`));
    auth
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
    auth.mockImplementation(async () => batchResponse(Array.from({ length: 20 }, () => 404)));

    const verifier = createSharepointAccessVerifier(lookup);
    await verifier.verifyAccess('alice@example.com', refs);

    expect(auth).toHaveBeenCalledTimes(3); // 20 + 20 + 5
    for (const [, init] of auth.mock.calls) {
      const body = JSON.parse(String(init?.body));
      expect(body.requests.length).toBeLessThanOrEqual(20);
    }
  });

  it('denies malformed refs without asking Graph about them', async () => {
    const verifier = createSharepointAccessVerifier(lookup);
    const result = await verifier.verifyAccess('alice@example.com', [ref('malformed')]);

    expect(result.ok && result.val).toEqual([]);
    expect(auth).not.toHaveBeenCalled();
  });

  it('imposes its own timeout, well inside the gate’s 3s budget', async () => {
    auth.mockResolvedValue(batchResponse([200]));

    const verifier = createSharepointAccessVerifier(lookup);
    await verifier.verifyAccess('alice@example.com', [ref('drive-1/item-1')]);

    // Without its own signal this would inherit client.ts's 15s timeout and
    // burn the whole verification budget on one slow batch.
    expect(auth.mock.calls[0]![1]?.signal).toBeDefined();
  });
});
