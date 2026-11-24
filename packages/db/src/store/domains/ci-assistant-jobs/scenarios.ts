import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-a${String(n).padStart(11, '0')}`;
const project = '00000000-0000-4000-8000-b00000000001';
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function job(n: number, subject: string, minute: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    subject,
    project_id: project,
    status: 'running',
    step: null,
    result: null,
    error: null,
    created_at: at(minute),
    updated_at: at(minute),
    finished_at: null,
    ...extra,
  };
}

const fixture = {
  ci_assistant_jobs: [
    job(1, 'ann', 1, { step: 'Reading README.md', updated_at: at(2) }),
    job(2, 'ann', 3, {
      status: 'succeeded',
      result: { reply: 'Done.', proposal: null },
      finished_at: at(4),
      updated_at: at(4),
    }),
    job(3, 'bob', 5, { status: 'failed', error: 'no model', finished_at: at(5) }),
  ],
};

export const ciAssistantJobScenarios: Scenario<DataStore>[] = [
  {
    method: 'ciAssistantJobs.create',
    name: 'running, with its first step, readable by the person who asked',
    fixture: {},
    run: async (store) => {
      const created = await store.ciAssistantJobs.create(
        { id: id(9), subject: 'ann', projectId: project, step: 'Starting' },
        at(10)
      );
      return [created, await store.ciAssistantJobs.find('ann', id(9))];
    },
  },
  {
    method: 'ciAssistantJobs.find',
    name: "the asker's job only",
    fixture,
    run: async (store) => [
      await store.ciAssistantJobs.find('ann', id(2)),
      await store.ciAssistantJobs.find('bob', id(2)),
      await store.ciAssistantJobs.find('ann', id(99)),
    ],
  },
  {
    method: 'ciAssistantJobs.progress',
    name: 'moves the step and heartbeat of a running job only',
    fixture,
    run: async (store) => [
      await store.ciAssistantJobs.progress(id(1), 'Reading package.json', at(20)),
      await store.ciAssistantJobs.progress(id(2), 'Too late', at(20)),
      await store.ciAssistantJobs.find('ann', id(1)),
      await store.ciAssistantJobs.find('ann', id(2)),
    ],
  },
  {
    method: 'ciAssistantJobs.finish',
    name: 'ends a running job once, with its answer or why there is none',
    fixture,
    run: async (store) => [
      await store.ciAssistantJobs.finish(
        id(1),
        { status: 'succeeded', result: { reply: 'Here.', read: ['README.md'] } },
        at(30)
      ),
      await store.ciAssistantJobs.finish(id(1), { status: 'failed', error: 'again' }, at(31)),
      await store.ciAssistantJobs.finish(id(2), { status: 'failed', error: 'late' }, at(31)),
      await store.ciAssistantJobs.find('ann', id(1)),
      await store.ciAssistantJobs.find('ann', id(2)),
    ],
  },
  {
    method: 'ciAssistantJobs.pruneBefore',
    name: 'deletes jobs made before the cut, whatever their status',
    fixture,
    run: async (store) => [
      await store.ciAssistantJobs.pruneBefore(at(3)),
      await store.ciAssistantJobs.find('ann', id(1)),
      await store.ciAssistantJobs.find('ann', id(2)),
      await store.ciAssistantJobs.find('bob', id(3)),
    ],
  },
];
