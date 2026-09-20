/**
 * The code-project templates catalog: the picker on the new-code-project
 * form (built-ins, then whatever the org has added) and the operator-only
 * admin page that manages the org's own entries. Bitbucket is the stub in
 * sandbox-stub.mjs, same as code.spec.ts. Screenshots land under
 * test-results/screens/<project>/project-templates-*.png.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** Same envelope as code.spec.ts's grant fixture — see there for why. */
function secretbox(plaintext: string): string {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const key = Buffer.from(encoded, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

async function db(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

/** Per-project name: the three Playwright projects share one database. */
function customTemplateNameFor(project: string): string {
  return `Playwright screenshot template (${project})`;
}

test.describe('code project templates', () => {
  // Playwright requires the destructuring pattern even when no fixture is used.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    const customTemplateName = customTemplateNameFor(testInfo.project.name);
    const client = await db();
    try {
      // A Bitbucket grant so the new-project form offers to create a
      // project at all — the picker itself does not need this, but the
      // full page context (no "Connect Bitbucket first" banner) does.
      await client.query(
        `INSERT INTO provider_grants
           (tenant_id, provider, provider_account_id, subject, client_id, display_name,
            encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes, metadata)
         VALUES ($1, 'atlassian-bitbucket', 'e2e-bitbucket-account', $2, 'e2e-client', 'E2E Bitbucket',
                 $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, provider, provider_account_id) DO UPDATE
           SET subject = EXCLUDED.subject,
               encrypted_access_token = EXCLUDED.encrypted_access_token,
               encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
               expires_at = EXCLUDED.expires_at`,
        [
          E2E_TENANT_ID,
          E2E_SUBJECT,
          secretbox('e2e-access-token'),
          secretbox('e2e-refresh-token'),
          new Date(Date.now() + 365 * 86_400_000),
          ['account', 'repository', 'repository:write', 'pullrequest', 'pullrequest:write'],
          JSON.stringify({ username: 'e2e-dev' }),
        ]
      );
      await client.query(
        `DELETE FROM code_project_templates WHERE tenant_id = $1 AND name = $2`,
        [E2E_TENANT_ID, customTemplateName]
      );
    } finally {
      await client.end();
    }
  });

  test('picker on the new-project form, and the admin catalog', async ({ page }, testInfo) => {
    const customTemplateName = customTemplateNameFor(testInfo.project.name);
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

    // ── The new-project form: the built-in templates offered, the generic
    //    one selected by default, matching the standing developer's brief ──
    await page.goto(`/${E2E_SLUG}/code/new`);
    await expect(page.getByRole('heading', { level: 1, name: 'New code project' })).toBeVisible();
    const templatePicker = page.getByRole('combobox', { name: 'Start from a template' });
    await expect(templatePicker).toBeVisible();
    await expect(page.getByLabel(/^Instructions/)).toHaveValue(/test-first/);
    await shot('project-templates-picker-default.png');

    // ── Picking a different built-in swaps the instructions text in,
    //    still fully editable afterward ──
    await templatePicker.selectOption({ label: 'Full-stack application' });
    await expect(page.getByLabel(/^Instructions/)).toHaveValue(/full-stack developer/);
    await shot('project-templates-picker-fullstack.png');

    // ── The admin catalog: built-ins listed read-only, "Duplicate to
    //    customize" opens a draft pre-filled from one ──
    await page.goto(`/${E2E_SLUG}/admin/project-templates`);
    await expect(page.getByRole('heading', { level: 1, name: 'Project templates' })).toBeVisible();
    await expect(page.getByText('Generic developer brief')).toBeVisible();
    await expect(page.getByText('Built-in').first()).toBeVisible();
    await shot('project-templates-admin-list.png');

    const microserviceRow = page
      .locator('li')
      .filter({ hasText: 'Microservice / API service' });
    await microserviceRow.getByRole('button', { name: 'Duplicate to customize' }).click();
    const nameField = page.getByLabel('Name', { exact: true });
    await expect(nameField).toHaveValue('Microservice / API service (copy)');
    await nameField.fill(customTemplateName);
    await shot('project-templates-admin-duplicate-draft.png');
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.getByText(customTemplateName)).toBeVisible();
    await shot('project-templates-admin-list-with-custom.png');

    // ── The org's own template now shows up in the new-project picker too ──
    await page.goto(`/${E2E_SLUG}/code/new`);
    await expect(
      page.getByRole('combobox', { name: 'Start from a template' })
    ).toContainText(customTemplateName);
    await shot('project-templates-picker-with-custom.png');
  });
});
