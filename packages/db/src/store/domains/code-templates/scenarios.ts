import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { uid } from '../chats/fixtures';

const fixture = {
  code_project_templates: [
    { id: uid(1301), name: 'node', description: null, instructions: 'npm test' },
    { id: uid(1302), name: 'Go', description: 'go', instructions: 'go test' },
  ],
  pipeline_templates: [
    { id: uid(1311), provider: 'atlassian-bitbucket', name: 'b', body: 'pipelines: {}' },
    { id: uid(1312), provider: 'atlassian-bitbucket', name: 'A', body: 'x' },
    { id: uid(1313), provider: 'github', name: 'gh', description: 'd', body: 'on: push' },
  ],
};
const code = (error: { code?: string }) => error.code ?? 'refused';

export const codeTemplateScenarios: Scenario<DataStore>[] = [
  {
    method: 'codeTemplates.listProjectTemplates',
    name: 'by name',
    fixture,
    run: async (store) => store.codeTemplates.listProjectTemplates(),
  },
  {
    method: 'codeTemplates.createProjectTemplate',
    name: 'new, then a duplicate name refused',
    fixture,
    run: async (store) => {
      await store.codeTemplates.createProjectTemplate({
        name: 'python',
        description: null,
        instructions: 'pytest',
      });
      const duplicate = await store.codeTemplates
        .createProjectTemplate({ name: 'node', description: null, instructions: 'x' })
        .then(() => 'accepted', code);
      return {
        duplicate,
        names: (await store.codeTemplates.listProjectTemplates()).map((t) => t.name),
      };
    },
  },
  {
    method: 'codeTemplates.updateProjectTemplate',
    name: 'rewrite, missing, duplicate',
    fixture,
    run: async (store) => [
      await store.codeTemplates.updateProjectTemplate(uid(1302), {
        name: 'Golang',
        description: null,
        instructions: 'go vet',
      }),
      await store.codeTemplates.updateProjectTemplate(uid(1), {
        name: 'z',
        description: null,
        instructions: 'z',
      }),
      await store.codeTemplates
        .updateProjectTemplate(uid(1302), { name: 'node', description: null, instructions: 'z' })
        .then(() => 'accepted', code),
      await store.codeTemplates.listProjectTemplates(),
    ],
  },
  {
    method: 'codeTemplates.deleteProjectTemplate',
    name: 'once',
    fixture,
    run: async (store) => [
      await store.codeTemplates.deleteProjectTemplate(uid(1301)),
      await store.codeTemplates.deleteProjectTemplate(uid(1301)),
      (await store.codeTemplates.listProjectTemplates()).map((t) => t.id),
    ],
  },
  {
    method: 'codeTemplates.listPipelineTemplates',
    name: 'all or one host, by host then name',
    fixture,
    run: async (store) => [
      await store.codeTemplates.listPipelineTemplates(),
      (await store.codeTemplates.listPipelineTemplates('atlassian-bitbucket')).map((t) => t.name),
      await store.codeTemplates.listPipelineTemplates('none'),
    ],
  },
  {
    method: 'codeTemplates.createPipelineTemplate',
    name: 'new; same name on another host is fine, on the same host refused',
    fixture,
    run: async (store) => {
      await store.codeTemplates.createPipelineTemplate({
        provider: 'github',
        name: 'b',
        description: null,
        body: 'y',
      });
      const duplicate = await store.codeTemplates
        .createPipelineTemplate({ provider: 'github', name: 'gh', description: null, body: 'y' })
        .then(() => 'accepted', code);
      return {
        duplicate,
        names: (await store.codeTemplates.listPipelineTemplates('github')).map((t) => t.name),
      };
    },
  },
  {
    method: 'codeTemplates.updatePipelineTemplate',
    name: 'rewrite and missing',
    fixture,
    run: async (store) => [
      await store.codeTemplates.updatePipelineTemplate(uid(1313), {
        provider: 'github',
        name: 'gh2',
        description: null,
        body: 'on: pull_request',
      }),
      await store.codeTemplates.updatePipelineTemplate(uid(1), {
        provider: 'github',
        name: 'q',
        description: null,
        body: 'q',
      }),
      await store.codeTemplates.listPipelineTemplates('github'),
    ],
  },
  {
    method: 'codeTemplates.deletePipelineTemplate',
    name: 'once',
    fixture,
    run: async (store) => [
      await store.codeTemplates.deletePipelineTemplate(uid(1311)),
      await store.codeTemplates.deletePipelineTemplate(uid(1311)),
      (await store.codeTemplates.listPipelineTemplates()).map((t) => t.id),
    ],
  },
];
