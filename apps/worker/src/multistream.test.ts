/**
 * The synthetic multi-stream suite: the worker loops running concurrently
 * against the two real queues' semantics (@renkei/queue's in-memory
 * adapter — the same contract the Postgres tables implement), fed
 * interleaved WebEx, Zoom and Microsoft events with stubbed connector
 * clients and a controllable embeddings endpoint.
 *
 * This is the regression suite for the production incident that motivated
 * Decision #20: the WebEx bot received messages.created events but never
 * replied, because the single serial loop was wedged inside untimed
 * embedding calls, and periodic timers drifted with it. Three scenarios
 * pin the properties that make that impossible now:
 *
 *   A (saturated) — with a slow embeddings endpoint, every message in both
 *     queues still reaches a terminal state, WebEx replies post within a
 *     latency bound the embedding backlog cannot stretch, each stream fans
 *     out exactly its expected knowledge jobs, and enrichment back-fills.
 *
 *   B (hung) — with an embeddings endpoint that never responds, WebEx
 *     events keep completing while the embedding job sits claimed,
 *     periodic timers keep firing on schedule, and releasing the hang as a
 *     failure lands the job in the real retry policy's backoff.
 *
 *   C (horizontal scale) — TWO embedding workers drain one queue: jobs
 *     sharing an ordering key never run concurrently or out of order,
 *     while different keys genuinely overlap. This is the property that
 *     lets the embedding worker scale to N instances.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/settings', () => ({
  getPublicBaseUrl: jest.fn(() => 'https://renkei.example.com'),
}));
// The knowledge layer reduced to its timing essence: every operation costs
// exactly what the scenario's embedder stub makes embed() cost.
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(),
  ingestObjectChunks: jest.fn(
    async (
      _tenantId: string,
      embedder: { embed: (t: string[]) => Promise<{ ok: boolean }> },
      object: { content: string }
    ) => {
      const embedded = await embedder.embed([object.content]);
      return embedded.ok
        ? { ok: true, val: { chunks: 1 } }
        : { ok: false, err: { type: 'EMBEDDING_FAILED' } };
    }
  ),
  deleteObjectChunks: jest.fn(async () => ({ ok: true, val: undefined })),
  searchKnowledge: jest.fn(
    async (options: {
      embedder: { embed: (t: string[]) => Promise<{ ok: boolean }> };
      query: string;
    }) => {
      const embedded = await options.embedder.embed([options.query]);
      return embedded.ok
        ? {
            ok: true,
            val: {
              hits: [
                {
                  provider: 'webex',
                  refId: 'room-1:earlier',
                  content: 'an earlier related message',
                  metadata: {},
                  distance: 0.2,
                  sourceAt: null,
                },
              ],
              elided: 0,
            },
          }
        : { ok: false, err: { type: 'EMBEDDING_FAILED' } };
    }
  ),
  ingestChunk: jest.fn(async () => ({ ok: true, val: undefined })),
}));
jest.mock('@renkei/email-sanitizer', () => ({
  sanitizeEmailForTenant: jest.fn(async (options: { raw: { subject: string } }) => ({
    action: 'index',
    content: `Subject: ${options.raw.subject}`,
    category: 'human',
    matchedRuleId: null,
    senderKey: null,
    templateId: null,
    templateVersion: null,
    matchScore: null,
    needsReview: false,
  })),
}));
jest.mock('@renkei/connector-microsoft', () => ({
  createGraphSubscription: jest.fn(),
  renewGraphSubscription: jest.fn(),
  runDeltaRound: jest.fn(),
  initialDeltaUrl: jest.fn(() => 'https://graph.microsoft.com/v1.0/delta'),
  microsoftRefId: (upn: string, kind: string, id: string) => `${upn}/${kind}/${id}`,
  graphRequest: jest.fn(),
}));
jest.mock('@renkei/connector-zoom', () => ({
  ZoomClient: class {
    async getMeetingTranscript() {
      return { ok: true, val: { downloadUrl: 'https://zoom.example.com/vtt' } };
    }
    async downloadFromUrl() {
      return { ok: true, val: 'we shipped the fix and closed the incident' };
    }
  },
  vttToText: (vtt: string) => vtt,
  parseZoomWebhookPayload: (payload: unknown) => {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null;
    const record = isRecord(payload) ? payload : {};
    const data = isRecord(record.data) ? record.data : {};
    return {
      ok: true,
      val: {
        hostId: 'host-1',
        hostEmail: 'host@example.com',
        meetingId: '123',
        meetingUuid: String(data.meeting_uuid),
        data,
      },
    };
  },
}));
jest.mock('./handlers/zoom-access', () => ({
  resolveZoomHostAccess: jest.fn(async () => ({
    accessToken: 'zoom-token',
    hostEmail: 'host@example.com',
  })),
}));
// Worker-originated knowledge jobs flow into the embedding queue exactly as
// the real enqueue produces them — ordering key included.
jest.mock('./enqueue', () => ({
  KNOWLEDGE_SOURCE: 'knowledge',
  enqueueKnowledgeEvent: (
    tenantId: string,
    type: string,
    payload: Record<string, unknown>,
    orderingKey: string | null = null
  ) => mockEnqueueImpl(tenantId, type, payload, orderingKey),
}));
// The worker's queue module reaches for Postgres; these suites bind the
// loops to in-memory queues directly, so neuter the construction.
jest.mock('./queue', () => ({ eventsQueue: null, embeddingQueue: null }));

import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { WebexMessage } from '@renkei/connector-webex';
import { InMemoryQueue } from '@renkei/queue';
import { createEventLoop, schedulePeriodicSweep } from './loop';
import type { EventLoop } from './loop';
import { registerHandler, handlerFor } from './handlers';
import { createWebexUserMessageHandler } from './handlers/webex-user-message';
import { createZoomTranscriptHandler } from './handlers/zoom-events';
import { runSubscriptionSync } from './handlers/microsoft-sync';
import {
  createKnowledgeIngestObjectHandler,
  createKnowledgeIngestEmailHandler,
  createKnowledgeDeleteObjectHandler,
  createKnowledgePurgePrefixHandler,
  createKnowledgeEnrichItemHandler,
} from './handlers/knowledge-ingest';
import type { MicrosoftAccess } from './handlers/microsoft-access';

let mockEnqueueImpl: (
  tenantId: string,
  type: string,
  payload: Record<string, unknown>,
  orderingKey: string | null
) => Promise<void>;

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { resolveEmbeddingProvider: mockResolveEmbeddingProvider } = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
}>('@renkei/knowledge');
const { ingestObjectChunks: mockIngestObjectChunks } = jest.requireMock<{
  ingestObjectChunks: jest.Mock;
}>('@renkei/knowledge');
const { runDeltaRound: mockRunDeltaRound } = jest.requireMock<{ runDeltaRound: jest.Mock }>(
  '@renkei/connector-microsoft'
);

type EmbedResult = Result<number[][], 'EMBEDDING_FAILED'>;

interface Embedder {
  embed(texts: readonly string[]): Promise<EmbedResult>;
}

/** Every embed call resolves ok after a fixed delay — a slow endpoint. */
function slowEmbedder(delayMs: number): Embedder {
  return {
    embed: (texts) =>
      new Promise((resolve) => setTimeout(() => resolve(ok(texts.map(() => [0.1]))), delayMs)),
  };
}

/**
 * Embed calls hang until the test releases them — a wedged endpoint. After
 * release, later embed calls resolve immediately with the same result (the
 * endpoint stays broken rather than re-wedging), so loops can wind down.
 */
function hungEmbedder(): { embedder: Embedder; release: (result: EmbedResult) => void } {
  const pending: Array<(resolve: EmbedResult) => void> = [];
  let released: EmbedResult | null = null;
  return {
    embedder: {
      embed: () =>
        released ? Promise.resolve(released) : new Promise((resolve) => pending.push(resolve)),
    },
    release: (result) => {
      released = result;
      for (const resolve of pending.splice(0)) resolve(result);
    },
  };
}

/** Shared DB stub: dedup misses, tenant slug resolves, inserts and updates recorded. */
function stubDb(state: {
  inserted: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}): void {
  const missChain = {
    select: () => missChain,
    where: () => missChain,
    executeTakeFirst: async () => undefined,
  };
  const tenantChain = {
    select: () => tenantChain,
    where: () => tenantChain,
    executeTakeFirst: async () => ({ slug: 'tenant-one' }),
  };
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: (table: string) => (table === 'tenants' ? tenantChain : missChain),
      insertInto: () => ({
        values: (row: Record<string, unknown>) => ({
          execute: async () => {
            state.inserted.push(row);
            return [];
          },
        }),
      }),
      updateTable: (table: string) => ({
        set: (values: Record<string, unknown>) => {
          const chain = {
            where: () => chain,
            execute: async () => [],
            executeTakeFirst: async () => {
              state.updates.push({ table, ...values });
              return { numUpdatedRows: BigInt(1) };
            },
          };
          return chain;
        },
      }),
    },
  });
}

interface Handled {
  at: number;
  messageId: string;
}

/** The all-spaces watcher's client: fetch-only, message authored by SOMEONE ELSE. */
function webexClientStub() {
  return {
    getMessage: async (id: string) =>
      ok<WebexMessage>({
        id,
        roomId: 'room-1',
        roomType: 'group' as const,
        text: `The build server is down (${id})`,
        personId: 'person-1',
        personEmail: 'sam@example.com',
        parentId: null,
        created: '2026-08-13T12:00:00Z',
      }),
  };
}

function microsoftAccess(): MicrosoftAccess {
  return {
    accountId: 'acct-1',
    accessToken: 'token',
    upn: 'alice@example.com',
    scopes: ['Mail.Read'],
  };
}

function registerAllHandlers(handled: Handled[]): void {
  // The webex leg is the suite's LATENCY PROBE: handled timestamps stand in
  // for the old bot replies — what matters is that interactive webex events
  // finish fast while the embedding queue is saturated or wedged.
  const webexHandler = createWebexUserMessageHandler({
    resolveAccess: async () => ({ accessToken: 'user-token', subject: 'watcher-1' }),
    makeClient: () => webexClientStub(),
  });
  registerHandler('webex', 'user-message.created', async (event) => {
    await webexHandler(event);
    const payload: { id?: unknown } =
      typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
        ? event.payload
        : {};
    handled.push({ at: Date.now(), messageId: typeof payload.id === 'string' ? payload.id : '' });
  });
  registerHandler('zoom', 'recording.transcript_completed', createZoomTranscriptHandler());
  // The real change-notification handler resolves its subscription row from
  // the database before calling runSubscriptionSync; the row lookup is not
  // what this suite exercises, so the wrapper hands the REAL sync a fixed
  // row and the mocked delta round does the fanning out.
  registerHandler('microsoft', 'change-notification', async (event) => {
    await runSubscriptionSync(event.tenant_id, microsoftAccess(), {
      id: 'sub-row-1',
      resource: "me/mailFolders('inbox')/messages",
      subscription_id: 'graph-sub-1',
      client_state: 'state',
      expires_at: new Date(),
      delta_link: 'delta-1',
    });
  });
  registerHandler('knowledge', 'ingest.object', createKnowledgeIngestObjectHandler());
  registerHandler('knowledge', 'ingest.email', createKnowledgeIngestEmailHandler());
  registerHandler('knowledge', 'delete.object', createKnowledgeDeleteObjectHandler());
  registerHandler('knowledge', 'purge.prefix', createKnowledgePurgePrefixHandler());
  registerHandler('knowledge', 'enrich.item', createKnowledgeEnrichItemHandler());
}

function loopOn(queue: InMemoryQueue, label: string): EventLoop {
  return createEventLoop({
    claim: () => queue.consumer.claim(),
    complete: (event) => queue.consumer.complete(event),
    fail: (event, error) => queue.consumer.fail(event, error),
    handlerFor,
    busyDelayMs: 5,
    idleDelayMs: 10,
    label,
  });
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

async function stopAll(loops: EventLoop[], running: Promise<void>[]): Promise<void> {
  loops.forEach((loop) => loop.stop());
  await Promise.all(running);
}

function insertWebex(events: InMemoryQueue, messageId: string): number {
  const at = Date.now();
  void events.producer.enqueue({
    tenantId: 'tenant-1',
    source: 'webex',
    type: 'user-message.created',
    payload: { id: messageId, roomId: 'room-1', accountId: 'acct-w' },
    orderingKey: `webex/tenant-1/acct-w/room-1`,
  });
  return at;
}

function insertZoom(events: InMemoryQueue, uuid: string): void {
  void events.producer.enqueue({
    tenantId: 'tenant-1',
    source: 'zoom',
    type: 'recording.transcript_completed',
    payload: { data: { meeting_uuid: uuid, topic: 'Standup', start_time: '2026-08-13T09:00:00Z' } },
    orderingKey: `zoom/tenant-1/${uuid}`,
  });
}

function insertMicrosoft(events: InMemoryQueue): void {
  void events.producer.enqueue({
    tenantId: 'tenant-1',
    source: 'microsoft',
    type: 'change-notification',
    payload: { accountId: 'acct-1', subscriptionId: 'graph-sub-1' },
    // Deliberately NO ordering key here: the suite wants the two delta
    // rounds claimable concurrently to saturate the embedding queue.
  });
}

let dbState: { inserted: Array<Record<string, unknown>>; updates: Array<Record<string, unknown>> };
let handled: Handled[];
let events: InMemoryQueue;
let embedding: InMemoryQueue;

beforeEach(() => {
  jest.clearAllMocks();
  dbState = { inserted: [], updates: [] };
  handled = [];
  events = new InMemoryQueue();
  embedding = new InMemoryQueue();
  stubDb(dbState);
  registerAllHandlers(handled);
  mockEnqueueImpl = async (tenantId, type, payload, orderingKey) => {
    await embedding.producer.enqueue({
      tenantId,
      // Mirrors the real enqueueKnowledgeEvent: the provider is a fairness
      // LANE on the source. Hardcoding 'knowledge' here would leave this
      // whole pipeline test proving something production never writes, and a
      // dispatch regression on laned messages would sail through it.
      source: typeof payload.provider === 'string' ? `knowledge:${payload.provider}` : 'knowledge',
      type,
      payload,
      orderingKey,
    });
  };
  let deltaSeq = 0;
  mockRunDeltaRound.mockImplementation(async () => {
    deltaSeq += 1;
    return ok({
      items: [
        {
          id: `m-${deltaSeq}-1`,
          subject: 'Delta one',
          from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
          receivedDateTime: '2026-08-13T10:00:00Z',
          body: { contentType: 'text', content: 'first' },
        },
        {
          id: `m-${deltaSeq}-2`,
          subject: 'Delta two',
          from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
          receivedDateTime: '2026-08-13T10:01:00Z',
          body: { contentType: 'text', content: 'second' },
        },
      ],
      deltaLink: 'delta-2',
    });
  });
});

describe('multi-stream: saturated embedding queue (Scenario A)', () => {
  it('processes every stream to terminal state while replies stay fast and enrichment back-fills', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(slowEmbedder(100));

    // Interleaved arrival: webex, zoom, microsoft, webex, ...
    const insertTimes = new Map<string, number>();
    insertTimes.set('msg-1', insertWebex(events, 'msg-1'));
    insertZoom(events, 'uuid-1');
    insertMicrosoft(events);
    insertTimes.set('msg-2', insertWebex(events, 'msg-2'));
    insertZoom(events, 'uuid-2');
    insertTimes.set('msg-3', insertWebex(events, 'msg-3'));
    insertMicrosoft(events);
    insertTimes.set('msg-4', insertWebex(events, 'msg-4'));
    insertZoom(events, 'uuid-3');
    insertTimes.set('msg-5', insertWebex(events, 'msg-5'));

    const loops = [loopOn(events, 'worker/loop'), loopOn(embedding, 'worker/embeddings-loop')];
    const running = loops.map((loop) => loop.run());
    const drained = await waitUntil(() => events.settled() && embedding.settled(), 10_000).finally(
      () => stopAll(loops, running)
    );

    // (1) Every message in both queues reached a terminal state, none dead.
    expect(drained).toBe(true);
    expect(events.deadSnapshot()).toHaveLength(0);
    expect(embedding.deadSnapshot()).toHaveLength(0);

    // (2) Every WebEx event finished fast, despite >0.9s of serial
    // embedding-queue work queued behind the same arrivals. (The all-spaces
    // handler only fetches and fans out — no capture side effects.)
    expect(handled).toHaveLength(5);
    for (const done of handled) {
      const insertedAt = insertTimes.get(done.messageId);
      expect(insertedAt).toBeDefined();
      expect(done.at - (insertedAt ?? 0)).toBeLessThan(1_000);
    }

    // (3) Fan-out accounting: 3 zoom ingests, 2 microsoft rounds × 2 mails
    // — all processed. (WebEx no longer feeds the embedding queue: the bot
    // capture pipeline is gone; webex_capture_message is a deliberate tool.)
    const jobs = embedding.snapshot();
    const byType = (type: string) => jobs.filter((row) => row.type === type);
    expect(byType('ingest.object')).toHaveLength(3);
    expect(byType('ingest.email')).toHaveLength(4);
    expect(jobs.every((row) => row.status === 'processed')).toBe(true);
  }, 15_000);
});

describe('multi-stream: hung embedding queue (Scenario B)', () => {
  it('keeps interactive events and timers flowing while an embedding job hangs, then retries it', async () => {
    const hung = hungEmbedder();
    mockResolveEmbeddingProvider.mockResolvedValue(hung.embedder);

    // Seed the embedding queue directly with an ingest and let it wedge.
    await embedding.producer.enqueue({
      tenantId: 'tenant-1',
      source: 'knowledge',
      type: 'ingest.object',
      payload: { provider: 'zoom', refId: 'host@example.com/uuid-9/transcript', content: 'x' },
      orderingKey: 'zoom/host@example.com/uuid-9/transcript',
    });

    let ticks = 0;
    const stopSweep = schedulePeriodicSweep('drift-probe', 'test/drift', 50, async () => {
      ticks += 1;
    });
    const loops = [loopOn(events, 'worker/loop'), loopOn(embedding, 'worker/embeddings-loop')];
    const running = loops.map((loop) => loop.run());
    try {
      const claimed = await waitUntil(
        () => embedding.snapshot().some((row) => row.status === 'processing'),
        2_000
      );
      expect(claimed).toBe(true);

      // The hang is in progress. Interactive traffic must be unaffected.
      const ticksAtHangStart = ticks;
      const insertTimes = new Map<string, number>();
      for (const id of ['msg-a', 'msg-b', 'msg-c']) {
        insertTimes.set(id, insertWebex(events, id));
      }
      const webexHandled = await waitUntil(() => handled.length === 3, 2_000);
      expect(webexHandled).toBe(true);
      for (const done of handled) {
        const insertedAt = insertTimes.get(done.messageId);
        expect(done.at - (insertedAt ?? 0)).toBeLessThan(1_000);
      }
      // ...and the wedged job is STILL processing while all that happened.
      expect(embedding.snapshot()[0]?.status).toBe('processing');

      // Timers kept their cadence during the hang: the 50ms probe keeps
      // firing while the embedding job stays wedged — the drift the
      // original incident showed cannot recur.
      const ticked = await waitUntil(() => ticks >= ticksAtHangStart + 3, 2_000);
      expect(ticked).toBe(true);
      expect(embedding.snapshot()[0]?.status).toBe('processing');

      // Release the hang as a failure: the job lands back in 'pending'
      // with the real policy's backoff, not lost and not stuck.
      hung.release({ ok: false, err: { type: 'EMBEDDING_FAILED' } });
      const failed = await waitUntil(() => embedding.snapshot()[0]?.status === 'pending', 2_000);
      expect(failed).toBe(true);
      const row = embedding.snapshot()[0]!;
      expect(row.attempts).toBe(1);
      expect(row.runAfter).toBeGreaterThan(Date.now() + 20_000); // ≥30s backoff
    } finally {
      stopSweep();
      await stopAll(loops, running);
    }
    // Nothing left mid-flight after shutdown.
    expect(embedding.snapshot().filter((r) => r.status === 'processing')).toHaveLength(0);
  }, 15_000);
});

describe('multi-stream: two embedding workers (Scenario C)', () => {
  it('keeps keyed jobs serial and in order across instances, while distinct keys overlap', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(slowEmbedder(100));

    // Instrument the ingest mock: track in-flight jobs per ordering key
    // and overall, and the completion order per key.
    const inFlightByKey = new Map<string, number>();
    let inFlight = 0;
    let maxInFlight = 0;
    let sameKeyOverlap = false;
    const completedByKey = new Map<string, string[]>();
    mockIngestObjectChunks.mockImplementation(
      async (_tenantId: string, embedder: Embedder, object: { refId: string }) => {
        const key = object.refId.split('/')[0]!;
        const current = (inFlightByKey.get(key) ?? 0) + 1;
        if (current > 1) sameKeyOverlap = true;
        inFlightByKey.set(key, current);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await embedder.embed(['x']);
        inFlightByKey.set(key, (inFlightByKey.get(key) ?? 1) - 1);
        inFlight -= 1;
        const done = completedByKey.get(key) ?? [];
        done.push(object.refId);
        completedByKey.set(key, done);
        return { ok: true, val: { chunks: 1 } };
      }
    );

    // Two keyed sequences plus an unkeyed straggler.
    for (const refId of ['alpha/1', 'alpha/2', 'alpha/3']) {
      await embedding.producer.enqueue({
        tenantId: 'tenant-1',
        source: 'knowledge',
        type: 'ingest.object',
        payload: { provider: 'test', refId, content: refId },
        orderingKey: 'alpha',
      });
    }
    for (const refId of ['beta/1', 'beta/2', 'beta/3']) {
      await embedding.producer.enqueue({
        tenantId: 'tenant-1',
        source: 'knowledge',
        type: 'ingest.object',
        payload: { provider: 'test', refId, content: refId },
        orderingKey: 'beta',
      });
    }
    await embedding.producer.enqueue({
      tenantId: 'tenant-1',
      source: 'knowledge',
      type: 'ingest.object',
      payload: { provider: 'test', refId: 'solo/1', content: 'solo' },
      orderingKey: null,
    });

    // TWO embedding workers on the SAME queue — the horizontal-scale shape.
    const loops = [
      loopOn(embedding, 'worker/embeddings-loop-1'),
      loopOn(embedding, 'worker/embeddings-loop-2'),
    ];
    const running = loops.map((loop) => loop.run());
    const drained = await waitUntil(() => embedding.settled(), 10_000).finally(() =>
      stopAll(loops, running)
    );
    expect(drained).toBe(true);

    // Per-key: strictly serial and in enqueue order, on both keys.
    expect(sameKeyOverlap).toBe(false);
    expect(completedByKey.get('alpha')).toEqual(['alpha/1', 'alpha/2', 'alpha/3']);
    expect(completedByKey.get('beta')).toEqual(['beta/1', 'beta/2', 'beta/3']);
    // Cross-key: the two workers genuinely ran concurrently.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  }, 15_000);
});
