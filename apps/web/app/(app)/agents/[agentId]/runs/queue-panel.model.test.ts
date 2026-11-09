import {
  LEASE_STALE_MS,
  NOT_PICKED_UP_MS,
  queuePanel,
  span,
  type QueueDeadJob,
  type QueueJob,
} from './queue-panel.model';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function job(over: Partial<QueueJob>): QueueJob {
  return {
    id: 'job',
    type: 'run',
    runId: 'aaaaaaaa-1111-4000-8000-000000000001',
    batchId: null,
    status: 'pending',
    attempts: 0,
    lockedAt: null,
    runAfter: ago(MIN),
    lastError: null,
    createdAt: ago(MIN),
    ...over,
  };
}

describe('the Queue panel', () => {
  it('has nothing to say when nothing is queued and nothing was given up on', () => {
    const panel = queuePanel([], [], NOW, 50);
    expect(panel).toMatchObject({ verdict: 'clear', visible: false, head: null });
  });

  it('a head whose worker stopped renewing it is holding the queue, with its last error', () => {
    const panel = queuePanel(
      [
        job({
          status: 'processing',
          attempts: 47,
          lockedAt: ago(9 * DAY),
          lastError: 'key service unavailable',
        }),
        job({ id: 'j2' }),
        job({ id: 'j3' }),
      ],
      [],
      NOW,
      50
    );
    expect(panel.verdict).toBe('held');
    expect(panel.headline).toBe(
      'Run aaaaaaaa is holding the queue: its worker stopped renewing it 9 d ago (47 deliveries so far). The queue will reclaim it, or give up after its last try.'
    );
    expect(panel.head?.error).toBe('key service unavailable');
    expect(panel.behind).toBe('2');
  });

  it('a head a worker renewed recently is being worked on', () => {
    const panel = queuePanel(
      [job({ status: 'processing', attempts: 1, lockedAt: ago(LEASE_STALE_MS - MIN) })],
      [],
      NOW,
      50
    );
    expect(panel.verdict).toBe('moving');
    expect(panel.headline).toBe('Run aaaaaaaa is being worked on now (1 delivery).');
  });

  it('a head waiting out a backoff is retrying, and says when', () => {
    const panel = queuePanel(
      [job({ attempts: 2, runAfter: ahead(2 * MIN), lastError: 'model overloaded' })],
      [],
      NOW,
      50
    );
    expect(panel.verdict).toBe('retrying');
    expect(panel.headline).toBe(
      'Run aaaaaaaa failed and is tried again in 2 min (2 deliveries so far).'
    );
    expect(panel.head?.error).toBe('model overloaded');
  });

  it('a head due for a while that nobody claims says the worker is not taking jobs', () => {
    const panel = queuePanel(
      [job({ createdAt: ago(3 * DAY), runAfter: ago(3 * DAY) })],
      [],
      NOW,
      50
    );
    expect(panel.verdict).toBe('not-picked-up');
    expect(panel.headline).toContain('no worker has picked it up in 3 d');
  });

  it('a head that just arrived is simply next', () => {
    const panel = queuePanel(
      [job({ createdAt: ago(NOT_PICKED_UP_MS - MIN), runAfter: ago(NOT_PICKED_UP_MS - MIN) })],
      [],
      NOW,
      50
    );
    expect(panel).toMatchObject({ verdict: 'moving', headline: 'Run aaaaaaaa is next.' });
  });

  it('says there are more behind when the read was cut off at its limit', () => {
    const jobs = Array.from({ length: 50 }, (_, index) => job({ id: `j${index}` }));
    expect(queuePanel(jobs, [], NOW, 50).behind).toBe('49+');
  });

  it('change batches are listed apart from the runs, and do not count as the head', () => {
    const panel = queuePanel(
      [
        job({
          id: 'b',
          type: 'actions',
          runId: null,
          batchId: 'bbbbbbbb-2222',
          status: 'processing',
          attempts: 1,
        }),
        job({ id: 'r' }),
      ],
      [],
      NOW,
      50
    );
    expect(panel.head?.text).toBe('Run aaaaaaaa is next.');
    expect(panel.batches.map((line) => line.text)).toEqual([
      'A change batch (bbbbbbbb) is being made (1 delivery).',
    ]);
  });

  it('lists what the queue gave up on this week, most recent first, and shows the panel for it alone', () => {
    const dead: QueueDeadJob[] = [
      {
        id: 'd1',
        type: 'run',
        runId: 'cccccccc-3333',
        batchId: null,
        attempts: 3,
        lastError: 'key service unavailable',
        deadAt: ago(2 * 60 * MIN),
      },
      {
        id: 'd2',
        type: 'run',
        runId: 'dddddddd-4444',
        batchId: null,
        attempts: 3,
        lastError: null,
        deadAt: ago(10 * DAY),
      },
    ];
    const panel = queuePanel([], dead, NOW, 50);
    expect(panel.visible).toBe(true);
    expect(panel.gaveUp).toEqual([
      {
        runId: 'cccccccc-3333',
        text: 'Gave up on run cccccccc after 3 deliveries, 2 h ago.',
        error: 'key service unavailable',
      },
    ]);
  });
});

describe('spans', () => {
  it('use the largest whole unit', () => {
    expect([30_000, 5 * MIN, 3 * 60 * MIN, 9 * DAY].map(span)).toEqual([
      '30 s',
      '5 min',
      '3 h',
      '9 d',
    ]);
  });
});
