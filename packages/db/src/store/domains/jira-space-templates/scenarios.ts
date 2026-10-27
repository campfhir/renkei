import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { JiraSpaceTemplateRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-7e${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function row(n: number, cloudId: string, name: string) {
  return {
    id: id(n),
    cloud_id: cloudId,
    site_url: cloudId === 'cloud-1' ? 'https://acme.atlassian.net' : null,
    name,
    name_key: name.trim().toLowerCase(),
    description: n % 2 ? `about ${name}` : null,
    source_space_key: n % 2 ? 'OPS' : null,
    document: JSON.stringify({ version: 1, roles: [{ roleId: '1', groups: [] }] }),
    created_by: 'ann',
    updated_by: 'ann',
    created_at: at(n),
    updated_at: at(n),
  };
}

const fixture = {
  jira_admin_space_templates: [
    row(1, 'cloud-1', 'Operations team'),
    row(2, 'cloud-2', 'Operations team'),
    row(3, 'cloud-1', 'alpha'),
    row(4, 'cloud-1', 'Beta'),
    row(5, 'cloud-2', 'Zeta'),
  ],
};

const names = (rows: JiraSpaceTemplateRecord[]) => rows.map((r) => `${r.cloudId}:${r.name}`);

/** Without the times "now" stamped on a save. */
function settled(template: JiraSpaceTemplateRecord | null | undefined) {
  if (!template) return null;
  const { id: _id, createdAt, updatedAt, ...rest } = template;
  return { ...rest, replaced: createdAt.getTime() !== updatedAt.getTime() };
}

const input = (name: string, document: unknown) => ({
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  name,
  nameKey: name.trim().toLowerCase(),
  description: 'new',
  sourceSpaceKey: 'NEW',
  document,
  subject: 'bob',
});

export const jiraSpaceTemplateScenarios: Scenario<DataStore>[] = [
  {
    method: 'jiraSpaceTemplates.save',
    name: 'a new name saves; a taken one is refused, or replaced keeping its creation',
    fixture,
    run: async (store) => {
      const fresh = await store.jiraSpaceTemplates.save(input('Fresh', { a: [1] }), {
        overwrite: false,
      });
      const refused = await store.jiraSpaceTemplates.save(input('alpha', { b: 2 }), {
        overwrite: false,
      });
      const replaced = await store.jiraSpaceTemplates.save(input('ALPHA', { c: 3 }), {
        overwrite: true,
      });
      return {
        fresh: settled(fresh),
        refused,
        replaced: settled(replaced),
        replacedId: replaced?.id,
        createdKept: replaced?.createdAt.toISOString(),
        list: names(await store.jiraSpaceTemplates.list(10)),
      };
    },
  },
  {
    method: 'jiraSpaceTemplates.find',
    name: 'by id or name key, this site first; nothing for an unknown one',
    fixture,
    run: async (store) => [
      names(await store.jiraSpaceTemplates.find('cloud-1', { nameKey: 'operations team' })),
      names(await store.jiraSpaceTemplates.find('cloud-2', { nameKey: 'operations team' })),
      names(await store.jiraSpaceTemplates.find('cloud-9', { nameKey: 'operations team' })),
      await store.jiraSpaceTemplates.find('cloud-2', { id: id(3) }),
      await store.jiraSpaceTemplates.find('cloud-1', { nameKey: 'nothing' }),
      await store.jiraSpaceTemplates.find('cloud-1', { id: id(99) }),
    ],
  },
  {
    method: 'jiraSpaceTemplates.list',
    name: 'by name key under the collation, ties by id, bounded',
    fixture,
    run: async (store) => [
      await store.jiraSpaceTemplates.list(200),
      names(await store.jiraSpaceTemplates.list(2)),
    ],
  },
  {
    method: 'jiraSpaceTemplates.delete',
    name: 'once, by id',
    fixture,
    run: async (store) => [
      await store.jiraSpaceTemplates.delete(id(3)),
      await store.jiraSpaceTemplates.delete(id(3)),
      await store.jiraSpaceTemplates.delete(id(99)),
      names(await store.jiraSpaceTemplates.list(200)),
    ],
  },
];
