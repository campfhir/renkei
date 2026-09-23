/**
 * A Bitbucket code project's Pipelines section: the switch turned on,
 * the missing pipeline file named, a secured and a plain repository
 * variable added (the secured value never rendered), a plain one edited
 * and removed, and a deployment environment's variable added — then the
 * same section at phone width. Bitbucket is the stub in sandbox-stub.mjs
 * (the app is pointed at it with BITBUCKET_API_BASE_URL), which keeps
 * one pipelines row per repository; each Playwright project seeds a
 * project on a repository of its own, so the three never share state.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** `@renkei/crypto`'s secretbox, as code.spec.ts reproduces it. */
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

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    digit,
    projectId: `77777777-7777-4777-8777-7777777777${digit}1`,
    name: `Pipelines demo (${digit})`,
    repo: `acme/pipelines-demo-${digit}`,
  };
}

async function db(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

async function seedFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    // The person's Bitbucket grant, carrying the two checkboxes the
    // section stands on beyond a code project's own three: the admin
    // bundle (the switch) and the pipeline-variable one. code.spec.ts
    // seeds the same row without them, so this upsert sets the scopes too.
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
             expires_at = EXCLUDED.expires_at,
             requested_scopes = EXCLUDED.requested_scopes`,
      [
        E2E_TENANT_ID,
        E2E_SUBJECT,
        secretbox('e2e-access-token'),
        secretbox('e2e-refresh-token'),
        new Date(Date.now() + 365 * 86_400_000),
        [
          'account',
          'repository',
          'repository:write',
          'pullrequest',
          'pullrequest:write',
          'project:admin',
          'repository:admin',
          'pipeline',
          'pipeline:write',
          'pipeline:variable',
        ],
        JSON.stringify({ username: 'e2e-dev' }),
      ]
    );
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'Where the pipeline gets set up.', 'code', 'atlassian-bitbucket', $5, 'main')`,
      [ids.projectId, E2E_TENANT_ID, E2E_SUBJECT, ids.name, ids.repo]
    );
  } finally {
    await client.end();
  }
}

async function cleanFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
  } finally {
    await client.end();
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('Code project pipelines', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seedFixtures(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await cleanFixtures(idsFor(testInfo.project.name));
  });

  test('switch, file, variables, environment, phone width', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
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
    const main = page.getByRole('main');
    const pipelines = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Pipelines' }),
    });
    const repositoryVariables = pipelines.getByRole('group', { name: 'Repository variables' });
    const production = pipelines.getByRole('group', { name: 'Production' });

    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });

    // ── The section sits after the environment, before the chats, and
    //    reads from Bitbucket: off, no file, no variables ──
    const headings = await main.getByRole('heading', { level: 2 }).allTextContents();
    const at = (name: string) => headings.findIndex((text) => text.startsWith(name));
    expect(at('Pipelines')).toBeGreaterThan(at('Environment'));
    expect(at('Chats in this project')).toBeGreaterThan(at('Pipelines'));
    await expect(pipelines.getByRole('link', { name: 'Open on Bitbucket' })).toHaveAttribute(
      'href',
      `https://bitbucket.org/${ids.repo}/pipelines`
    );
    // The state is said twice, as a pill by the heading and in the row.
    await expect(pipelines.locator('dl').getByText('Off', { exact: true })).toBeVisible();
    await expect(pipelines.getByText(/Not on main yet — ask a chat in this project/)).toBeVisible();
    await expect(repositoryVariables.getByText('No variables.')).toBeVisible();
    await expect(production.getByText('No variables.')).toBeVisible();
    await expect(production.getByText(/deploying to this production environment/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-off.png');

    // ── Turn it on ──
    await pipelines.getByRole('button', { name: 'Turn on' }).click();
    await expect(pipelines.locator('dl').getByText('On', { exact: true })).toBeVisible();
    await expect(pipelines.getByRole('button', { name: 'Turn off' })).toBeVisible();

    // ── A secured variable: listed as Secured, its value never on the page ──
    await repositoryVariables.getByRole('button', { name: 'Add variable' }).click();
    const addForm = repositoryVariables.getByRole('form', {
      name: 'Add a variable to Repository variables',
    });
    await expect(addForm.getByLabel(/^Secured/)).toBeChecked();
    await addForm.getByLabel('Name', { exact: true }).fill('NPM_TOKEN');
    await addForm.getByLabel('Value', { exact: true }).fill('npm_secret_value_123');
    await addForm.getByRole('button', { name: 'Save' }).click();
    const npmRow = repositoryVariables.getByRole('listitem').filter({ hasText: 'NPM_TOKEN' });
    await expect(npmRow).toBeVisible();
    await expect(npmRow.getByText('Secured')).toBeVisible();
    await expect(page.getByText('npm_secret_value_123')).toHaveCount(0);

    // ── A plain one: its value shown, then edited, then removed ──
    await repositoryVariables.getByRole('button', { name: 'Add variable' }).click();
    await addForm.getByLabel('Name', { exact: true }).fill('API_BASE_URL');
    await addForm.getByLabel(/^Secured/).uncheck();
    await addForm.getByLabel('Value', { exact: true }).fill('https://api.example.test');
    await addForm.getByRole('button', { name: 'Save' }).click();
    const apiRow = repositoryVariables.getByRole('listitem').filter({ hasText: 'API_BASE_URL' });
    await expect(apiRow.getByText('https://api.example.test')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-variables.png');
    await apiRow.getByRole('button', { name: 'Edit' }).click();
    const editForm = repositoryVariables.getByRole('form', { name: 'Edit API_BASE_URL' });
    await expect(editForm.getByLabel('Value', { exact: true })).toHaveValue(
      'https://api.example.test'
    );
    await editForm.getByLabel('Value', { exact: true }).fill('https://api.example.test/v2');
    await editForm.getByRole('button', { name: 'Save' }).click();
    await expect(apiRow.getByText('https://api.example.test/v2')).toBeVisible();
    page.once('dialog', (dialog) => void dialog.accept());
    await apiRow.getByRole('button', { name: 'Remove' }).click();
    await expect(repositoryVariables.getByText('API_BASE_URL')).toHaveCount(0);
    await expect(npmRow).toBeVisible();

    // ── Editing the secured one with an empty value keeps Bitbucket's ──
    await npmRow.getByRole('button', { name: 'Edit' }).click();
    const secureEdit = repositoryVariables.getByRole('form', { name: 'Edit NPM_TOKEN' });
    await expect(secureEdit.getByLabel('Value', { exact: true })).toHaveValue('');
    await expect(secureEdit.getByLabel('Value', { exact: true })).toHaveAttribute(
      'placeholder',
      'Leave empty to keep the current value'
    );
    await secureEdit.getByLabel('Name', { exact: true }).fill('NPM_TOKEN_RO');
    await secureEdit.getByRole('button', { name: 'Save' }).click();
    await expect(repositoryVariables.getByText('NPM_TOKEN_RO')).toBeVisible();
    await expect(repositoryVariables.getByText('NPM_TOKEN', { exact: true })).toHaveCount(0);

    // ── A deployment environment's variable goes on that environment ──
    await production.getByRole('button', { name: 'Add variable' }).click();
    const productionForm = production.getByRole('form', { name: 'Add a variable to Production' });
    await productionForm.getByLabel('Name', { exact: true }).fill('DEPLOY_KEY');
    await productionForm.getByLabel('Value', { exact: true }).fill('deploy-key-bytes');
    await productionForm.getByRole('button', { name: 'Save' }).click();
    const deployRow = production.getByRole('listitem').filter({ hasText: 'DEPLOY_KEY' });
    await expect(deployRow.getByText('Secured')).toBeVisible();
    await expect(repositoryVariables.getByText('DEPLOY_KEY')).toHaveCount(0);
    await expect(page.getByText('deploy-key-bytes')).toHaveCount(0);

    // ── It all survives a reload: the stub is the truth, not the page ──
    await page.reload();
    await expect(pipelines.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await expect(repositoryVariables.getByText('NPM_TOKEN_RO')).toBeVisible();
    await expect(production.getByText('DEPLOY_KEY')).toBeVisible();
    await shot('code-pipelines-set.png');

    // ── Phone width: the same section, nothing sideways ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.reload();
    await expect(pipelines.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await expect(production.getByText('DEPLOY_KEY')).toBeVisible();
    await production.getByRole('button', { name: 'Add variable' }).click();
    await expect(productionForm.getByLabel('Name', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-mobile.png');
  });
});
