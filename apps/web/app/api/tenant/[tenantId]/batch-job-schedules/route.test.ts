/**
 * The batch-job schedules collection route: session-gated, validates the
 * share/grouping/scheduleConfig shape the same way the one-off start route
 * does, and otherwise delegates to createSchedule/listSchedules — this test
 * only pins the HTTP seam around those.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@renkei/connector-fileshares', () => ({ listConnectedShares: jest.fn() }));
jest.mock('@renkei/batch-jobs-store', () => ({
  createSchedule: jest.fn(),
  listSchedules: jest.fn(),
  DOCUMENT_OCR_PIPELINE_KIND: 'document-ocr-pipeline',
}));
jest.mock('@renkei/agents', () => ({ parseScheduleConfig: jest.fn() }));
jest.mock('@/lib/batch-jobs/schedule-next-run', () => ({ nextRunAtFor: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';

const { getSessionFromRequest } = jest.requireMock<{ getSessionFromRequest: jest.Mock }>('@/lib/session');
const { listConnectedShares } = jest.requireMock<{ listConnectedShares: jest.Mock }>(
  '@renkei/connector-fileshares'
);
const { createSchedule, listSchedules } = jest.requireMock<{
  createSchedule: jest.Mock;
  listSchedules: jest.Mock;
}>('@renkei/batch-jobs-store');
const { parseScheduleConfig } = jest.requireMock<{ parseScheduleConfig: jest.Mock }>('@renkei/agents');
const { nextRunAtFor } = jest.requireMock<{ nextRunAtFor: jest.Mock }>('@/lib/batch-jobs/schedule-next-run');

const SHARE_ID = '11111111-2222-3333-4444-555555555555';
const paramsOf = () => Promise.resolve({ tenantId: 'tenant-1' });
const SCHEDULE_CONFIG = { recurrences: [{ every: 'hour' }], timezone: 'UTC' };

function reqOf(body: unknown): NextRequest {
  return new NextRequest(
    new Request('http://x/api/tenant/tenant-1/batch-job-schedules', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  getSessionFromRequest.mockResolvedValue({ subject: 'auth0|alice' });
  listConnectedShares.mockResolvedValue({ ok: true, val: [{ share: { id: SHARE_ID } }] });
  parseScheduleConfig.mockImplementation((value: unknown) => (value ? SCHEDULE_CONFIG : null));
  nextRunAtFor.mockResolvedValue(new Date('2026-09-02T00:00:00Z'));
  createSchedule.mockResolvedValue({ id: 'sched-1' });
});

describe('GET', () => {
  test('a signed-out request is refused', async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://x/api/tenant/tenant-1/batch-job-schedules'), {
      params: paramsOf(),
    });
    expect(response.status).toBe(401);
  });

  test('lists the caller\'s schedules', async () => {
    listSchedules.mockResolvedValue([
      {
        id: 'sched-1',
        name: 'Nightly OCR',
        kind: 'document-ocr-pipeline',
        config: { shareId: SHARE_ID },
        schedule_config: SCHEDULE_CONFIG,
        enabled: true,
        next_run_at: new Date('2026-09-02T00:00:00Z'),
        last_fired_at: null,
        last_error: null,
        created_at: new Date('2026-09-01T00:00:00Z'),
      },
    ]);
    const response = await GET(new NextRequest('http://x/api/tenant/tenant-1/batch-job-schedules'), {
      params: paramsOf(),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].name).toBe('Nightly OCR');
  });
});

describe('POST', () => {
  test('a signed-out request is refused', async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const response = await POST(reqOf({}), { params: paramsOf() });
    expect(response.status).toBe(401);
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test('a missing name is a 400', async () => {
    const response = await POST(
      reqOf({ shareId: SHARE_ID, grouping: { strategy: 'whole-file' }, scheduleConfig: SCHEDULE_CONFIG }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(400);
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test('a missing shareId is a 400', async () => {
    const response = await POST(
      reqOf({ name: 'Nightly OCR', grouping: { strategy: 'whole-file' }, scheduleConfig: SCHEDULE_CONFIG }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(400);
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test('an unconnected share is refused', async () => {
    listConnectedShares.mockResolvedValue({ ok: true, val: [] });
    const response = await POST(
      reqOf({
        name: 'Nightly OCR',
        shareId: SHARE_ID,
        grouping: { strategy: 'whole-file' },
        scheduleConfig: SCHEDULE_CONFIG,
      }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(400);
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test('a malformed scheduleConfig is a 400', async () => {
    parseScheduleConfig.mockReturnValue(null);
    const response = await POST(
      reqOf({ name: 'Nightly OCR', shareId: SHARE_ID, grouping: { strategy: 'whole-file' }, scheduleConfig: {} }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(400);
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test('no valid next occurrence is a 400', async () => {
    nextRunAtFor.mockRejectedValue(new Error('no occurrence'));
    const response = await POST(
      reqOf({
        name: 'Nightly OCR',
        shareId: SHARE_ID,
        grouping: { strategy: 'whole-file' },
        scheduleConfig: SCHEDULE_CONFIG,
      }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(400);
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test('creates the schedule and returns its id', async () => {
    const response = await POST(
      reqOf({
        name: 'Nightly OCR',
        shareId: SHARE_ID,
        path: '/inbox',
        grouping: { strategy: 'whole-file' },
        scheduleConfig: SCHEDULE_CONFIG,
      }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'sched-1' });
    expect(createSchedule).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        tenantId: 'tenant-1',
        subject: 'auth0|alice',
        name: 'Nightly OCR',
        kind: 'document-ocr-pipeline',
        config: { shareId: SHARE_ID, path: '/inbox', grouping: { strategy: 'whole-file' } },
        scheduleConfig: SCHEDULE_CONFIG,
      })
    );
  });

  test('a duplicate name is a 409', async () => {
    createSchedule.mockRejectedValue(new Error('duplicate key value violates batch_job_schedules_tenant_name'));
    const response = await POST(
      reqOf({
        name: 'Nightly OCR',
        shareId: SHARE_ID,
        grouping: { strategy: 'whole-file' },
        scheduleConfig: SCHEDULE_CONFIG,
      }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(409);
  });
});
