/**
 * Space templates against a real database (skipped without DATABASE_URL):
 * a name is taken once per site, ignoring case, and saving over it takes
 * an explicit overwrite; a name on another site is a different template.
 */

import { closeDataStore } from '@renkei/db';
import {
  deleteSpaceTemplate,
  findSpaceTemplate,
  listSpaceTemplates,
  saveSpaceTemplate,
  type TemplateDocument,
} from './space-templates';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

const DOCUMENT: TemplateDocument = {
  version: 1,
  projectTypeKey: 'software',
  assigneeType: 'UNASSIGNED',
  category: null,
  schemes: {
    issueTypeScheme: { id: '11', name: 'OPS work types' },
    issueTypeScreenScheme: { id: '12', name: 'OPS screens' },
    workflowScheme: { id: '13', name: 'OPS workflows' },
    fieldConfigurationScheme: null,
    permissionScheme: { id: '15', name: 'Internal permissions' },
    notificationScheme: { id: '16', name: 'Quiet notifications' },
    issueSecurityScheme: null,
  },
  roles: [
    { roleId: '10002', roleName: 'Administrators', groups: [{ groupId: 'g', name: 'ops-admins' }] },
  ],
  components: [{ name: 'Backend', description: null, assigneeType: 'PROJECT_DEFAULT' }],
};

maybe('jira_admin_space_templates', () => {
  const save = (overrides: Partial<Parameters<typeof saveSpaceTemplate>[0]> = {}) =>
    saveSpaceTemplate({
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      name: 'Ops standard',
      description: 'How operations spaces are set up',
      sourceSpaceKey: 'OPS',
      document: DOCUMENT,
      subject: 'dana@example.com',
      overwrite: false,
      ...overrides,
    });

  /** Delete what this suite saves (and what an earlier run left), the way an operator would. */
  const removeDanas = async () => {
    for (const template of await listSpaceTemplates()) {
      if (template.createdBy === 'dana@example.com') await deleteSpaceTemplate(template.id);
    }
  };

  beforeAll(removeDanas);

  afterAll(async () => {
    await removeDanas();
    await closeDataStore();
  });

  it('saves a template and reads it back by name, ignoring case, or by id', async () => {
    const saved = await save();
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.replaced).toBe(false);
    expect(saved.template.document).toEqual(DOCUMENT);

    const byName = await findSpaceTemplate('cloud-1', '  OPS STANDARD ');
    expect(byName?.id).toBe(saved.template.id);
    const byId = await findSpaceTemplate('cloud-1', saved.template.id);
    expect(byId?.name).toBe('Ops standard');
  });

  it('refuses a taken name unless told to overwrite, then replaces it whole', async () => {
    expect(await save({ name: 'ops Standard' })).toEqual({ ok: false, reason: 'exists' });

    const replaced = await save({
      name: 'ops Standard',
      description: 'Revised',
      overwrite: true,
      subject: 'sam@example.com',
    });
    if (!replaced.ok) throw new Error(replaced.reason);
    expect(replaced.replaced).toBe(true);
    expect(replaced.template.description).toBe('Revised');
    expect(replaced.template.updatedBy).toBe('sam@example.com');
    expect(replaced.template.createdBy).toBe('dana@example.com');
  });

  it('keeps the same name on another site as a separate template, preferring this site’s', async () => {
    const elsewhere = await save({ cloudId: 'cloud-2', siteUrl: 'https://other.atlassian.net' });
    if (!elsewhere.ok) throw new Error(elsewhere.reason);
    expect((await findSpaceTemplate('cloud-1', 'Ops standard'))?.cloudId).toBe('cloud-1');
    // Asked for from a third site: the name still resolves, so the caller
    // can say "saved from another site" rather than "no such template".
    expect((await findSpaceTemplate('cloud-3', 'Ops standard'))?.cloudId).toMatch(/^cloud-[12]$/);
    expect((await listSpaceTemplates()).length).toBe(2);
  });

  it('deletes by id, once', async () => {
    const saved = await save({ name: 'To remove' });
    if (!saved.ok) throw new Error(saved.reason);
    expect(await deleteSpaceTemplate(saved.template.id)).toBe(true);
    expect(await deleteSpaceTemplate(saved.template.id)).toBe(false);
    expect(await findSpaceTemplate('cloud-1', 'To remove')).toBeNull();
  });
});
