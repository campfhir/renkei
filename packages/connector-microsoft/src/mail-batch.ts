/**
 * Graph JSON $batch execution for bulk mailbox actions — shared by the web
 * MCP tools (bulk reads) and the worker's mail bulk jobs (writes). Runs many
 * single-message operations as $batch calls instead of one HTTP round trip
 * per message.
 *
 * Chunked at BATCH_CHUNK_SIZE (Graph's hard per-batch limit) and run
 * SEQUENTIALLY on purpose: firing all chunks at once is how a 200-message
 * action turns into 200 simultaneous mailbox operations and earns a 429 for
 * the whole run. Sub-requests that come back throttled (429/503) are retried
 * a few rounds, honoring Retry-After when Graph sends one.
 *
 * A chunk that fails at the transport/auth level (network error, bad token)
 * fails every item in that chunk with the same error; a chunk that succeeds
 * still reports each item's own status, since Graph settles sub-requests
 * independently.
 */

import type { RequestLane } from '@renkei/rate-limit';
import { graphRequest } from './client';

/** Graph's JSON $batch endpoint accepts at most this many sub-requests per call. */
export const BATCH_CHUNK_SIZE = 20;

/** How many times a 429'd sub-request is re-sent before its failure is reported. */
export const BATCH_RETRY_ROUNDS = 3;
/** Fallback pause when Graph 429s a sub-request without a Retry-After header. */
export const BATCH_DEFAULT_RETRY_MS = 5_000;
/** Ceiling on any single honored Retry-After, so one hostile value can't hang a run. */
export const BATCH_MAX_RETRY_MS = 30_000;

export interface BatchRequestItem {
  /** Caller-chosen correlation id — echoed back on the matching result, so a message id doubles as one. */
  id: string;
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE';
  /** Relative to the Graph API root (e.g. "/me/messages/{id}"). */
  url: string;
  body?: unknown;
}

export interface BatchResultItem {
  id: string;
  ok: boolean;
  body: Record<string, unknown> | null;
  error?: string;
}

export interface GraphBatchOptions {
  /** Rate-limit lane; the web tools pass 'interactive', the worker 'background'. */
  lane?: RequestLane;
  /**
   * Chain each chunk's sub-requests with `dependsOn` so Graph runs them one
   * at a time. Graph otherwise fans a batch out four-wide against the
   * mailbox — the whole of Exchange's per-mailbox concurrency — so a bulk
   * job's every chunk shut out the chats and agents sharing that mailbox
   * (503 CommandConcurrencyLimitReached) for as long as it ran. Chained, a
   * batch holds one slot. Defaults to true on the background lane, where a
   * job has all night, and false on the interactive lane, where a person is
   * waiting on the answer.
   */
  sequential?: boolean;
  /** Called after each settled chunk — the worker's incremental-progress hook. */
  onChunk?: (results: readonly BatchResultItem[]) => void | Promise<void>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rec(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeBatchItemError(status: number, body: unknown): string {
  const message = str(rec(rec(body).error).message);
  return message || `Graph API answered ${status}`;
}

/** Sub-request methods a whole-batch retry cannot double-apply. */
const IDEMPOTENT_METHODS = new Set(['GET', 'PATCH', 'DELETE']);

interface ChunkOutcome {
  results: BatchResultItem[];
  retryable: BatchRequestItem[];
  /** Whether any retryable item was throttled (as opposed to skipped behind a failed dependency). */
  throttled: boolean;
  retryAfterMs: number;
}

/** Send one chunk (≤20) and map Graph's per-sub-request outcomes back onto the inputs. */
async function runBatchChunk(
  accessToken: string,
  chunk: readonly BatchRequestItem[],
  lane: RequestLane | undefined,
  sequential: boolean
): Promise<ChunkOutcome> {
  const result = await graphRequest(accessToken, '/$batch', {
    method: 'POST',
    lane,
    // The $batch POST itself is safe to re-send after a throttle only when
    // none of its sub-requests could have taken effect twice — a /move
    // answers with NEW ids, so a repeated move double-acts on the mailbox.
    retry: chunk.every((item) => IDEMPOTENT_METHODS.has(item.method)),
    body: JSON.stringify({
      requests: chunk.map((item, index) => ({
        id: item.id,
        method: item.method,
        url: item.url,
        ...(sequential && index > 0 ? { dependsOn: [chunk[index - 1]!.id] } : {}),
        ...(item.body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: item.body }
          : {}),
      })),
    }),
  });
  if (!result.ok) {
    const message = str(rec(result.err).message) || 'Graph API unreachable';
    return {
      results: chunk.map((item) => ({ id: item.id, ok: false, body: null, error: message })),
      retryable: [],
      throttled: false,
      retryAfterMs: 0,
    };
  }

  const responsesRaw = rec(result.val).responses;
  const responses = Array.isArray(responsesRaw) ? responsesRaw : [];
  const results: BatchResultItem[] = [];
  const retryable: BatchRequestItem[] = [];
  let throttled = false;
  let retryAfterMs = 0;

  for (const item of chunk) {
    const entry = rec(responses.find((response) => str(rec(response).id) === item.id));
    const status = typeof entry.status === 'number' ? entry.status : 0;
    if (status === 429 || status === 503) {
      // Throttled, not refused: worth another round rather than reporting a
      // failure the caller would only re-attempt by hand anyway.
      retryable.push(item);
      throttled = true;
      const retryAfter = Number(str(rec(entry.headers)['Retry-After']));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        retryAfterMs = Math.max(retryAfterMs, Math.min(retryAfter * 1000, BATCH_MAX_RETRY_MS));
      }
      continue;
    }
    if (status === 424 && sequential) {
      // Failed Dependency: Graph skipped this one because the sub-request
      // it was chained behind failed. Nothing is wrong with THIS item, so
      // it goes into the next round (re-chained behind survivors only).
      retryable.push(item);
      continue;
    }
    const ok = status >= 200 && status < 300;
    results.push({
      id: item.id,
      ok,
      body: ok ? rec(entry.body) : null,
      error: ok ? undefined : describeBatchItemError(status, entry.body),
    });
  }

  return { results, retryable, throttled, retryAfterMs };
}

export async function graphBatch(
  accessToken: string,
  requests: readonly BatchRequestItem[],
  options: GraphBatchOptions = {}
): Promise<{ results: BatchResultItem[] }> {
  const chunks: BatchRequestItem[][] = [];
  for (let i = 0; i < requests.length; i += BATCH_CHUNK_SIZE) {
    chunks.push(requests.slice(i, i + BATCH_CHUNK_SIZE));
  }

  const sequential = options.sequential ?? (options.lane ?? 'background') === 'background';
  const results: BatchResultItem[] = [];
  for (const chunk of chunks) {
    const settled: BatchResultItem[] = [];
    let pending: readonly BatchRequestItem[] = chunk;
    for (let round = 0; round <= BATCH_RETRY_ROUNDS && pending.length > 0; round += 1) {
      const outcome = await runBatchChunk(accessToken, pending, options.lane, sequential);
      settled.push(...outcome.results);
      pending = outcome.retryable;
      if (pending.length === 0) break;
      if (round === BATCH_RETRY_ROUNDS) {
        // Out of rounds — report the still-unsettled items as failures
        // rather than silently dropping them from the summary.
        settled.push(
          ...pending.map((item) => ({
            id: item.id,
            ok: false,
            body: null,
            error: outcome.throttled
              ? 'Graph kept rate limiting this message (429); try it again later.'
              : 'Graph did not process this message after repeated attempts; try it again later.',
          }))
        );
        break;
      }
      // A throttle asks for a pause; a skipped dependency does not.
      if (outcome.throttled) await sleep(outcome.retryAfterMs || BATCH_DEFAULT_RETRY_MS);
    }
    results.push(...settled);
    if (options.onChunk) await options.onChunk(settled);
  }

  return { results };
}

/** `current` categories with `add` merged in and `remove` taken out, order preserved. */
export function withCategoryChanges(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[]
): string[] {
  const removeSet = new Set(remove);
  const result = current.filter((category) => !removeSet.has(category));
  for (const category of add) {
    if (!result.includes(category)) result.push(category);
  }
  return result;
}

/** A one-line-per-failure summary for a bulk action's results — capped so 200 failures don't flood the reply. */
export function summarizeBatch(results: readonly BatchResultItem[], verb: string): string {
  const succeeded = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const lines = [`${verb}: ${succeeded.length} of ${results.length} succeeded.`];
  if (failed.length > 0) {
    const MAX_SHOWN = 20;
    const shown = failed.slice(0, MAX_SHOWN);
    lines.push('Failed:');
    lines.push(...shown.map((result) => `  • ${result.id}: ${result.error ?? 'unknown error'}`));
    if (failed.length > shown.length) lines.push(`  …and ${failed.length - shown.length} more.`);
  }
  return lines.join('\n');
}
