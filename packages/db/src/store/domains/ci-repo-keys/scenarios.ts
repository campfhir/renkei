import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, PROJECT, at, projectRow } from '../chats/fixtures';

const fixture = {
  chat_projects: [
    projectRow({ id: PROJECT.annCode, owner_subject: ANN, name: 'sync-worker', kind: 'code' }),
    projectRow({ id: PROJECT.annChat, owner_subject: ANN, name: 'notes', kind: 'code' }),
    projectRow({ id: PROJECT.bobChat, owner_subject: ANN, name: 'other', kind: 'code' }),
  ],
  ci_repo_keys: [
    {
      project_id: PROJECT.annCode,
      host: 'github',
      repo_key: 'acme/sync-worker',
      created_at: at(10),
      updated_at: at(20),
    },
    {
      project_id: PROJECT.annChat,
      host: 'github',
      repo_key: 'acme/sync-worker',
      created_at: at(11),
      updated_at: at(30),
    },
  ],
};

export const ciRepoKeyScenarios: Scenario<DataStore>[] = [
  {
    method: 'ciRepoKeys.projectsFor',
    name: 'the projects of a host’s repository, the last recorded first, and none for another',
    fixture,
    run: async (store) => [
      await store.ciRepoKeys.projectsFor('github', 'acme/sync-worker'),
      await store.ciRepoKeys.projectsFor('bitbucket', 'acme/sync-worker'),
      await store.ciRepoKeys.projectsFor('github', 'acme/elsewhere'),
    ],
  },
  {
    method: 'ciRepoKeys.set',
    name: 'records a project’s key, and replaces the one it had',
    fixture,
    run: async (store) => {
      await store.ciRepoKeys.set(
        PROJECT.bobChat,
        'bitbucket',
        '8f2c1a9e-0000-4000-8000-00000000abcd'
      );
      await store.ciRepoKeys.set(PROJECT.annCode, 'github', 'acme/renamed');
      return [
        await store.ciRepoKeys.projectsFor('bitbucket', '8f2c1a9e-0000-4000-8000-00000000abcd'),
        await store.ciRepoKeys.projectsFor('github', 'acme/renamed'),
        await store.ciRepoKeys.projectsFor('github', 'acme/sync-worker'),
      ];
    },
  },
];
