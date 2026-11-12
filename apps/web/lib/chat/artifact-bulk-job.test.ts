/**
 * The library's bulk jobs (artifact-bulk-job.ts) on the memory store: what
 * a request is taken as, how a job runs through its files and ends, that
 * only one caller runs it, that a job whose process went away is taken over
 * and carries on where it stopped, and the sweep that does that. Each file's
 * own act is the one-file route's, tested there; here it is a stand-in.
 */

import { randomUUID } from 'node:crypto';
import {
  createMemoryDataStore,
  getDataStore,
  registerDataStore,
  resetDataStore,
  type ArtifactBulkJobRecord,
} from '@renkei/db';
import {
  BULK_MAX_FILES,
  BULK_STALE_MS,
  dismissBulkJob,
  listShownBulkJobs,
  outcomeOf,
  parseBulkRequest,
  queueBulkJob,
  runBulkJob,
  startBulkJobRecovery,
  type BulkAct,
} from './artifact-bulk-job';

const ME = 'me-subject';
const START = new Date('2026-11-01T09:00:00.000Z').getTime();

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  jest.useFakeTimers({ now: START, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
  resetDataStore();
});

const ids = (count: number) => Array.from({ length: count }, () => randomUUID());

/** A stand-in act: each file named after its place, the ones in `failing` refused. */
function fakeAct(failing: readonly string[] = []) {
  const done: string[] = [];
  const act: BulkAct = async (_job, artifactId) => {
    done.push(artifactId);
    return {
      id: artifactId,
      filename: `${artifactId.slice(0, 4)}.md`,
      error: failing.includes(artifactId) ? 'The file store refused.' : null,
    };
  };
  return { act, done };
}

async function queued(artifactIds: string[]): Promise<ArtifactBulkJobRecord> {
  const job = await queueBulkJob(ME, { action: 'delete', artifactIds });
  if (!job.ok) throw new Error(job.err.message);
  return job.val;
}

describe('what a request is taken as', () => {
  const [a, b] = ids(2);

  it('a delete or OCR names the files, each once', () => {
    expect(parseBulkRequest({ action: 'delete', artifactIds: [a, b, a] })).toEqual({
      ok: true,
      val: { action: 'delete', artifactIds: [a, b] },
    });
    expect(parseBulkRequest({ action: 'ocr', artifactIds: [a] })).toMatchObject({ ok: true });
  });

  it('an add names the project, on demand unless it says always', () => {
    const project = randomUUID();
    expect(parseBulkRequest({ action: 'attach', artifactIds: [a], projectId: project })).toEqual({
      ok: true,
      val: { action: 'attach', artifactIds: [a], projectId: project, mode: 'on_demand' },
    });
    expect(
      parseBulkRequest({ action: 'attach', artifactIds: [a], projectId: project, mode: 'always' })
    ).toMatchObject({ ok: true, val: { mode: 'always' } });
    expect(parseBulkRequest({ action: 'attach', artifactIds: [a] })).toMatchObject({
      ok: false,
      err: { status: 400, message: 'Choose a project' },
    });
  });

  it('refuses an unknown act, no files, a malformed id, and too many files', () => {
    expect(parseBulkRequest({ action: 'rename', artifactIds: [a] })).toMatchObject({ ok: false });
    expect(parseBulkRequest({ action: 'delete', artifactIds: [] })).toMatchObject({ ok: false });
    expect(parseBulkRequest({ action: 'delete', artifactIds: [a, 'nope'] })).toMatchObject({
      ok: false,
    });
    expect(parseBulkRequest(null)).toMatchObject({ ok: false });
    expect(
      parseBulkRequest({ action: 'delete', artifactIds: ids(BULK_MAX_FILES + 1) })
    ).toMatchObject({ ok: false, err: { code: 'too-many' } });
  });

  it('refuses up front a project the person cannot see, and OCR that is not set up', async () => {
    expect(
      await queueBulkJob(ME, {
        action: 'attach',
        artifactIds: [a],
        projectId: randomUUID(),
        mode: 'on_demand',
      })
    ).toMatchObject({ ok: false, err: { status: 404, message: 'No such project' } });
    expect(await queueBulkJob(ME, { action: 'ocr', artifactIds: [a] })).toMatchObject({
      ok: false,
      err: { status: 503 },
    });
    expect(await listShownBulkJobs(ME)).toEqual([]);
  });
});

describe('a job', () => {
  it('waits queued, showing every file still to do, until it runs', async () => {
    const files = ids(3);
    const job = await queued(files);
    expect(await listShownBulkJobs(ME)).toEqual([
      expect.objectContaining({
        id: job.id,
        action: 'delete',
        status: 'queued',
        total: 3,
        answered: 0,
        pendingIds: files,
      }),
    ]);
  });

  it('does every file in order and, with nothing failed, ends done and out of sight', async () => {
    const files = ids(3);
    const job = await queued(files);
    const { act, done } = fakeAct();
    await runBulkJob(job.id, act);
    expect(done).toEqual(files);
    expect(await getDataStore().artifactBulkJobs.get(job.id)).toMatchObject({ status: 'done' });
    expect(await listShownBulkJobs(ME)).toEqual([]);
  });

  it('a file that fails does not stop the rest; the job stays on screen naming it until closed', async () => {
    const files = ids(3);
    const job = await queued(files);
    const { act } = fakeAct([files[1]]);
    await runBulkJob(job.id, act);
    const [shown] = await listShownBulkJobs(ME);
    expect(shown).toMatchObject({
      status: 'partial',
      answered: 3,
      pendingIds: [],
      failures: [
        { id: files[1], filename: `${files[1].slice(0, 4)}.md`, error: 'The file store refused.' },
      ],
    });
    expect(await dismissBulkJob('someone-else', job.id)).toBe(false);
    expect(await dismissBulkJob(ME, job.id)).toBe(true);
    expect(await listShownBulkJobs(ME)).toEqual([]);
  });

  it('an act that throws is a failed file, and the job goes on', async () => {
    const files = ids(2);
    const job = await queued(files);
    const done: string[] = [];
    await runBulkJob(job.id, async (_job, artifactId) => {
      done.push(artifactId);
      if (artifactId === files[0]) throw new Error('boom');
      return { id: artifactId, filename: 'b.md', error: null };
    });
    expect(done).toEqual(files);
    const [shown] = await listShownBulkJobs(ME);
    expect(shown.failures).toEqual([
      { id: files[0], filename: null, error: 'Something went wrong; it was not done.' },
    ]);
  });

  it('runs once however many callers start it', async () => {
    const job = await queued(ids(2));
    const { act, done } = fakeAct();
    await Promise.all([runBulkJob(job.id, act), runBulkJob(job.id, act)]);
    await runBulkJob(job.id, act);
    expect(done).toHaveLength(2);
  });

  it('a job whose process went away is taken over and carries on with the files left', async () => {
    const files = ids(3);
    const job = await queued(files);
    const jobs = getDataStore().artifactBulkJobs;
    // Its process started it, answered the first file, and was gone.
    await jobs.startQueued(job.id);
    await jobs.recordResults(job.id, [{ id: files[0], filename: 'a.md', error: null }]);
    const { act, done } = fakeAct();

    // Still fresh: nobody takes it over yet.
    await runBulkJob(job.id, act);
    expect(done).toEqual([]);

    jest.setSystemTime(START + BULK_STALE_MS + 1000);
    await runBulkJob(job.id, act);
    expect(done).toEqual([files[1], files[2]]);
    const after = await jobs.get(job.id);
    expect(after?.status).toBe('done');
    expect(after?.results.map((result) => result.id)).toEqual(files);
  });

  it('the sweep starts a queued job whose request’s process never did', async () => {
    const job = await queued([randomUUID()]);
    const stop = startBulkJobRecovery(1000);
    await jest.advanceTimersByTimeAsync(1000);
    stop();
    // Nothing by that id exists: the real act answers so, and the job ends failed.
    const [shown] = await listShownBulkJobs(ME);
    expect(shown).toMatchObject({
      id: job.id,
      status: 'failed',
      failures: [{ filename: null, error: 'No such file' }],
    });
  });
});

describe('how a job ends', () => {
  const line = (error: string | null) => ({ id: randomUUID(), filename: null, error });

  it('done with no failure, failed with nothing through, partial between', () => {
    expect(outcomeOf([line(null), line(null)])).toBe('done');
    expect(outcomeOf([line('x'), line('y')])).toBe('failed');
    expect(outcomeOf([line(null), line('y')])).toBe('partial');
  });
});
