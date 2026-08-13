/**
 * The synthetic multi-stream suite: both worker loops running concurrently
 * against one lane-partitioned in-memory queue, fed interleaved WebEx, Zoom
 * and Microsoft events with stubbed connector clients and a controllable
 * embeddings endpoint.
 *
 * This is the regression test for the production incident that motivated
 * Decision #20: the WebEx bot received messages.created events but never
 * replied, because the single serial loop was wedged inside untimed
 * embedding calls, and periodic timers drifted with it. The two scenarios
 * assert the properties that make that impossible now:
 *
 *   A (saturated) — with a slow embeddings endpoint, every event in both
 *     lanes still reaches a terminal state, WebEx replies post within a
 *     latency bound that the embedding backlog cannot stretch, each stream
 *     fans out exactly its expected knowledge events, and enrichment
 *     back-fills once the embedding lane catches up.
 *
 *   B (hung) — with an embeddings endpoint that never responds, WebEx
 *     events keep completing while the embedding-lane event sits in
 *     'processing', periodic timers keep firing on schedule, and releasing
 *     the hang as a failure lands the event in the real retry policy's
 *     backoff — nothing is ever stuck silently.
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
jest.mock('./handlers/webex-context', () => ({
  resolveWebexContext: jest.fn(async () => ({ client: {}, botPersonId: 'bot-1' })),
}));
// Worker-originated knowledge events flow into the memory queue's embedding
// lane, exactly as the real enqueue INSERTs them with lane='embedding'.
jest.mock('./enqueue', () => ({
  KNOWLEDGE_SOURCE: 'knowledge',
  enqueueKnowledgeEvent: (tenantId: string, type: string, payload: Record<string, unknown>) =>
    mockEnqueueImpl(tenantId, type, payload),
}));

import { randomUUID } from 'node:crypto';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { WebexMessage, OutgoingMessage } from '@renkei/connector-webex';
import { createEventLoop, schedulePeriodicSweep } from './loop';
import type { EventLoop } from './loop';
import { registerHandler, handlerFor } from './handlers';
import { createWebexMessageHandler } from './handlers/webex-message';
import { createZoomTranscriptHandler } from './handlers/zoom-events';
import { runSubscriptionSync } from './handlers/microsoft-sync';
import {
  createKnowledgeIngestObjectHandler,
  createKnowledgeIngestEmailHandler,
  createKnowledgeDeleteObjectHandler,
  createKnowledgePurgePrefixHandler,
  createKnowledgeEnrichItemHandler,
} from './handlers/knowledge-ingest';
import { InMemoryEventQueue } from './test-support/memory-queue';
import type { MicrosoftAccess } from './handlers/microsoft-access';

let mockEnqueueImpl: (
  tenantId: string,
  type: string,
  payload: Record<string, unknown>
) => Promise<void>;

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { resolveEmbeddingProvider: mockResolveEmbeddingProvider } = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
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

interface Posted {
  at: number;
  outgoing: OutgoingMessage;
}

function webexClientStub(posted: Posted[]) {
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
    isRoomMember: async () => ok(true),
    postMessage: async (outgoing: OutgoingMessage) => {
      posted.push({ at: Date.now(), outgoing });
      return ok({ id: `reply-${posted.length}` });
    },
    getAttachmentAction: async () => {
      throw new Error('not used');
    },
    getPerson: async () => {
      throw new Error('not used');
    },
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

function registerAllHandlers(posted: Posted[]): void {
  registerHandler(
    'webex',
    'messages.created',
    createWebexMessageHandler({
      resolveContext: async () => ({ client: webexClientStub(posted), botPersonId: 'bot-1' }),
      hasLinkedIdentity: async () => true,
      resolveLinkedWebexUserAccess: async () => null,
    })
  );
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

function startLoops(queue: InMemoryEventQueue): {
  loops: EventLoop[];
  running: Promise<void>[];
} {
  const interactive = createEventLoop({
    claim: () => queue.claim('interactive'),
    complete: (event) => queue.complete(event.id),
    fail: (event, error) => queue.fail(event, error),
    handlerFor,
    busyDelayMs: 5,
    idleDelayMs: 10,
    label: 'worker/loop',
  });
  const embedding = createEventLoop({
    claim: () => queue.claim('embedding'),
    complete: (event) => queue.complete(event.id),
    fail: (event, error) => queue.fail(event, error),
    handlerFor,
    busyDelayMs: 5,
    idleDelayMs: 10,
    label: 'worker/embeddings-loop',
  });
  return { loops: [interactive, embedding], running: [interactive.run(), embedding.run()] };
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

function insertWebex(queue: InMemoryEventQueue, messageId: string) {
  return queue.insert(
    {
      id: randomUUID(),
      tenant_id: 'tenant-1',
      source: 'webex',
      type: 'messages.created',
      payload: { id: messageId, roomId: 'room-1' },
    },
    'interactive'
  );
}

function insertZoom(queue: InMemoryEventQueue, uuid: string) {
  return queue.insert(
    {
      id: randomUUID(),
      tenant_id: 'tenant-1',
      source: 'zoom',
      type: 'recording.transcript_completed',
      payload: {
        data: { meeting_uuid: uuid, topic: 'Standup', start_time: '2026-08-13T09:00:00Z' },
      },
    },
    'interactive'
  );
}

function insertMicrosoft(queue: InMemoryEventQueue) {
  return queue.insert(
    {
      id: randomUUID(),
      tenant_id: 'tenant-1',
      source: 'microsoft',
      type: 'change-notification',
      payload: { accountId: 'acct-1', subscriptionId: 'graph-sub-1' },
    },
    'interactive'
  );
}

let dbState: { inserted: Array<Record<string, unknown>>; updates: Array<Record<string, unknown>> };
let posted: Posted[];
let queue: InMemoryEventQueue;

beforeEach(() => {
  jest.clearAllMocks();
  dbState = { inserted: [], updates: [] };
  posted = [];
  queue = new InMemoryEventQueue();
  stubDb(dbState);
  registerAllHandlers(posted);
  mockEnqueueImpl = async (tenantId, type, payload) => {
    queue.insert(
      {
        id: randomUUID(),
        tenant_id: tenantId,
        source: 'knowledge',
        type,
        // The same round-trip the real queue's jsonb column performs.
        payload: JSON.parse(JSON.stringify(payload)),
      },
      'embedding'
    );
  };
  // Each microsoft change-notification's delta round yields two mail items.
  mockRunDeltaRound.mockResolvedValue(
    ok({
      items: [
        {
          id: `m-${randomUUID()}`,
          subject: 'Delta one',
          from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
          receivedDateTime: '2026-08-13T10:00:00Z',
          body: { contentType: 'text', content: 'first' },
        },
        {
          id: `m-${randomUUID()}`,
          subject: 'Delta two',
          from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
          receivedDateTime: '2026-08-13T10:01:00Z',
          body: { contentType: 'text', content: 'second' },
        },
      ],
      deltaLink: 'delta-2',
    })
  );
});

describe('multi-stream: saturated embedding lane (Scenario A)', () => {
  it('processes every stream to terminal state while replies stay fast and enrichment back-fills', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(slowEmbedder(100));

    // Interleaved arrival: webex, zoom, microsoft, webex, ...
    const insertTimes = new Map<string, number>();
    const webexIds = ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5'];
    insertTimes.set('msg-1', insertWebex(queue, 'msg-1').insertedAt);
    insertZoom(queue, 'uuid-1');
    insertMicrosoft(queue);
    insertTimes.set('msg-2', insertWebex(queue, 'msg-2').insertedAt);
    insertZoom(queue, 'uuid-2');
    insertTimes.set('msg-3', insertWebex(queue, 'msg-3').insertedAt);
    insertMicrosoft(queue);
    insertTimes.set('msg-4', insertWebex(queue, 'msg-4').insertedAt);
    insertZoom(queue, 'uuid-3');
    insertTimes.set('msg-5', insertWebex(queue, 'msg-5').insertedAt);

    const { loops, running } = startLoops(queue);
    const drained = await waitUntil(() => queue.settled(), 10_000).finally(async () => {
      loops.forEach((loop) => loop.stop());
      await Promise.all(running);
    });

    // (1) Every event in both lanes reached a terminal state, none dead.
    expect(drained).toBe(true);
    const rows = queue.snapshot();
    expect(rows.filter((row) => row.status === 'processing')).toHaveLength(0);
    expect(rows.filter((row) => row.status === 'dead')).toHaveLength(0);
    expect(rows.every((row) => row.status === 'processed')).toBe(true);

    // (2) Every WebEx reply posted fast, despite >1.5s of serial
    // embedding-lane work queued behind the same arrivals. The bound is
    // generous against CI jitter but far below what any inline embed
    // (100ms × 17 events, serial) would produce.
    expect(posted).toHaveLength(5);
    for (const reply of posted) {
      const messageId = reply.outgoing.parentId;
      const insertedAt = insertTimes.get(String(messageId));
      expect(insertedAt).toBeDefined();
      expect(reply.at - (insertedAt ?? 0)).toBeLessThan(1_000);
    }
    expect([...insertTimes.keys()].sort()).toEqual([...webexIds].sort());

    // (3) Fan-out accounting: 5 webex ingests + 5 enrichments, 3 zoom
    // ingests, 2 microsoft rounds × 2 mails — all processed.
    const embeddingLane = queue.lane('embedding');
    const byType = (type: string) => embeddingLane.filter((row) => row.type === type);
    expect(byType('ingest.object')).toHaveLength(8);
    expect(byType('enrich.item')).toHaveLength(5);
    expect(byType('ingest.email')).toHaveLength(4);
    expect(embeddingLane.every((row) => row.status === 'processed')).toBe(true);

    // (4) The enrichment back-fill landed: one actionable_items update per
    // webex capture, after the embedding lane drained.
    const enrichWrites = dbState.updates.filter((update) => update.table === 'actionable_items');
    expect(enrichWrites).toHaveLength(5);
  }, 15_000);
});

describe('multi-stream: hung embedding lane (Scenario B)', () => {
  it('keeps interactive events and timers flowing while an embedding event hangs, then retries it', async () => {
    const hung = hungEmbedder();
    mockResolveEmbeddingProvider.mockResolvedValue(hung.embedder);

    // Seed the embedding lane directly with an ingest and let it wedge.
    queue.insert(
      {
        id: randomUUID(),
        tenant_id: 'tenant-1',
        source: 'knowledge',
        type: 'ingest.object',
        payload: { provider: 'zoom', refId: 'host@example.com/uuid-9/transcript', content: 'x' },
      },
      'embedding'
    );

    let ticks = 0;
    const stopSweep = schedulePeriodicSweep('drift-probe', 'test/drift', 50, async () => {
      ticks += 1;
    });
    const { loops, running } = startLoops(queue);
    try {
      const claimed = await waitUntil(
        () => queue.lane('embedding').some((row) => row.status === 'processing'),
        2_000
      );
      expect(claimed).toBe(true);

      // The hang is in progress. Interactive traffic must be unaffected.
      const ticksAtHangStart = ticks;
      const insertTimes = new Map<string, number>();
      for (const id of ['msg-a', 'msg-b', 'msg-c']) {
        insertTimes.set(id, insertWebex(queue, id).insertedAt);
      }
      const repliesPosted = await waitUntil(() => posted.length === 3, 2_000);
      expect(repliesPosted).toBe(true);
      for (const reply of posted) {
        const insertedAt = insertTimes.get(String(reply.outgoing.parentId));
        expect(reply.at - (insertedAt ?? 0)).toBeLessThan(1_000);
      }
      // ...and the wedged event is STILL processing while all that happened.
      expect(queue.lane('embedding')[0]?.status).toBe('processing');

      // Timers kept their cadence during the hang: the 50ms probe keeps
      // firing while the embedding event stays wedged — the drift the
      // original incident showed cannot recur.
      const ticked = await waitUntil(() => ticks >= ticksAtHangStart + 3, 2_000);
      expect(ticked).toBe(true);
      expect(queue.lane('embedding')[0]?.status).toBe('processing');

      // Release the hang as a failure: the event lands back in 'pending'
      // with the real policy's backoff, not lost and not stuck.
      hung.release({ ok: false, err: { type: 'EMBEDDING_FAILED' } });
      const failed = await waitUntil(() => queue.lane('embedding')[0]?.status === 'pending', 2_000);
      expect(failed).toBe(true);
      const row = queue.lane('embedding')[0]!;
      expect(row.attempts).toBe(1);
      expect(row.runAfter).toBeGreaterThan(Date.now() + 20_000); // ≥30s backoff
    } finally {
      stopSweep();
      loops.forEach((loop) => loop.stop());
      await Promise.all(running);
    }
    // Nothing left mid-flight after shutdown.
    expect(queue.snapshot().filter((r) => r.status === 'processing')).toHaveLength(0);
  }, 15_000);
});
