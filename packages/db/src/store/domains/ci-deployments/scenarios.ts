import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, PROJECT, at, projectRow, uid } from '../chats/fixtures';
import type { CiDeploymentRecord, CiDeploymentReport } from './types';

const row = (
  n: number,
  project: string,
  environment: string,
  minute: number,
  status = 'succeeded'
) => ({
  id: uid(1700 + n),
  project_id: project,
  environment,
  status,
  commit_sha: `c0ffee${n}`,
  branch: environment === 'dev' ? 'develop' : 'main',
  target: 'onprem-app',
  run_id: `bitbucket:${n}`,
  run_url: `https://bitbucket.org/acme/portal/pipelines/results/${n}`,
  detail: null,
  actor: null,
  started_at: at(minute),
  finished_at: status === 'started' ? null : at(minute + 2),
  created_at: at(minute),
  updated_at: at(minute + 2),
});

const fixture = {
  chat_projects: [
    projectRow({ id: PROJECT.annCode, owner_subject: ANN, name: 'portal', kind: 'code' }),
    projectRow({ id: PROJECT.annChat, owner_subject: ANN, name: 'intake', kind: 'code' }),
  ],
  ci_deployments: [
    row(1, PROJECT.annCode, 'dev', 10),
    row(2, PROJECT.annCode, 'dev', 30, 'failed'),
    row(3, PROJECT.annCode, 'production', 20),
    row(4, PROJECT.annChat, 'dev', 40, 'started'),
  ],
};

const report = (overrides: Partial<CiDeploymentReport>): CiDeploymentReport => ({
  projectId: PROJECT.annChat,
  environment: 'production',
  status: 'started',
  commitSha: 'abc1234',
  branch: 'main',
  target: 'onprem-app',
  runId: 'github:2231.1',
  runUrl: 'https://github.com/acme/intake/actions/runs/2231',
  detail: null,
  actor: 'jordan',
  at: at(50),
  ...overrides,
});
const kept = (r: CiDeploymentRecord) => ({ ...r, id: r.id.length > 0 });

export const ciDeploymentScenarios: Scenario<DataStore>[] = [
  {
    method: 'ciDeployments.record',
    name: 'a start, then its end; a late start keeps the end; another run is its own row',
    fixture,
    run: async (store) => {
      const first = await store.ciDeployments.record(report({}));
      const ended = await store.ciDeployments.record(
        report({ status: 'failed', detail: 'exit code 3', target: null, at: at(52) })
      );
      const late = await store.ciDeployments.record(report({ at: at(53) }));
      await store.ciDeployments.record(report({ runId: 'github:2232.1', at: at(60) }));
      const rows = await store.ciDeployments.recent([PROJECT.annChat], 10);
      return { sameRow: first === ended && ended === late, rows: rows.map(kept) };
    },
  },
  {
    method: 'ciDeployments.latest',
    name: 'each project’s newest of each environment',
    fixture,
    run: async (store) => [
      (await store.ciDeployments.latest([PROJECT.annCode, PROJECT.annChat])).map((r) => [
        r.projectId,
        r.environment,
        r.runId,
        r.status,
      ]),
      await store.ciDeployments.latest([]),
    ],
  },
  {
    method: 'ciDeployments.recent',
    name: 'newest first, limited, only the projects asked for',
    fixture,
    run: async (store) => [
      (await store.ciDeployments.recent([PROJECT.annCode, PROJECT.annChat], 3)).map((r) => r.runId),
      (await store.ciDeployments.recent([PROJECT.annCode], 10)).map((r) => r.runId),
      await store.ciDeployments.recent([], 5),
    ],
  },
];
