/**
 * Uploads, as the person watching them would describe it: each file's
 * row from queued to added or failed, retry and stop, a batch clearing
 * itself, the table's summary and Failed filter, and the title bar's
 * pill (upload-queue.model.ts). The browser spec (code-uploads.spec.ts)
 * keeps one batch sent for real into the checkout, the tree reading the
 * folder again, and the pill drawn in the title bar.
 */

import {
  activeCount,
  batchProgress,
  clearsItself,
  indicatorView,
  isBatchFinished,
  nextQueued,
  queueReducer,
  rowView,
  sizeLabel,
  tableView,
  thrownOutcome,
  type QueueAction,
  type UploadBatch,
} from './upload-queue.model';

const run = (actions: QueueAction[], from: UploadBatch[] = []) =>
  actions.reduce(queueReducer, from);

const enqueue = (id: string, names: string[], size = 100): QueueAction => ({
  type: 'enqueued',
  id,
  title: `Batch ${id}`,
  destination: 'checkout',
  startedAt: 1_000,
  jobs: names.map((name) => ({ id: `${id}:${name}`, name, size, label: `docs/${name}` })),
});

const ok = (batchId: string, name: string): QueueAction => ({
  type: 'finished',
  batchId,
  jobId: `${batchId}:${name}`,
  outcome: { ok: true },
  aborted: false,
});
const fail = (batchId: string, name: string, error: string): QueueAction => ({
  type: 'finished',
  batchId,
  jobId: `${batchId}:${name}`,
  outcome: { ok: false, error },
  aborted: false,
});
const start = (batchId: string, name: string): QueueAction => ({
  type: 'started',
  batchId,
  jobId: `${batchId}:${name}`,
});

/** The spec's batch: three files into docs/, the empty one refused. */
const docs = run([
  enqueue('b', ['guide.md', 'empty.md', 'notes.md']),
  start('b', 'guide.md'),
  ok('b', 'guide.md'),
  start('b', 'empty.md'),
  fail('b', 'empty.md', 'The file is empty.'),
  start('b', 'notes.md'),
  ok('b', 'notes.md'),
]);

describe('a file’s row', () => {
  it('waits as Queued, goes Uploading with a bar, then says Added', () => {
    const queued = run([enqueue('b', ['a.md'])]);
    expect(rowView(queued[0]!.jobs[0]!).state).toBe('Queued');
    const halfway = run(
      [start('b', 'a.md'), { type: 'progressed', batchId: 'b', jobId: 'b:a.md', loaded: 50 }],
      queued
    );
    expect(rowView(halfway[0]!.jobs[0]!)).toMatchObject({ state: 'Uploading', percent: 50 });
    const added = run([ok('b', 'a.md')], halfway);
    expect(added[0]!.jobs[0]).toMatchObject({ status: 'done', loaded: 100, error: null });
    expect(rowView(added[0]!.jobs[0]!)).toMatchObject({ state: 'Added', retry: false });
  });

  it('a refused file says Failed and why, with Retry', () => {
    const empty = docs[0]!.jobs[1]!;
    expect(rowView(empty)).toEqual({
      percent: 0,
      state: 'Failed',
      retry: true,
      error: 'The file is empty.',
    });
  });

  it('a stopped file says Stopped, and can be sent again', () => {
    const stopped = run([
      enqueue('b', ['a.md']),
      start('b', 'a.md'),
      { type: 'finished', batchId: 'b', jobId: 'b:a.md', outcome: { ok: true }, aborted: true },
    ]);
    expect(rowView(stopped[0]!.jobs[0]!)).toMatchObject({
      state: 'Stopped',
      retry: true,
      error: 'Cancelled.',
    });
  });

  it('a send that throws fails with its message; an abort reads as cancelled', () => {
    expect(thrownOutcome(new Error('Network down'))).toEqual({ ok: false, error: 'Network down' });
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(thrownOutcome(abort)).toEqual({ ok: false, error: 'Cancelled.' });
    expect(thrownOutcome('weird')).toEqual({ ok: false, error: 'The upload failed.' });
  });

  it('a file no longer held fails as gone', () => {
    const lost = run([enqueue('b', ['a.md']), { type: 'lost', batchId: 'b', jobId: 'b:a.md' }]);
    expect(lost[0]!.jobs[0]).toMatchObject({ status: 'failed', error: 'The file is gone.' });
  });

  it('sizes read in B, KB (never 0 KB) and MB', () => {
    expect(sizeLabel(12)).toBe('12 B');
    expect(sizeLabel(1024)).toBe('1 KB');
    expect(sizeLabel(2_621_440)).toBe('2.5 MB');
  });
});

describe('the queue', () => {
  it('takes files in the order they were added', () => {
    const batch = run([enqueue('b', ['a', 'b', 'c']), start('b', 'a')])[0]!;
    expect(nextQueued(batch)?.name).toBe('b');
    expect(nextQueued(undefined)).toBeNull();
  });

  it('counts what is still queued or sending across every batch', () => {
    const two = run([enqueue('x', ['a', 'b']), enqueue('y', ['c']), start('x', 'a'), ok('x', 'a')]);
    expect(activeCount(two)).toBe(2);
    expect(activeCount(docs)).toBe(0);
  });

  it('Retry puts a failed file back in the queue, its error gone', () => {
    const retried = run([{ type: 'retried', batchId: 'b', jobId: 'b:empty.md' }], docs);
    expect(retried[0]!.jobs[1]).toMatchObject({ status: 'queued', loaded: 0, error: null });
    expect(isBatchFinished(retried[0]!)).toBe(false);
  });

  it('Stop cancels what has not started; what is sending answers on its own', () => {
    const stopped = run([
      enqueue('b', ['a', 'b', 'c']),
      start('b', 'a'),
      { type: 'cancelled', batchId: 'b' },
    ]);
    expect(stopped[0]!.jobs.map((job) => job.status)).toEqual([
      'uploading',
      'cancelled',
      'cancelled',
    ]);
  });

  it('a batch with nothing failed clears itself once finished; one with a failure stays', () => {
    const clean = run([enqueue('b', ['a']), start('b', 'a'), ok('b', 'a')]);
    expect(clearsItself(clean[0]!)).toBe(true);
    expect(clearsItself(docs[0]!)).toBe(false);
    expect(clearsItself(run([enqueue('b', ['a'])])[0]!)).toBe(false);
  });

  it('Dismiss forgets a batch', () => {
    expect(run([{ type: 'dismissed', batchId: 'b' }], docs)).toEqual([]);
  });

  it('counts bytes sent, never more than a file’s size', () => {
    const over = run([
      enqueue('b', ['a', 'b']),
      start('b', 'a'),
      { type: 'progressed', batchId: 'b', jobId: 'b:a', loaded: 500 },
    ]);
    expect(batchProgress(over[0]!)).toEqual({
      total: 2,
      done: 0,
      failed: 0,
      pending: 2,
      loaded: 100,
      bytes: 200,
    });
  });
});

describe('the table', () => {
  it('counts as it goes, with a bar', () => {
    const going = run([enqueue('b', ['a', 'b']), start('b', 'a'), ok('b', 'a')]);
    expect(tableView(going[0]!, 'all')).toMatchObject({
      status: '1 of 2 uploaded',
      percent: 50,
      failedLabel: 'Failed',
    });
  });

  it('once done, says how many failed and drops the bar', () => {
    expect(tableView(docs[0]!, 'all')).toMatchObject({
      status: '2 of 3 uploaded · 1 failed',
      percent: null,
      failedLabel: 'Failed (1)',
      empty: null,
    });
    const clean = run([enqueue('b', ['a']), start('b', 'a'), ok('b', 'a')]);
    expect(tableView(clean[0]!, 'all').status).toBe('All 1 uploaded');
  });

  it('Failed narrows the rows to the failures; All shows every row again', () => {
    expect(tableView(docs[0]!, 'failed').rows.map((job) => job.label)).toEqual(['docs/empty.md']);
    expect(tableView(docs[0]!, 'all').rows).toHaveLength(3);
  });

  it('Failed with nothing failed says so', () => {
    const clean = run([enqueue('b', ['a']), start('b', 'a'), ok('b', 'a')]);
    expect(tableView(clean[0]!, 'failed')).toMatchObject({ rows: [], empty: 'Nothing failed.' });
  });
});

describe('the title bar’s pill', () => {
  it('is not there while nothing is queued', () => {
    expect(indicatorView([])).toBeNull();
  });

  it('counts which file is going, over a bar', () => {
    const going = run([
      enqueue('b', ['slow.txt']),
      start('b', 'slow.txt'),
      { type: 'progressed', batchId: 'b', jobId: 'b:slow.txt', loaded: 25 },
    ]);
    expect(indicatorView(going)).toEqual({
      running: true,
      label: 'Uploading 1 of 1',
      compact: '1/1',
      percent: 25,
      failed: false,
    });
  });

  it('once done, says what failed until it is dismissed', () => {
    expect(indicatorView(docs)).toMatchObject({
      running: false,
      label: '1 upload failed',
      compact: '1 failed',
      failed: true,
    });
    const twoFailed = run([
      enqueue('c', ['x', 'y']),
      start('c', 'x'),
      fail('c', 'x', 'no'),
      start('c', 'y'),
      fail('c', 'y', 'no'),
    ]);
    expect(indicatorView(twoFailed)?.label).toBe('2 uploads failed');
  });

  it('with nothing failed, says how many were uploaded', () => {
    const clean = run([enqueue('b', ['a']), start('b', 'a'), ok('b', 'a')]);
    expect(indicatorView(clean)).toMatchObject({
      label: 'Uploaded 1',
      compact: '1',
      failed: false,
    });
  });

  it('counts every batch together', () => {
    const both = run([enqueue('c', ['x']), start('c', 'x')], docs);
    expect(indicatorView(both)).toMatchObject({ running: true, label: 'Uploading 3 of 4' });
  });
});
