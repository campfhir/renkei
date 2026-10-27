/**
 * The audit recorder's two load-bearing properties: it writes what it was
 * told (attributed, labelled, capped), and it can never break the action it
 * describes — a down database is a logged shrug, not an error.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { recordAuditEvent } from './audit-events';
import { logger } from '@/lib/logger';

const flush = () => new Promise((resolve) => setImmediate(resolve));

let store: MemoryDataStore;

beforeEach(() => {
  store = createMemoryDataStore();
  registerDataStore(store);
  jest.clearAllMocks();
});

afterAll(() => {
  resetDataStore();
});

const rows = () => store.tables.select('audit_events');

describe('recordAuditEvent', () => {
  it('writes an attributed, labelled row', async () => {
    recordAuditEvent({
      actorSubject: 'subject-1',
      action: 'connector.connected',
      targetKind: 'connector',
      targetLabel: 'microsoft',
    });
    await flush();

    expect(rows()[0]).toMatchObject({
      actor_subject: 'subject-1',
      action: 'connector.connected',
      target_kind: 'connector',
      target_label: 'microsoft',
      details: null,
    });
  });

  it('caps the target label at the schema limit', async () => {
    recordAuditEvent({
      actorSubject: 'subject-1',
      action: 'agent.created',
      targetKind: 'agent',
      targetLabel: 'x'.repeat(500),
    });
    await flush();
    expect(String(rows()[0]!.target_label)).toHaveLength(200);
  });

  it('stores details as JSON and omits them when absent', async () => {
    recordAuditEvent({
      actorSubject: 'operator-1',
      action: 'agent.disabled',
      targetKind: 'agent',
      targetLabel: 'Triage',
      details: { byAdmin: true },
    });
    await flush();
    expect(rows()[0]!.details).toEqual({ byAdmin: true });
  });

  it('swallows a failed write with a warning, never a throw', async () => {
    registerDataStore({
      ...store,
      auditEvents: {
        ...store.auditEvents,
        record: async () => {
          throw new Error('db down mid-write');
        },
      },
    });
    expect(() => recordAuditEvent({ actorSubject: null, action: 'user.signed_in' })).not.toThrow();
    await flush();
    expect(logger.warn).toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });
});
