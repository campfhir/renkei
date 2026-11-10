/**
 * The queue retention sweep: finished rows past the window and dead letters
 * past theirs go, in batches, table by table; live rows and recent rows
 * stay; it says what it did.
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

function dead(n: number, ageDays: number) {
  return {
    id: id(n),
    source: 'agents:a',
    type: 'run',
    payload: { runId: `r${n}` },
    ordering_key: null,
    attempts: 3,
    last_error: 'boom',
    created_at: new Date(NOW - (ageDays + 1) * DAY),
    dead_at: new Date(NOW - ageDays * DAY),
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
    agent_jobs_dead_letters: [dead(7, 45), dead(8, 29)],
    events_dead_letters: [dead(9, 45)],
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
  // Dead letters past 30 days go; a newer one and another table's stay.
  expect((await getDataStore().queues.listDeadLetters('agent_jobs', 10)).map((d) => d.id)).toEqual([
    id(8),
  ]);
  expect((await getDataStore().queues.listDeadLetters('events', 10)).map((d) => d.id)).toEqual([
    id(9),
  ]);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('"count":2');
  expect(lines[1]).toContain('dead letter');
  await sweep();
  expect(lines).toHaveLength(2);
});
