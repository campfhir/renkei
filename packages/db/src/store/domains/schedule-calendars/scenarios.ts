import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-ca${String(n).padStart(10, '0')}`;

const fixture = {
  schedule_calendars: [
    {
      id: id(1),
      name: 'US holidays',
      dates: [{ date: '2026-07-04', label: 'Independence Day' }],
      updated_at: '2026-01-02T00:00:00.000Z',
    },
    { id: id(2), name: 'office closures', dates: [], updated_at: '2026-01-01T00:00:00.000Z' },
    { id: id(3), name: 'Company', dates: [{ date: '2026-12-25' }] },
  ],
};

// jsonb arrays go in as JSON text: pg would send a JS array as a Postgres array literal.
const asJson = (rows: typeof fixture.schedule_calendars) =>
  rows.map((row) => ({ ...row, dates: JSON.stringify(row.dates) }));

const seeded = { schedule_calendars: asJson(fixture.schedule_calendars) };

const names = async (store: DataStore) =>
  (await store.scheduleCalendars.list()).map((c) => [c.name, c.dates]);

export const scheduleCalendarScenarios: Scenario<DataStore>[] = [
  {
    method: 'scheduleCalendars.list',
    name: 'by name under collation, dates as stored',
    fixture: seeded,
    run: async (store) =>
      (await store.scheduleCalendars.list()).map((c) => ({ ...c, updatedAt: undefined })),
  },
  {
    method: 'scheduleCalendars.list',
    name: 'none',
    run: (store) => store.scheduleCalendars.list(),
  },
  {
    method: 'scheduleCalendars.create',
    name: 'adds one; a taken name is a duplicate',
    fixture: seeded,
    run: async (store) => [
      await store.scheduleCalendars.create({
        id: id(4),
        name: 'EU',
        dates: [{ date: '2026-05-01' }],
      }),
      await store.scheduleCalendars.create({ id: id(5), name: 'Company', dates: [] }),
      await names(store),
    ],
  },
  {
    method: 'scheduleCalendars.update',
    name: 'renames and re-dates; a taken name and a stranger',
    fixture: seeded,
    run: async (store) => [
      await store.scheduleCalendars.update(id(2), { name: 'Closures', dates: [{ date: 'x' }] }),
      await store.scheduleCalendars.update(id(2), { name: 'Closures', dates: [] }),
      await store.scheduleCalendars.update(id(3), { name: 'US holidays', dates: [] }),
      await store.scheduleCalendars.update(id(9), { name: 'Nobody', dates: [] }),
      await names(store),
    ],
  },
  {
    method: 'scheduleCalendars.delete',
    name: 'deletes once',
    fixture: seeded,
    run: async (store) => [
      await store.scheduleCalendars.delete(id(1)),
      await store.scheduleCalendars.delete(id(1)),
      await names(store),
    ],
  },
];
