import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const fixture = {
  webex_dirty_windows: [
    { room_id: 'room-a', day: '2026-01-01', subject: 'ann', marked_at: at(1) },
    { room_id: 'room-a', day: '2026-01-02', subject: null, marked_at: at(2) },
    { room_id: 'room-b', day: '2026-01-01', subject: 'bob', marked_at: at(3) },
  ],
};

type Window = Awaited<ReturnType<DataStore['webexDirtyWindows']['find']>>;

/** A mark is stamped now(): compare whether it moved past the fixture's time. */
const view = (window: Window) =>
  window ? { ...window, markedAt: window.markedAt.getTime() > at(30).getTime() } : null;

export const webexDirtyWindowScenarios: Scenario<DataStore>[] = [
  {
    method: 'webexDirtyWindows.find',
    name: 'one room-day; other days and rooms miss',
    fixture,
    run: async (store) => [
      await store.webexDirtyWindows.find('room-a', '2026-01-01'),
      await store.webexDirtyWindows.find('room-a', '2026-01-02'),
      await store.webexDirtyWindows.find('room-a', '2026-01-03'),
      await store.webexDirtyWindows.find('room-c', '2026-01-01'),
    ],
  },
  {
    method: 'webexDirtyWindows.markDirty',
    name: 'new mark; a re-mark refreshes the time and keeps a watcher it does not replace',
    fixture,
    run: async (store) => {
      await store.webexDirtyWindows.markDirty('room-c', '2026-01-05', 'carol');
      await store.webexDirtyWindows.markDirty('room-a', '2026-01-01', null);
      await store.webexDirtyWindows.markDirty('room-a', '2026-01-02', 'dan');
      await store.webexDirtyWindows.markDirty('room-d', '2026-01-05', null);
      return [
        view(await store.webexDirtyWindows.find('room-c', '2026-01-05')),
        view(await store.webexDirtyWindows.find('room-a', '2026-01-01')),
        view(await store.webexDirtyWindows.find('room-a', '2026-01-02')),
        view(await store.webexDirtyWindows.find('room-d', '2026-01-05')),
        view(await store.webexDirtyWindows.find('room-b', '2026-01-01')),
      ];
    },
  },
];
