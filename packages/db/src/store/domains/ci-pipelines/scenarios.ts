import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, PROJECT, at, projectRow } from '../chats/fixtures';
import type { CiPipelineRecord } from './types';

const spec = {
  checks: [{ block: 'go-test-build', version: 3, inputs: {} }],
  environments: [{ name: 'production', branch: 'main', steps: [] }],
};
const devSpec = { checks: [], environments: [{ name: 'dev', branch: 'develop', steps: [] }] };
const fixture = {
  chat_projects: [
    projectRow({ id: PROJECT.annCode, owner_subject: ANN, name: 'sync-worker', kind: 'code' }),
    projectRow({ id: PROJECT.annChat, owner_subject: ANN, name: 'notes', kind: 'code' }),
  ],
  ci_pipelines: [
    {
      project_id: PROJECT.annCode,
      branch: 'main',
      host: 'github',
      spec,
      written_text: '# Built in Renkei\nname: Pipeline\n',
      written_at: at(30),
      pull_request_url: 'https://github.com/acme/sync-worker/pull/7',
      repo_key: 'acme/sync-worker',
      updated_by: 'ann',
      created_at: at(10),
      updated_at: at(20),
    },
    {
      project_id: PROJECT.annCode,
      branch: 'develop',
      host: 'github',
      spec: devSpec,
      written_text: null,
      written_at: null,
      pull_request_url: null,
      repo_key: 'acme/sync-worker',
      updated_by: 'ann',
      created_at: at(11),
      updated_at: at(21),
    },
  ],
};
/** What a save leaves, without the instants the database picks. */
const kept = (record: CiPipelineRecord | null) =>
  record && {
    branch: record.branch,
    host: record.host,
    spec: record.spec,
    writtenText: record.writtenText,
    pullRequestUrl: record.pullRequestUrl,
    repoKey: record.repoKey,
    updatedBy: record.updatedBy,
  };

export const ciPipelineScenarios: Scenario<DataStore>[] = [
  {
    method: 'ciPipelines.listForProject',
    name: 'a project’s pipelines, by branch',
    fixture,
    run: async (store) => {
      await store.ciPipelines.save(PROJECT.annChat, 'main', {
        host: 'bitbucket',
        spec,
        updatedBy: 'ann',
      });
      return [
        (await store.ciPipelines.listForProject(PROJECT.annCode)).map(kept),
        (await store.ciPipelines.listForProject(PROJECT.annChat)).map(kept),
        await store.ciPipelines.listForProject(PROJECT.bobChat),
      ];
    },
  },
  {
    method: 'ciPipelines.findByRepoKey',
    name: 'by host and repository, the last saved first',
    fixture,
    run: async (store) => [
      (await store.ciPipelines.findByRepoKey('github', 'acme/sync-worker')).map((r) => [
        r.projectId,
        r.branch,
      ]),
      await store.ciPipelines.findByRepoKey('bitbucket', 'acme/sync-worker'),
      await store.ciPipelines.findByRepoKey('github', 'acme/other'),
    ],
  },
  {
    method: 'ciPipelines.setRepoKey',
    name: 'records the repository on each of the project’s pipelines, and refuses a project with none',
    fixture,
    run: async (store) => [
      await store.ciPipelines.setRepoKey(PROJECT.annCode, '8f2c1a9e-0000-4000-8000-00000000abcd'),
      await store.ciPipelines.setRepoKey(PROJECT.annChat, 'x'),
      (await store.ciPipelines.listForProject(PROJECT.annCode)).map((r) => r.repoKey),
    ],
  },
  {
    method: 'ciPipelines.get',
    name: 'a branch’s, and none for another branch or project',
    fixture,
    run: async (store) => [
      await store.ciPipelines.get(PROJECT.annCode, 'main'),
      await store.ciPipelines.get(PROJECT.annCode, 'release'),
      await store.ciPipelines.get(PROJECT.annChat, 'main'),
    ],
  },
  {
    method: 'ciPipelines.save',
    name: 'a new one, and a replaced spec that keeps what was written and leaves the other branch',
    fixture,
    run: async (store) => {
      await store.ciPipelines.save(PROJECT.annChat, 'main', {
        host: 'bitbucket',
        spec,
        updatedBy: 'ann',
      });
      await store.ciPipelines.save(PROJECT.annCode, 'main', {
        host: 'github',
        spec: { checks: [], environments: [] },
        updatedBy: 'bob',
      });
      return [
        kept(await store.ciPipelines.get(PROJECT.annChat, 'main')),
        (await store.ciPipelines.listForProject(PROJECT.annCode)).map(kept),
      ];
    },
  },
  {
    method: 'ciPipelines.markWritten',
    name: 'records the file on its branch, and refuses a branch with no pipeline',
    fixture,
    run: async (store) => [
      await store.ciPipelines.markWritten(PROJECT.annCode, 'main', {
        text: 'name: Pipeline\n',
        pullRequestUrl: 'https://github.com/acme/sync-worker/pull/8',
      }),
      await store.ciPipelines.markWritten(PROJECT.annCode, 'release', {
        text: 'x',
        pullRequestUrl: null,
      }),
      (await store.ciPipelines.listForProject(PROJECT.annCode)).map(kept),
      (await store.ciPipelines.get(PROJECT.annCode, 'main'))?.writtenAt instanceof Date,
    ],
  },
];
