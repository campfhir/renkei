/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * What a batch announces, to whom, and under which preference — and the
 * contract with @renkei/agents' trigger catalog: every key the events
 * carry is one the catalog promised, so a `trigger.*` chip in the builder
 * is never a variable the worker forgot to send.
 */

jest.mock('../domain-events', () => ({ publishDomainEvent: jest.fn() }));
jest.mock('@renkei/user-prefs', () => {
  const actual = jest.requireActual<typeof import('@renkei/user-prefs/prefs')>(
    '@renkei/user-prefs/prefs'
  );
  return { ...actual, getNotificationPrefs: jest.fn() };
});
jest.mock('@renkei/notifications', () => ({ sendPush: jest.fn(async () => undefined) }));
jest.mock('@renkei/crypto', () => ({
  parseEncryptionKey: jest.fn(() => ({ ok: true, val: Buffer.alloc(32) })),
}));
jest.mock('../handlers/owner-channels', () => ({ deliverToOwnerChannels: jest.fn() }));
jest.mock('../handlers/feed-url', () => ({
  registrationUrl: jest.fn(async () => 'https://renkei.example.com/acme'),
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { TRIGGER_EVENT_CATALOG, matchesTriggerEvent } from '@renkei/agents';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@renkei/user-prefs/prefs';
import type { BatchJobRow } from '@renkei/batch-jobs-store';
import {
  announceBatchFinished,
  announceBatchStarted,
  batchEventData,
  batchNotificationMeta,
} from './lifecycle';

const { publishDomainEvent } = jest.requireMock<{ publishDomainEvent: jest.Mock }>(
  '../domain-events'
);
const { getNotificationPrefs } = jest.requireMock<{ getNotificationPrefs: jest.Mock }>(
  '@renkei/user-prefs'
);
const { sendPush } = jest.requireMock<{ sendPush: jest.Mock }>('@renkei/notifications');
const { deliverToOwnerChannels } = jest.requireMock<{ deliverToOwnerChannels: jest.Mock }>(
  '../handlers/owner-channels'
);
const { logger } = jest.requireMock<{ logger: { warn: jest.Mock } }>('../logger');

function batch(over: Partial<BatchJobRow> = {}): BatchJobRow {
  return {
    id: 'batch-1',
    tenant_id: 'tenant-1',
    subject: 'auth0|alice',
    name: 'Nightly scans',
    kind: 'document-ocr-pipeline',
    config: {},
    status: 'succeeded',
    total: 42,
    succeeded: 42,
    failed: 0,
    skipped: 0,
    last_error: null,
    schedule_id: 'sched-1',
    started_at: new Date('2026-09-01T02:00:00Z'),
    finished_at: new Date('2026-09-01T03:00:00Z'),
    created_at: new Date('2026-09-01T02:00:00Z'),
    ...over,
  };
}

/** A db whose insertInto records what it was handed. */
function fakeDb() {
  const inserts: { table: string; values: Record<string, unknown> }[] = [];
  const db = {
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return { execute: async () => undefined };
      },
    }),
  };
  return { db: db as unknown as Parameters<typeof announceBatchFinished>[0], inserts };
}

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  getNotificationPrefs.mockResolvedValue(prefs());
});

describe('the catalog contract', () => {
  const provided = (id: string) =>
    new Set(
      (TRIGGER_EVENT_CATALOG.find((event) => event.id === id)?.provides ?? []).map((entry) =>
        entry.name.replace(/^trigger\./, '')
      )
    );

  it('sends exactly the keys batch/job.completed promises', () => {
    const keys = new Set(Object.keys(batchEventData(batch(), 'completed')));
    expect(keys).toEqual(provided('batch/job.completed'));
  });

  it('sends exactly the keys batch/job.started promises', () => {
    const keys = new Set(Object.keys(batchEventData(batch(), 'started')));
    expect(keys).toEqual(provided('batch/job.started'));
  });

  it('carries the filterable fields as strings the catalog filters can read', () => {
    const data = batchEventData(
      batch({ status: 'partial', succeeded: 40, failed: 2 }),
      'completed'
    );
    expect(matchesTriggerEvent('batch/job.completed', { outcomes: 'partial' }, data)).toBe(true);
    expect(matchesTriggerEvent('batch/job.completed', { outcomes: 'failed' }, data)).toBe(false);
    expect(
      matchesTriggerEvent('batch/job.completed', { kinds: 'document-ocr-pipeline' }, data)
    ).toBe(true);
    expect(matchesTriggerEvent('batch/job.completed', { nameContains: 'nightly' }, data)).toBe(
      true
    );
    expect(data.summary).toBe('OCR’d 40 of 42 documents, 2 failed');
  });

  it('puts the error on a batch that never reached its items, and nowhere else', () => {
    const early = batchEventData(
      batch({ status: 'failed', total: null, succeeded: 0, last_error: 'share unreachable' }),
      'completed'
    );
    expect(early.error).toBe('share unreachable');
    expect(early.total).toBe(0);
    const late = batchEventData(
      batch({ status: 'partial', failed: 1, succeeded: 41 }),
      'completed'
    );
    expect(late.error).toBe('');
  });
});

describe('announceBatchFinished', () => {
  it('publishes the domain event to the owner, keyed by the batch', async () => {
    const { db } = fakeDb();
    await announceBatchFinished(db, batch());
    expect(publishDomainEvent).toHaveBeenCalledTimes(1);
    expect(publishDomainEvent.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      provider: 'batch',
      type: 'job.completed',
      ownerSubject: 'auth0|alice',
      orderingKey: 'batch/batch-1',
      occurredAt: '2026-09-01T03:00:00.000Z',
      data: { batchId: 'batch-1', status: 'succeeded' },
    });
  });

  it('still publishes for agents when the owner wants no notification at all', async () => {
    getNotificationPrefs.mockResolvedValue(
      prefs({ batchFinished: { app: false, email: false, webex: false } })
    );
    const { db, inserts } = fakeDb();
    await announceBatchFinished(db, batch());
    expect(publishDomainEvent).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(0);
    expect(deliverToOwnerChannels).not.toHaveBeenCalled();
  });

  it('writes the feed row with the batch facts as meta, and pushes', async () => {
    const { db, inserts } = fakeDb();
    await announceBatchFinished(db, batch({ status: 'partial', succeeded: 40, failed: 2 }));

    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.values;
    expect(inserts[0]!.table).toBe('agent_notifications');
    expect(row).toMatchObject({
      tenant_id: 'tenant-1',
      subject: 'auth0|alice',
      kind: 'batch_finished',
      connector: 'batch-jobs',
      entity: 'batch',
      ref_id: 'Nightly scans',
      headline: '“Nightly scans” finished with failures: OCR’d 40 of 42 documents, 2 failed',
    });
    expect(JSON.parse(String(row.meta))).toEqual(
      batchNotificationMeta(batch({ status: 'partial', succeeded: 40, failed: 2 }))
    );
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush.mock.calls[0][4]).toMatchObject({
      title: expect.stringContaining('Nightly scans'),
      body: 'Document OCR pipeline',
      tag: 'batch:batch-1',
    });
  });

  it('files a failed batch under batch_failed, gated by the batchFailed preference', async () => {
    getNotificationPrefs.mockResolvedValue(
      prefs({
        batchFinished: { app: false, email: false, webex: false },
        batchFailed: { app: true, email: false, webex: false },
      })
    );
    const { db, inserts } = fakeDb();
    await announceBatchFinished(
      db,
      batch({ status: 'failed', total: null, succeeded: 0, last_error: 'share unreachable' })
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values).toMatchObject({
      kind: 'batch_failed',
      headline: '“Nightly scans” failed: share unreachable',
    });
  });

  it('reaches Outlook/WebEx with a link to the batch when asked', async () => {
    getNotificationPrefs.mockResolvedValue(
      prefs({ batchFinished: { app: false, email: true, webex: true } })
    );
    const { db, inserts } = fakeDb();
    await announceBatchFinished(db, batch());
    expect(inserts).toHaveLength(0);
    expect(deliverToOwnerChannels).toHaveBeenCalledTimes(1);
    expect(deliverToOwnerChannels.mock.calls[0][1]).toMatchObject({
      tenantId: 'tenant-1',
      ownerSubject: 'auth0|alice',
      email: true,
      webex: true,
      heading: '“Nightly scans” finished: OCR’d 42 documents',
      body: expect.stringContaining('https://renkei.example.com/acme/batch-jobs/batch-1'),
    });
  });

  it('never throws — a failed publish or write is a warning', async () => {
    publishDomainEvent.mockRejectedValue(new Error('queue down'));
    const db = {
      insertInto: () => {
        throw new Error('db down');
      },
    } as unknown as Parameters<typeof announceBatchFinished>[0];
    await expect(announceBatchFinished(db, batch())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('announceBatchStarted', () => {
  it('is off by default in the feed, but the agent event still goes out', async () => {
    const { db, inserts } = fakeDb();
    await announceBatchStarted(db, batch({ status: 'discovering', total: null }));
    expect(publishDomainEvent.mock.calls[0][0]).toMatchObject({
      type: 'job.started',
      occurredAt: '2026-09-01T02:00:00.000Z',
      data: { batchId: 'batch-1', name: 'Nightly scans', scheduleId: 'sched-1' },
    });
    expect(inserts).toHaveLength(0);
  });

  it('writes a batch_started row once turned on', async () => {
    getNotificationPrefs.mockResolvedValue(
      prefs({ batchStarted: { app: true, email: false, webex: false } })
    );
    const { db, inserts } = fakeDb();
    await announceBatchStarted(db, batch({ status: 'discovering', total: null }));
    expect(inserts[0]!.values).toMatchObject({
      kind: 'batch_started',
      headline: '“Nightly scans” started',
    });
  });
});
