/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The batch engine's load-bearing behavior, ported from the retired web-side
 * bulk tools' suite: Graph's hard 20-per-batch limit, sequential (not
 * concurrent) chunk dispatch so a large action doesn't throttle itself,
 * bounded 429 retries honoring Retry-After, and per-item failure reporting.
 */

// The engine's transport is graphRequest (which carries its own rate
// limiter and timers); stub it here so the tests drive the ENGINE — the
// limiter's token-bucket timers don't survive a collapsed setTimeout.
jest.mock('./client', () => ({
  graphRequest: jest.fn(),
}));

import { graphRequest } from './client';
import { graphBatch, summarizeBatch, withCategoryChanges, BATCH_CHUNK_SIZE } from './mail-batch';

const graphRequestMock = graphRequest as jest.Mock;

interface BatchPost {
  requests: { id: string; method: string; url: string; body?: unknown }[];
}

/** Every $batch payload the engine sent, in dispatch order. */
let batches: BatchPost[] = [];
/** True while a fetch is in flight — proves chunks are not fired concurrently. */
let inFlight = false;
let sawConcurrentCalls = false;
/** Per-item status queue the fake Graph returns, defaulting to 200. */
let statusById: Map<string, number[]> = new Map();

function nextStatusFor(id: string): number {
  const queue = statusById.get(id);
  if (!queue || queue.length === 0) return 200;
  return queue.length === 1 ? (queue[0] ?? 200) : (queue.shift() ?? 200);
}

beforeEach(() => {
  batches = [];
  inFlight = false;
  sawConcurrentCalls = false;
  statusById = new Map();
  jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => {
    // Retry backoff is real time in production; collapse it here so a
    // throttling test doesn't actually sleep for seconds.
    callback();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);

  graphRequestMock.mockReset();
  graphRequestMock.mockImplementation(async (_token: string, _path: string, init?: RequestInit) => {
    if (inFlight) sawConcurrentCalls = true;
    inFlight = true;
    const payload = JSON.parse(String(init?.body ?? '{}')) as BatchPost;
    batches.push(payload);
    const body = {
      responses: (payload.requests ?? []).map((request) => ({
        id: request.id,
        status: nextStatusFor(request.id),
        headers: { 'Retry-After': '1' },
        body: {},
      })),
    };
    await Promise.resolve();
    inFlight = false;
    return { ok: true, val: body };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const ids = (count: number) => Array.from({ length: count }, (_unused, index) => `msg-${index}`);
const markRequests = (count: number) =>
  ids(count).map((id) => ({
    id,
    method: 'PATCH' as const,
    url: `/me/messages/${id}`,
    body: { isRead: true },
  }));

describe('graphBatch', () => {
  it('never puts more than 20 sub-requests in one batch', async () => {
    await graphBatch('token', markRequests(45));
    expect(batches).toHaveLength(3);
    for (const batch of batches)
      expect(batch.requests.length).toBeLessThanOrEqual(BATCH_CHUNK_SIZE);
    expect(batches.flatMap((batch) => batch.requests)).toHaveLength(45);
  });

  it('dispatches chunks sequentially, not all at once', async () => {
    // Concurrent chunks are how a 200-message action throttles itself.
    await graphBatch('token', markRequests(60));
    expect(sawConcurrentCalls).toBe(false);
  });

  it('retries a 429d sub-request and reports it failed after bounded rounds', async () => {
    statusById.set('msg-0', [429, 429, 429, 429, 429]);
    const { results } = await graphBatch('token', markRequests(2));
    const throttled = results.find((result) => result.id === 'msg-0');
    expect(throttled?.ok).toBe(false);
    expect(throttled?.error).toContain('rate limiting');
    expect(results.find((result) => result.id === 'msg-1')?.ok).toBe(true);
    // 1 initial + 3 retry rounds for msg-0, bounded.
    expect(batches.length).toBeLessThanOrEqual(5);
  });

  it('recovers a sub-request that stops being throttled', async () => {
    statusById.set('msg-0', [429, 200]);
    const { results } = await graphBatch('token', markRequests(1));
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  it('reports incremental progress per settled chunk', async () => {
    const progress: number[] = [];
    await graphBatch('token', markRequests(45), {
      onChunk: (settled) => {
        progress.push(settled.length);
      },
    });
    expect(progress).toEqual([20, 20, 5]);
  });

  it('fails every item in a chunk on a transport-level error', async () => {
    graphRequestMock.mockResolvedValue({
      ok: false,
      err: { message: 'Graph API unreachable' },
    });
    const { results } = await graphBatch('token', markRequests(3));
    expect(results).toHaveLength(3);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results[0].error).toContain('unreachable');
  });
});

describe('summarizeBatch', () => {
  it('caps the failure list at 20 lines', () => {
    const results = ids(30).map((id) => ({ id, ok: false, body: null, error: 'nope' }));
    const summary = summarizeBatch(results, 'Marked read');
    expect(summary).toContain('0 of 30 succeeded');
    expect(summary).toContain('…and 10 more.');
  });
});

describe('withCategoryChanges', () => {
  it('merges adds and drops removes, order preserved', () => {
    expect(withCategoryChanges(['a', 'b'], ['c', 'a'], ['b'])).toEqual(['a', 'c']);
  });
});
