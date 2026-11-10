/**
 * The code-project templates catalog: the picker on the new-code-project
 * form (seeded rows, plus whatever the org has added) and the
 * operator-only admin page that manages the catalog. Every tenant starts
 * with a few rows from migration 114 — there is no separate "built-in"
 * concept, they are ordinary rows an operator can rename, rewrite or
 * delete. Bitbucket is the stub in sandbox-stub.mjs, connected through the
 * real connect flow (e2e/support/code-host.ts). The catalog is the
 * organization's: the spec's own template is tagged and deleted again.
 * Screenshots land under test-results/screens/<project>/project-templates-*.png.
 *
 * The rules moved out: picking a template filling Instructions (and the
 * text staying editable), what the form sends and when Save is allowed
 * are app/(app)/code/_components/new-code-project.model.test.ts and
 * app/(app)/admin/project-templates/project-template-forms.model.test.ts
 * (Edit's pre-filled draft among them); operator-only access, required
 * fields, taken names and 404s are app/api/admin/project-templates/route.test.ts.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './fixtures';
import { connectBitbucket, prepareCodeHost } from './support/code-host';

// The catalog's admin page is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

/**
 * What migration 114 seeds for a real organization. The in-memory store
 * starts from the schema alone, so an operator adds them through the
 * catalog's own route when they are missing (and they stay, as the
 * migration's rows would).
 */
const SEED_TEMPLATES = [
  {
    name: 'Generic developer brief',
    description: 'The standing default — read first, test-first, small complete changes.',
    instructions: 'Read before you write, test-first, small complete changes.',
  },
  {
    name: 'Full-stack application',
    description: 'A web app with a frontend, a backend and a database behind it.',
    instructions:
      'You are a professional full-stack developer working across the frontend, backend and database.',
  },
  {
    name: 'Microservice / API service',
    description: 'A focused backend service behind a stable API contract.',
    instructions: 'Protect the API contract; a breaking change needs a new version.',
  },
  {
    name: 'SQL / data report',
    description: 'A reporting or analytics project built on SQL queries against a real schema.',
    instructions: 'Validate every query against real data before treating a report as done.',
  },
];

test.describe('code project templates', () => {
  test.beforeEach(async ({ page, request, person: _person }) => {
    // The form offers to create a project only to someone connected.
    await prepareCodeHost(request);
    await connectBitbucket(page);
    for (const template of SEED_TEMPLATES) {
      const added = await page.request.post('/api/admin/project-templates', { data: template });
      // 409: already there, from an earlier test.
      expect([201, 409], await added.text()).toContain(added.status());
    }
  });

  test('picker on the new-project form, and the admin catalog', async ({ page }, testInfo) => {
    const customTemplateName = `Playwright screenshot template (${testInfo.project.name}-${randomUUID().slice(0, 6)})`;
    const shot = (name: string) =>
      page.screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
          'test-results',
          'screens',
          testInfo.project.name,
          name
        ),
        fullPage: false,
      });

    // ── The new-project form: the seeded templates offered ──
    await page.goto(`/code/new`);
    await expect(page.getByRole('heading', { level: 1, name: 'New code project' })).toBeVisible();
    const templatePicker = page.getByRole('combobox', { name: 'Start from a template' });
    await expect(templatePicker).toBeVisible();
    await expect(templatePicker).toContainText('Full-stack application');
    await shot('project-templates-picker-default.png');

    // ── The admin catalog: the seeded rows ──
    await page.goto(`/admin/project-templates`);
    await expect(page.getByRole('heading', { level: 1, name: 'Project templates' })).toBeVisible();
    await expect(page.getByText('Generic developer brief')).toBeVisible();
    await expect(page.getByText('Microservice / API service')).toBeVisible();
    await shot('project-templates-admin-list.png');

    // ── A brand-new template, created from scratch ──
    await page.getByRole('button', { name: '+ New template' }).click();
    await page.getByLabel('Name', { exact: true }).fill(customTemplateName);
    await page
      .getByLabel(/^Description/)
      .fill('A template made for a Playwright screenshot, not for real use.');
    // The draft form's only <textarea> — its Instructions field.
    await page.locator('textarea').fill('Run pnpm test before every commit.');
    await shot('project-templates-admin-new-draft.png');
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.getByText(customTemplateName)).toBeVisible();
    await shot('project-templates-admin-list-with-custom.png');

    // ── The org's own template now shows up in the new-project picker too ──
    await page.goto(`/code/new`);
    await expect(page.getByRole('combobox', { name: 'Start from a template' })).toContainText(
      customTemplateName
    );
    await shot('project-templates-picker-with-custom.png');

    // The catalog is everyone's: the spec's own template goes again.
    const listed = await page.request.get('/api/admin/project-templates');
    const { templates }: { templates: { id: string; name: string }[] } = await listed.json();
    for (const template of templates.filter((entry) => entry.name === customTemplateName)) {
      const removed = await page.request.delete(`/api/admin/project-templates/${template.id}`);
      expect(removed.ok()).toBe(true);
    }
  });
});
