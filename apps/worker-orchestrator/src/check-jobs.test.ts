import { CheckJobs, type CheckJobView } from './check-jobs';

/** The job until it ends. */
async function ended(jobs: CheckJobs): Promise<CheckJobView> {
  for (let i = 0; i < 200; i += 1) {
    const job = jobs.current();
    if (job && job.state !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the job never ended');
}

describe('Test connection as a job', () => {
  it('is answered at once, says each step, and keeps its answer after it ends', async () => {
    const steps: string[] = [];
    const jobs = new CheckJobs({ newId: () => 'job-1', onStep: (_job, text) => steps.push(text) });
    expect(jobs.current()).toBeNull();
    const started = jobs.start(async ({ step }) => {
      step('Reaching the group.');
      step('Making a test sandbox.');
      return { ok: true, detail: 'Its worker answered.' };
    });
    expect(started).toMatchObject({ id: 'job-1', state: 'running', endedAt: null });
    const job = await ended(jobs);
    expect(job).toMatchObject({ state: 'passed', detail: 'Its worker answered.' });
    expect(job.steps.map((s) => s.text)).toEqual(['Reaching the group.', 'Making a test sandbox.']);
    expect(job.endedAt).not.toBeNull();
    expect(steps).toEqual(['Reaching the group.', 'Making a test sandbox.']);
  });

  it('is cancelled when it runs past its time, and says so', async () => {
    const jobs = new CheckJobs({ newId: () => 'job-1', timeoutMs: 20 });
    jobs.start(
      ({ signal }) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () =>
            resolve({ ok: false, detail: 'Its sandbox was removed.' })
          )
        )
    );
    expect(await ended(jobs)).toMatchObject({
      state: 'cancelled',
      detail:
        'Cancelled: it ran past 0 minutes, the longest a test may take. Its sandbox was removed.',
    });
  });

  it('that throws ends failed, in a sentence', async () => {
    const jobs = new CheckJobs({ newId: () => 'job-1' });
    jobs.start(async () => {
      throw new Error('no provider');
    });
    expect(await ended(jobs)).toMatchObject({
      state: 'failed',
      detail: 'The test could not run: no provider',
    });
  });

  it('a new one can start once the last has ended', async () => {
    let n = 0;
    const jobs = new CheckJobs({ newId: () => `job-${(n += 1)}` });
    jobs.start(async () => ({ ok: false, detail: 'no' }));
    await ended(jobs);
    expect(jobs.start(async () => ({ ok: true, detail: 'yes' })).id).toBe('job-2');
  });
});
