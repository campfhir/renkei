import type { Scenario } from '../../domain';
import type { NewRow } from '../../memory/tables';
import type { DataStore } from '../../types';
import type { ArtifactBulkJobRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-3b${String(n).padStart(10, '0')}`;
const file = (n: number) => `00000000-0000-4000-8000-3c${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const TEN_YEARS = 10 * 365 * 24 * 3_600_000;

function row(
  n: number,
  subject: string,
  minute: number,
  extra: Partial<NewRow<'artifact_bulk_jobs'>> = {}
): NewRow<'artifact_bulk_jobs'> {
  return {
    id: id(n),
    subject,
    action: 'delete',
    project_id: null,
    mode: null,
    artifact_ids: [file(1), file(2)],
    results: [],
    status: 'queued',
    last_error: null,
    created_at: at(minute),
    updated_at: at(minute),
    finished_at: null,
    dismissed_at: null,
    ...extra,
  };
}

const fixture = {
  artifact_bulk_jobs: [
    row(1, 'ann', 1),
    row(2, 'ann', 3, {
      status: 'running',
      results: [{ id: file(1), filename: 'a.md', error: null }],
    }),
    row(3, 'ann', 2, {
      action: 'attach',
      project_id: id(90),
      mode: 'always',
      status: 'partial',
      results: [
        { id: file(1), filename: 'a.md', error: null },
        { id: file(2), filename: null, error: 'No such file' },
      ],
      last_error: null,
      finished_at: at(4),
    }),
    row(4, 'ann', 5, { status: 'done', finished_at: at(6), dismissed_at: at(6) }),
    row(5, 'bob', 3, { action: 'ocr', status: 'running' }),
    row(6, 'bob', 0),
  ],
};

/** A record without the times "now" stamps, which the two stores' clocks cannot agree on. */
function settled(job: ArtifactBulkJobRecord | null) {
  if (!job) return null;
  const { updatedAt, finishedAt, dismissedAt, createdAt, ...rest } = job;
  return {
    ...rest,
    created: createdAt.getTime() < at(59).getTime() ? createdAt.toISOString() : 'now',
    touched: updatedAt.getTime() > at(59).getTime(),
    finished:
      finishedAt === null ? null : finishedAt.getTime() > at(59).getTime() ? 'now' : 'before',
    dismissed:
      dismissedAt === null ? null : dismissedAt.getTime() > at(59).getTime() ? 'now' : 'before',
  };
}

export const artifactBulkJobScenarios: Scenario<DataStore>[] = [
  {
    method: 'artifactBulkJobs.create',
    name: 'queued with nothing answered, the files in order, read back the same',
    run: async (store) => {
      const made = await store.artifactBulkJobs.create({
        id: id(20),
        subject: 'ann',
        action: 'attach',
        projectId: id(90),
        mode: 'on_demand',
        artifactIds: [file(3), file(1), file(2)],
      });
      return {
        made: settled(made),
        readBack: settled(await store.artifactBulkJobs.get(id(20))),
      };
    },
  },
  {
    method: 'artifactBulkJobs.get',
    name: 'one job whoever owns it, its answers parsed, or null',
    fixture,
    run: async (store) => [
      settled(await store.artifactBulkJobs.get(id(3))),
      settled(await store.artifactBulkJobs.get(id(5))),
      await store.artifactBulkJobs.get(id(99)),
    ],
  },
  {
    method: 'artifactBulkJobs.listShown',
    name: 'the person’s undismissed jobs, newest first, bounded',
    fixture,
    run: async (store) => ({
      ann: (await store.artifactBulkJobs.listShown('ann', 10)).map((job) => job.id),
      annTwo: (await store.artifactBulkJobs.listShown('ann', 2)).map((job) => job.id),
      bob: (await store.artifactBulkJobs.listShown('bob', 10)).map((job) => job.id),
      nobody: await store.artifactBulkJobs.listShown('cat', 10),
    }),
  },
  {
    method: 'artifactBulkJobs.startQueued',
    name: 'a queued job, once; a running or finished one not',
    fixture,
    run: async (store) => {
      const wins = [
        await store.artifactBulkJobs.startQueued(id(1)),
        await store.artifactBulkJobs.startQueued(id(1)),
        await store.artifactBulkJobs.startQueued(id(2)),
        await store.artifactBulkJobs.startQueued(id(3)),
      ];
      return { wins, after: settled(await store.artifactBulkJobs.get(id(1))) };
    },
  },
  {
    method: 'artifactBulkJobs.reclaimStale',
    name: 'a running job untouched for longer than the bound, once',
    fixture,
    run: async (store) => {
      const wins = [
        await store.artifactBulkJobs.reclaimStale(id(2), TEN_YEARS),
        await store.artifactBulkJobs.reclaimStale(id(2), 90_000),
        await store.artifactBulkJobs.reclaimStale(id(2), 90_000),
        await store.artifactBulkJobs.reclaimStale(id(1), 90_000),
      ];
      return { wins, after: settled(await store.artifactBulkJobs.get(id(2))) };
    },
  },
  {
    method: 'artifactBulkJobs.recordResults',
    name: 'written while running only, in order, only the three fields',
    fixture,
    run: async (store) => {
      const results = [
        { id: file(1), filename: 'a.md', error: null },
        { id: file(2), filename: 'b.md', error: 'The file store refused.' },
      ];
      const wins = [
        await store.artifactBulkJobs.recordResults(id(2), results),
        await store.artifactBulkJobs.recordResults(id(1), results),
        await store.artifactBulkJobs.recordResults(id(3), []),
      ];
      return {
        wins,
        running: settled(await store.artifactBulkJobs.get(id(2))),
        queued: (await store.artifactBulkJobs.get(id(1)))?.results,
      };
    },
  },
  {
    method: 'artifactBulkJobs.finish',
    name: 'a queued or running job ends once; dismissed when asked; the error kept',
    fixture,
    run: async (store) => {
      const wins = [
        await store.artifactBulkJobs.finish(id(2), { status: 'done', dismiss: true }),
        await store.artifactBulkJobs.finish(id(2), { status: 'failed', dismiss: false }),
        await store.artifactBulkJobs.finish(id(1), {
          status: 'failed',
          lastError: 'The project is gone.',
          dismiss: false,
        }),
        await store.artifactBulkJobs.finish(id(3), { status: 'done', dismiss: true }),
      ];
      return {
        wins,
        done: settled(await store.artifactBulkJobs.get(id(2))),
        failed: settled(await store.artifactBulkJobs.get(id(1))),
        shown: (await store.artifactBulkJobs.listShown('ann', 10)).map((job) => job.id),
      };
    },
  },
  {
    method: 'artifactBulkJobs.dismiss',
    name: 'the owner’s finished job, once; not live, not someone else’s',
    fixture,
    run: async (store) => {
      const wins = [
        await store.artifactBulkJobs.dismiss(id(3), 'bob'),
        await store.artifactBulkJobs.dismiss(id(3), 'ann'),
        await store.artifactBulkJobs.dismiss(id(3), 'ann'),
        await store.artifactBulkJobs.dismiss(id(2), 'ann'),
        await store.artifactBulkJobs.dismiss(id(4), 'ann'),
      ];
      return {
        wins,
        shown: (await store.artifactBulkJobs.listShown('ann', 10)).map((job) => job.id),
      };
    },
  },
  {
    method: 'artifactBulkJobs.listRunnable',
    name: 'queued and stale running, least recently touched first, bounded',
    fixture,
    run: async (store) => [
      await store.artifactBulkJobs.listRunnable(90_000, 10),
      await store.artifactBulkJobs.listRunnable(90_000, 2),
      await store.artifactBulkJobs.listRunnable(TEN_YEARS, 10),
    ],
  },
];
