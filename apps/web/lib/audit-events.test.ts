/**
 * The audit recorder's two load-bearing properties: it writes what it was
 * told (attributed, labelled, capped), and it can never break the action it
 * describes — a down database is a logged shrug, not an error.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const inserted: Record<string, unknown>[] = [];
let dbAvailable = true;
let insertFails = false;

jest.mock('@renkei/db', () => ({
  getDatabase: () =>
    dbAvailable
      ? {
          ok: true,
          val: {
            insertInto: () => ({
              values: (row: Record<string, unknown>) => {
                inserted.push(row);
                return {
                  execute: async () => {
                    if (insertFails) throw new Error('db down mid-write');
                    return [];
                  },
                };
              },
            }),
          },
        }
      : { ok: false },
}));

import { recordAuditEvent } from './audit-events';
import { logger } from '@/lib/logger';

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  inserted.length = 0;
  dbAvailable = true;
  insertFails = false;
  jest.clearAllMocks();
});

describe('recordAuditEvent', () => {
  it('writes an attributed, labelled row', async () => {
    recordAuditEvent({
      tenantId: 'tenant-1',
      actorSubject: 'subject-1',
      action: 'connector.connected',
      targetKind: 'connector',
      targetLabel: 'microsoft',
    });
    await flush();

    expect(inserted[0]).toMatchObject({
      tenant_id: 'tenant-1',
      actor_subject: 'subject-1',
      action: 'connector.connected',
      target_kind: 'connector',
      target_label: 'microsoft',
      details: null,
    });
  });

  it('caps the target label at the schema limit', async () => {
    recordAuditEvent({
      tenantId: 'tenant-1',
      actorSubject: 'subject-1',
      action: 'agent.created',
      targetKind: 'agent',
      targetLabel: 'x'.repeat(500),
    });
    await flush();
    expect(String(inserted[0]!.target_label)).toHaveLength(200);
  });

  it('serializes details and omits them when absent', async () => {
    recordAuditEvent({
      tenantId: 'tenant-1',
      actorSubject: 'operator-1',
      action: 'agent.disabled',
      targetKind: 'agent',
      targetLabel: 'Triage',
      details: { byAdmin: true },
    });
    await flush();
    expect(inserted[0]!.details).toBe('{"byAdmin":true}');
  });

  it('swallows a failed write with a warning, never a throw', async () => {
    insertFails = true;
    expect(() =>
      recordAuditEvent({ tenantId: 'tenant-1', actorSubject: null, action: 'user.signed_in' })
    ).not.toThrow();
    await flush();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when the database is unavailable', async () => {
    dbAvailable = false;
    recordAuditEvent({ tenantId: 'tenant-1', actorSubject: null, action: 'user.signed_out' });
    await flush();
    expect(inserted).toHaveLength(0);
  });
});
