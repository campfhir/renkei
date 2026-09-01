/**
 * One batch-job schedule's route: ownership-scoped GET/PUT/DELETE, and the
 * next_run_at recompute rule — recompute when scheduleConfig changes or a
 * disabled schedule is re-enabled, leave it alone otherwise.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@renkei/connector-fileshares', () => ({ listConnectedShares: jest.fn() }));
jest.mock('@renkei/batch-jobs-store', () => ({
  getSchedule: jest.fn(),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
}));
jest.mock('@renkei/agents', () => ({ parseScheduleConfig: jest.fn() }));
jest.mock('@/lib/batch-jobs/schedule-next-run', () => ({ nextRunAtFor: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET, PUT, DELETE } from './route';

const { getSessionFromRequest } = jest.requireMock<{ getSessionFromRequest: jest.Mock }>('@/lib/session');
const { listConnectedShares } = jest.requireMock<{ listConnectedShares: jest.Mock }>(
  '@renkei/connector-fileshares'
);
const { getSchedule, updateSchedule, deleteSchedule } = jest.requireMock<{
  getSchedule: jest.Mock;
  updateSchedule: jest.Mock;
  deleteSchedule: jest.Mock;
}>('@renkei/batch-jobs-store');
const { parseScheduleConfig } = jest.requireMock<{ parseScheduleConfig: jest.Mock }>('@renkei/agents');
const { nextRunAtFor } = jest.requireMock<{ nextRunAtFor: jest.Mock }>('@/lib/batch-jobs/schedule-next-run');

const SHARE_ID = '11111111-2222-3333-4444-555555555555';
const SCHEDULE_ID = 'sched-1';
const SCHEDULE_CONFIG = { recurrences: [{ every: 'hour' }], timezone: 'UTC' };
const paramsOf = () => Promise.resolve({ tenantId: 'tenant-1', scheduleId: SCHEDULE_ID });

function existingSchedule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SCHEDULE_ID,
    tenant_id: 'tenant-1',
    subject: 'auth0|alice',
    name: 'Nightly OCR',
    kind: 'document-ocr-pipeline',
    config: { shareId: SHARE_ID, path: '/', grouping: { strategy: 'whole-file' } },
    schedule_config: SCHEDULE_CONFIG,
    enabled: true,
    next_run_at: new Date('2026-09-02T00:00:00Z'),
    last_fired_at: null,
    last_error: null,
    created_at: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function reqOf(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://x/api/tenant/tenant-1/batch-job-schedules/${SCHEDULE_ID}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  getSessionFromRequest.mockResolvedValue({ subject: 'auth0|alice' });
  getSchedule.mockResolvedValue(existingSchedule());
  listConnectedShares.mockResolvedValue({ ok: true, val: [{ share: { id: SHARE_ID } }] });
  parseScheduleConfig.mockImplementation((value: unknown) => (value ? SCHEDULE_CONFIG : null));
  nextRunAtFor.mockResolvedValue(new Date('2026-09-03T00:00:00Z'));
  updateSchedule.mockResolvedValue(existingSchedule());
  deleteSchedule.mockResolvedValue(true);
});

describe('GET', () => {
  test('a signed-out request is refused', async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://x'), { params: paramsOf() });
    expect(response.status).toBe(401);
  });

  test('another subject\'s schedule is a 404', async () => {
    getSchedule.mockResolvedValue(existingSchedule({ subject: 'auth0|bob' }));
    const response = await GET(new NextRequest('http://x'), { params: paramsOf() });
    expect(response.status).toBe(404);
  });

  test('returns the schedule', async () => {
    const response = await GET(new NextRequest('http://x'), { params: paramsOf() });
    expect(response.status).toBe(200);
    expect((await response.json()).name).toBe('Nightly OCR');
  });
});

describe('PUT', () => {
  test('a nonexistent schedule is a 404', async () => {
    getSchedule.mockResolvedValue(undefined);
    const response = await PUT(reqOf({ name: 'New name' }), { params: paramsOf() });
    expect(response.status).toBe(404);
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  test('an empty name is a 400', async () => {
    const response = await PUT(reqOf({ name: '  ' }), { params: paramsOf() });
    expect(response.status).toBe(400);
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  test('renaming alone does not recompute next_run_at', async () => {
    const response = await PUT(reqOf({ name: 'Renamed' }), { params: paramsOf() });
    expect(response.status).toBe(200);
    expect(nextRunAtFor).not.toHaveBeenCalled();
    expect(updateSchedule).toHaveBeenCalledWith(
      {},
      SCHEDULE_ID,
      'tenant-1',
      expect.not.objectContaining({ nextRunAt: expect.anything() })
    );
  });

  test('a new scheduleConfig recomputes next_run_at', async () => {
    const response = await PUT(reqOf({ scheduleConfig: SCHEDULE_CONFIG }), { params: paramsOf() });
    expect(response.status).toBe(200);
    expect(nextRunAtFor).toHaveBeenCalled();
    expect(updateSchedule).toHaveBeenCalledWith(
      {},
      SCHEDULE_ID,
      'tenant-1',
      expect.objectContaining({ nextRunAt: new Date('2026-09-03T00:00:00Z') })
    );
  });

  test('re-enabling a disabled schedule recomputes next_run_at', async () => {
    getSchedule.mockResolvedValue(existingSchedule({ enabled: false }));
    const response = await PUT(reqOf({ enabled: true }), { params: paramsOf() });
    expect(response.status).toBe(200);
    expect(nextRunAtFor).toHaveBeenCalled();
  });

  test('disabling a schedule does not recompute next_run_at', async () => {
    const response = await PUT(reqOf({ enabled: false }), { params: paramsOf() });
    expect(response.status).toBe(200);
    expect(nextRunAtFor).not.toHaveBeenCalled();
  });

  test('changing the share requires it to be connected', async () => {
    listConnectedShares.mockResolvedValue({ ok: true, val: [] });
    const response = await PUT(reqOf({ shareId: SHARE_ID, grouping: { strategy: 'whole-file' } }), {
      params: paramsOf(),
    });
    expect(response.status).toBe(400);
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  test('a duplicate name is a 409', async () => {
    updateSchedule.mockRejectedValue(new Error('duplicate key value violates batch_job_schedules_tenant_name'));
    const response = await PUT(reqOf({ name: 'Taken' }), { params: paramsOf() });
    expect(response.status).toBe(409);
  });
});

describe('DELETE', () => {
  test('another subject\'s schedule is a 404', async () => {
    getSchedule.mockResolvedValue(existingSchedule({ subject: 'auth0|bob' }));
    const response = await DELETE(new NextRequest('http://x', { method: 'DELETE' }), { params: paramsOf() });
    expect(response.status).toBe(404);
    expect(deleteSchedule).not.toHaveBeenCalled();
  });

  test('deletes the schedule', async () => {
    const response = await DELETE(new NextRequest('http://x', { method: 'DELETE' }), { params: paramsOf() });
    expect(response.status).toBe(200);
    expect(deleteSchedule).toHaveBeenCalledWith({}, SCHEDULE_ID, 'tenant-1');
  });
});
