import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, PROJECT, at, projectRow } from '../chats/fixtures';
import type { CiPipelineRecord } from './types';

const spec = {
  checks: [{ block: 'go-test-build', version: 3, inputs: {} }],
  environments: [{ name: 'production', branch: 'main', steps: [] }],
};
const fixture = {
  chat_projects: [
    projectRow({ id: PROJECT.annCode, owner_subject: ANN, name: 'sync-worker', kind: 'code' }),
    projectRow({ id: PROJECT.annChat, owner_subject: ANN, name: 'notes', kind: 'code' }),
  ],
  ci_pipelines: [
    {
      project_id: PROJECT.annCode,
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
  ],
};
/** What a save leaves, without the instants the database picks. */
const kept = (record: CiPipelineRecord | null) =>
  record && {
    host: record.host,
    spec: record.spec,
    writtenText: record.writtenText,
    pullRequestUrl: record.pullRequestUrl,
    repoKey: record.repoKey,
    updatedBy: record.updatedBy,
  };

export const ciPipelineScenarios: Scenario<DataStore>[] = [
  {
    method: 'ciPipelines.list',
    name: 'every pipeline, by project',
    fixture,
    run: async (store) => {
      await store.ciPipelines.save(PROJECT.annChat, { host: 'bitbucket', spec, updatedBy: 'ann' });
      return (await store.ciPipelines.list()).map(kept);
    },
  },
  {
    method: 'ciPipelines.findByRepoKey',
    name: 'by host and repository, the last saved first',
    fixture,
    run: async (store) => [
      (await store.ciPipelines.findByRepoKey('github', 'acme/sync-worker')).map((r) => r.projectId),
      await store.ciPipelines.findByRepoKey('bitbucket', 'acme/sync-worker'),
      await store.ciPipelines.findByRepoKey('github', 'acme/other'),
    ],
  },
  {
    method: 'ciPipelines.setRepoKey',
    name: 'records the repository, and refuses a project with no pipeline',
    fixture,
    run: async (store) => [
      await store.ciPipelines.setRepoKey(PROJECT.annCode, '8f2c1a9e-0000-4000-8000-00000000abcd'),
      await store.ciPipelines.setRepoKey(PROJECT.annChat, 'x'),
      (await store.ciPipelines.get(PROJECT.annCode))?.repoKey,
    ],
  },
  {
    method: 'ciPipelines.get',
    name: 'one, and none',
    fixture,
    run: async (store) => [
      await store.ciPipelines.get(PROJECT.annCode),
      await store.ciPipelines.get(PROJECT.annChat),
    ],
  },
  {
    method: 'ciPipelines.save',
    name: 'a new one, and a replaced spec that keeps what was written',
    fixture,
    run: async (store) => {
      await store.ciPipelines.save(PROJECT.annChat, { host: 'bitbucket', spec, updatedBy: 'ann' });
      await store.ciPipelines.save(PROJECT.annCode, {
        host: 'github',
        spec: { checks: [], environments: [] },
        updatedBy: 'bob',
      });
      return [
        kept(await store.ciPipelines.get(PROJECT.annChat)),
        kept(await store.ciPipelines.get(PROJECT.annCode)),
      ];
    },
  },
  {
    method: 'ciPipelines.markWritten',
    name: 'records the file, and refuses a project with no pipeline',
    fixture,
    run: async (store) => [
      await store.ciPipelines.markWritten(PROJECT.annCode, {
        text: 'name: Pipeline\n',
        pullRequestUrl: 'https://github.com/acme/sync-worker/pull/8',
      }),
      await store.ciPipelines.markWritten(PROJECT.annChat, { text: 'x', pullRequestUrl: null }),
      kept(await store.ciPipelines.get(PROJECT.annCode)),
      (await store.ciPipelines.get(PROJECT.annCode))?.writtenAt instanceof Date,
    ],
  },
];
