import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, PROJECT, at, projectRow } from '../chats/fixtures';
import type { CiEnvironmentRecord } from './types';

const fixture = {
  chat_projects: [
    projectRow({ id: PROJECT.annCode, owner_subject: ANN, name: 'sync-worker', kind: 'code' }),
    projectRow({ id: PROJECT.annChat, owner_subject: ANN, name: 'notes', kind: 'code' }),
  ],
  ci_environments: [
    {
      project_id: PROJECT.annCode,
      position: 1,
      name: 'dev',
      production: false,
      branches: ['develop', 'feature/intake'],
      updated_by: 'ann',
      created_at: at(10),
      updated_at: at(20),
    },
    {
      project_id: PROJECT.annCode,
      position: 0,
      name: 'production',
      production: true,
      branches: ['main'],
      updated_by: 'ann',
      created_at: at(10),
      updated_at: at(20),
    },
  ],
};
/** A row without the instant the database picks on a write. */
const kept = (record: CiEnvironmentRecord) => ({
  projectId: record.projectId,
  name: record.name,
  production: record.production,
  branches: record.branches,
  updatedBy: record.updatedBy,
});

export const ciEnvironmentScenarios: Scenario<DataStore>[] = [
  {
    method: 'ciEnvironments.list',
    name: 'a project’s environments in their order, and none for another',
    fixture,
    run: async (store) => [
      await store.ciEnvironments.list(PROJECT.annCode),
      await store.ciEnvironments.list(PROJECT.annChat),
    ],
  },
  {
    method: 'ciEnvironments.replace',
    name: 'the whole list is replaced, in the order given, and can be emptied',
    fixture,
    run: async (store) => {
      await store.ciEnvironments.replace(
        PROJECT.annCode,
        [
          { name: 'staging', production: false, branches: [] },
          { name: 'live', production: true, branches: ['release'] },
        ],
        'bob'
      );
      await store.ciEnvironments.replace(
        PROJECT.annChat,
        [{ name: 'production', production: true, branches: ['main'] }],
        'ann'
      );
      const replaced = (await store.ciEnvironments.list(PROJECT.annCode)).map(kept);
      const added = (await store.ciEnvironments.list(PROJECT.annChat)).map(kept);
      await store.ciEnvironments.replace(PROJECT.annChat, [], 'ann');
      return [replaced, added, await store.ciEnvironments.list(PROJECT.annChat)];
    },
  },
];
