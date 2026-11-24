import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { uid } from '../chats/fixtures';

const fixture = {
  code_project_templates: [
    { id: uid(1301), name: 'node', description: null, instructions: 'npm test' },
    { id: uid(1302), name: 'Go', description: 'go', instructions: 'go test' },
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
];
