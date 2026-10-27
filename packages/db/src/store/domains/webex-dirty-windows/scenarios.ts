import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const at = (minute: number, ms = 0) => new Date(Date.UTC(2026, 0, 1, 0, minute, 0, ms));

const fixture = {
  webex_dirty_windows: [
    { room_id: 'room-b', day: '2026-01-01', subject: 'ann', marked_at: at(1) },
    { room_id: 'room-a', day: '2026-01-02', subject: null, marked_at: at(1) },
    { room_id: 'room-a', day: '2026-01-01', subject: 'bob', marked_at: at(1) },
    { room_id: 'room-c', day: '2026-01-01', subject: 'ann', marked_at: at(5, 250) },
    { room_id: 'room-d', day: '2026-01-01', subject: 'ann', marked_at: at(9) },
  ],
};

const all = (store: DataStore) => store.webexDirtyWindows.listQuiet(at(1000), 100);

export const webexDirtyWindowScenarios: Scenario<DataStore>[] = [
  {
    method: 'webexDirtyWindows.listQuiet',
    name: 'at or before the cutoff, oldest first, ties by room then day; limited; empty',
    fixture,
    run: async (store) => [
      await store.webexDirtyWindows.listQuiet(at(5, 250), 10),
      await store.webexDirtyWindows.listQuiet(at(5, 250), 2),
      await store.webexDirtyWindows.listQuiet(at(0), 10),
    ],
  },
  {
    method: 'webexDirtyWindows.delete',
    name: 'unconditional, or only when the mark is unchanged (to the millisecond)',
    fixture,
    run: async (store) => [
      await store.webexDirtyWindows.delete('room-b', '2026-01-01'),
      await store.webexDirtyWindows.delete('room-c', '2026-01-01', { markedAt: at(5, 249) }),
      await store.webexDirtyWindows.delete('room-c', '2026-01-01', { markedAt: at(5, 250) }),
      await store.webexDirtyWindows.delete('room-a', '2026-01-03'),
      await store.webexDirtyWindows.delete('room-a', '2026-01-02', { markedAt: at(1) }),
      (await all(store)).map((w) => `${w.roomId}/${w.day}`),
    ],
  },
  {
    method: 'webexDirtyWindows.markIfAbsent',
    name: 'a new mark lands now; an existing one keeps its subject and time',
    fixture,
    run: async (store) => {
      await store.webexDirtyWindows.markIfAbsent('room-b', '2026-01-01', 'cy');
      await store.webexDirtyWindows.markIfAbsent('room-z', '2026-01-04', 'cy');
      const before = new Date(Date.now() + 60_000);
      const windows = await store.webexDirtyWindows.listQuiet(before, 100);
      return windows.map((w) => ({
        ...w,
        markedAt: w.roomId === 'room-z' ? w.markedAt.getTime() > at(1000).getTime() : w.markedAt,
      }));
    },
  },
];
