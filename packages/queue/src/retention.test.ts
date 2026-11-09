/**
 * The settled-row sweep: finished rows past the window go, in batches,
 * table by table; live rows and recent rows stay; it says what it did.
 */

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createSettledRetentionSweep } from './retention';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function row(n: number, status: string, ageDays: number) {
  return {
    id: id(n),
    source: 'agents:a',
    type: 'run',
    payload: { runId: `r${n}` },
    ordering_key: null,
    status,
    attempts: 1,
    run_after: new Date(NOW - ageDays * DAY),
    locked_at: null,
    last_error: null,
    created_at: new Date(NOW - ageDays * DAY),
  };
}

afterEach(() => resetDataStore());

test('deletes settled rows past the window and leaves the rest', async () => {
  const store = createMemoryDataStore();
  await store.seed({
    agent_jobs: [
      row(1, 'processed', 30),
      row(2, 'skipped', 15),
      row(3, 'processed', 3),
      row(4, 'pending', 40),
      row(5, 'processing', 40),
    ],
    events: [row(6, 'processed', 30)],
  });
  registerDataStore(store);
  const lines: string[] = [];
  const sweep = createSettledRetentionSweep({
    tables: ['agent_jobs'],
    logger: { info: (text, attrs) => lines.push(`${text} ${JSON.stringify(attrs)}`) },
    component: 'test',
    now: () => NOW,
  });
  await sweep();
  const left = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => getDataStore().queues.find('agent_jobs', id(n)))
  );
  expect(left.map((r) => r?.status ?? null)).toEqual([
    null,
    null,
    'processed',
    'pending',
    'processing',
  ]);
  // Only the tables it was given.
  expect((await getDataStore().queues.find('events', id(6)))?.status).toBe('processed');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"count":2');
  await sweep();
  expect(lines).toHaveLength(1);
});
