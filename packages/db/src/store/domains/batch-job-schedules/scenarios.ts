import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { BatchJobScheduleRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const MISSING = id(999);

function schedule(n: number, subject: string, name: string, fields: Record<string, unknown> = {}) {
  return {
    id: id(n),
    subject,
    name,
    kind: 'document-ocr-pipeline',
    config: JSON.stringify({ shareId: 'share-1', path: '/in' }),
    schedule_config: JSON.stringify({
      recurrences: [{ every: 'day', at: '02:00' }],
      timezone: 'UTC',
    }),
    next_run_at: at(60 + n),
    created_at: at(n),
    ...fields,
  };
}

const fixture = {
  batch_job_schedules: [
    schedule(1, 'ann', 'beta'),
    schedule(2, 'ann', 'Alpha', { enabled: false, next_run_at: null }),
    schedule(3, 'ann', 'alpha', { last_error: 'No share', last_fired_at: at(30) }),
    schedule(4, 'bob', 'Bob nightly'),
    schedule(5, 'ann', 'Zed', { config: '[]', schedule_config: '"weird"' }),
  ],
  batch_jobs: [
    {
      id: id(20),
      subject: 'ann',
      name: 'From beta',
      kind: 'document-ocr-pipeline',
      schedule_id: id(1),
      created_at: at(5),
    },
  ],
  schedule_calendars: [
    {
      id: id(40),
      name: 'Holidays',
      dates: JSON.stringify([{ date: '2026-12-25', label: 'Christmas' }]),
    },
    { id: id(41), name: 'Empty', dates: '[]' },
  ],
};

/** A schedule without its created_at, which a fresh row takes from now(). */
function settled(record: BatchJobScheduleRecord | undefined) {
  if (!record) return record;
  const { createdAt: _createdAt, ...rest } = record;
  return rest;
}

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ ok: value }),
    (error: { code?: string; constraint?: string }) => ({
      refused: error.code ?? 'error',
      constraint: error.constraint ?? null,
    })
  );

export const batchJobScheduleScenarios: Scenario<DataStore>[] = [
  {
    method: 'batchJobSchedules.create',
    name: 'enabled by default; a taken name is refused on its constraint',
    fixture,
    run: async (store) => {
      const made = await store.batchJobSchedules.create({
        id: id(10),
        subject: 'ann',
        name: 'Weekly',
        kind: 'document-ocr-pipeline',
        config: { shareId: 'share-2', grouping: { strategy: 'whole-file' } },
        scheduleConfig: { recurrences: [{ every: 'week', on: ['mon'], at: '06:00' }] },
        nextRunAt: new Date(at(90)),
      });
      return {
        made: settled(made),
        reread: settled(await store.batchJobSchedules.get(id(10))),
        taken: await outcome(
          store.batchJobSchedules.create({
            subject: 'bob',
            name: 'beta',
            kind: 'k',
            config: {},
            scheduleConfig: {},
            nextRunAt: null,
          })
        ),
        list: (await store.batchJobSchedules.list('ann')).map((s) => s.name),
      };
    },
  },
  {
    method: 'batchJobSchedules.get',
    name: 'by id, JSON as stored, missing and malformed ids',
    fixture,
    run: async (store) => [
      await store.batchJobSchedules.get(id(3)),
      await store.batchJobSchedules.get(id(5)),
      await store.batchJobSchedules.get(MISSING),
      await outcome(store.batchJobSchedules.get('nope')),
    ],
  },
  {
    method: 'batchJobSchedules.list',
    name: 'by name under collation, ties by id, own rows only',
    fixture,
    run: async (store) => [
      await store.batchJobSchedules.list('ann'),
      (await store.batchJobSchedules.list('bob')).map((s) => s.id),
      await store.batchJobSchedules.list('nobody'),
    ],
  },
  {
    method: 'batchJobSchedules.update',
    name: 'only the given fields change; a taken name is refused; missing is undefined',
    fixture,
    run: async (store) => [
      settled(
        await store.batchJobSchedules.update(id(2), {
          enabled: true,
          nextRunAt: new Date(at(120)),
        })
      ),
      settled(
        await store.batchJobSchedules.update(id(1), {
          name: 'Beta renamed',
          config: { shareId: 'share-3', path: '/x' },
          scheduleConfig: { recurrences: [], timezone: 'Asia/Tokyo' },
        })
      ),
      settled(await store.batchJobSchedules.update(id(3), { nextRunAt: null })),
      settled(await store.batchJobSchedules.update(id(4), {})),
      await outcome(store.batchJobSchedules.update(id(4), { name: 'Zed' })),
      settled(await store.batchJobSchedules.update(MISSING, { enabled: false })),
      (await store.batchJobSchedules.list('ann')).map((s) => [s.name, s.enabled]),
    ],
  },
  {
    method: 'batchJobSchedules.delete',
    name: 'deletes once; the batches it spawned stay, unlinked',
    fixture,
    run: async (store) => [
      await store.batchJobSchedules.delete(id(1)),
      await store.batchJobSchedules.delete(id(1)),
      await store.batchJobSchedules.delete(MISSING),
      await store.batchJobSchedules.get(id(1)),
      (await store.batchJobs.get(id(20)))?.scheduleId,
      (await store.batchJobSchedules.list('ann')).map((s) => s.id),
    ],
  },
  {
    method: 'batchJobSchedules.calendarDates',
    name: 'dates as stored, the default, missing and malformed ids',
    fixture,
    run: async (store) => [
      await store.batchJobSchedules.calendarDates(id(40)),
      await store.batchJobSchedules.calendarDates(id(41)),
      await store.batchJobSchedules.calendarDates(MISSING),
      await outcome(store.batchJobSchedules.calendarDates('nope')),
    ],
  },
  {
    method: 'batchJobSchedules.listDue',
    name: 'enabled and due, anyone’s, soonest first (ties by id); limited; future and off skipped',
    fixture: {
      batch_job_schedules: [
        ...fixture.batch_job_schedules,
        schedule(6, 'cy', 'Later', { next_run_at: '2099-01-01T00:00:00.000Z' }),
        schedule(7, 'cy', 'Tied', { next_run_at: at(61) }),
      ],
    },
    run: async (store) => [
      (await store.batchJobSchedules.listDue(10)).map((s) => s.id),
      (await store.batchJobSchedules.listDue(2)).map((s) => s.id),
      (await store.batchJobSchedules.listDue(10))[0],
    ],
  },
  {
    method: 'batchJobSchedules.advance',
    name: 'only while next run is still the observed one; fired stamped',
    fixture,
    run: async (store) => {
      const next = new Date('2026-06-01T02:00:00.000Z');
      const won = await store.batchJobSchedules.advance(id(1), new Date(at(61)), next);
      const lost = await store.batchJobSchedules.advance(id(1), new Date(at(61)), next);
      const missing = await store.batchJobSchedules.advance(MISSING, new Date(at(61)), next);
      const read = await store.batchJobSchedules.get(id(1));
      return {
        won,
        lost,
        missing,
        nextRunAt: read?.nextRunAt,
        fired: read?.lastFiredAt !== null,
        other: (await store.batchJobSchedules.get(id(4)))?.lastFiredAt,
      };
    },
  },
  {
    method: 'batchJobSchedules.clearError',
    name: 'the error cleared; others keep theirs',
    fixture: {
      batch_job_schedules: [
        schedule(3, 'ann', 'alpha', { last_error: 'No share' }),
        schedule(8, 'ann', 'beta', { last_error: 'Other' }),
      ],
    },
    run: async (store) => {
      await store.batchJobSchedules.clearError(id(3));
      return [
        (await store.batchJobSchedules.get(id(3)))?.lastError,
        (await store.batchJobSchedules.get(id(8)))?.lastError,
      ];
    },
  },
  {
    method: 'batchJobSchedules.recordError',
    name: 'the message recorded; disable turns it off, otherwise left on',
    fixture,
    run: async (store) => {
      await store.batchJobSchedules.recordError(id(1), 'Malformed', { disable: true });
      await store.batchJobSchedules.recordError(id(4), 'Share gone');
      await store.batchJobSchedules.recordError(MISSING, 'nobody');
      const view = async (n: number) => {
        const s = await store.batchJobSchedules.get(id(n));
        return s && { lastError: s.lastError, enabled: s.enabled };
      };
      return [await view(1), await view(4), await view(3)];
    },
  },
];
