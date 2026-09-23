/**
 * A Bitbucket code project's Pipelines: the card on the project page
 * (off, no file, the last run) opening the project's Pipelines page,
 * where the recent runs are listed, the switch turned on, the missing
 * pipeline file named, a secured and a plain repository variable added
 * (the secured value never rendered), a plain one edited and removed,
 * and a deployment environment's variable added — then the page at
 * phone width. Bitbucket is the stub in sandbox-stub.mjs (the app is
 * pointed at it with BITBUCKET_API_BASE_URL), which keeps one pipelines
 * row per repository; each Playwright project seeds a project on a
 * repository of its own, so the three never share state.
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
    // page stands on beyond a code project's own three: the admin
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

/**
 * Nothing scrolls sideways — the document, and the frame's own scroll
 * container inside it (a wide table there would not show on the document,
 * but focusing a field beside it would drag the whole page's content off
 * the left edge).
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const frame = document.querySelector('main .overflow-y-auto');
    return Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      frame ? frame.scrollWidth - frame.clientWidth : 0
    );
  });
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

  test('card, page, runs, switch, variables, environment, phone width', async ({
    page,
  }, testInfo) => {
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
    const pagePath = `/${E2E_SLUG}/code/${ids.projectId}/pipelines`;

    // ── The project page: a card, after the environment and before the
    //    chats, summarizing what Bitbucket says — off, no file, no
    //    variables, the last run — and nothing to edit inline ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    const card = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Pipelines' }),
    });
    const headings = await main.getByRole('heading', { level: 2 }).allTextContents();
    const at = (name: string) => headings.findIndex((text) => text.startsWith(name));
    expect(at('Pipelines')).toBeGreaterThan(at('Environment'));
    expect(at('Chats in this project')).toBeGreaterThan(at('Pipelines'));
    await expect(
      card.getByText(/^Off · no bitbucket-pipelines\.yml on main yet · 0 variables/)
    ).toBeVisible();
    await expect(card.getByText('Last run')).toBeVisible();
    await expect(card.getByRole('link', { name: '#2' })).toHaveAttribute(
      'href',
      `https://bitbucket.org/${ids.repo}/pipelines/results/2`
    );
    await expect(card.getByText('Failed')).toBeVisible();
    await expect(card.getByRole('button')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-card.png');

    // ── Into the page: the runs table, the setup, the empty variable sets ──
    await card.getByRole('link', { name: /Runs, setup & variables/ }).click();
    await expect(page).toHaveURL(new RegExp(`${pagePath}$`));
    await expect(page.getByRole('heading', { level: 1, name: /^Pipelines/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(main.getByText(ids.repo)).toBeVisible();
    await expect(main.getByRole('link', { name: 'Open on Bitbucket' })).toHaveAttribute(
      'href',
      `https://bitbucket.org/${ids.repo}/pipelines`
    );
    const runs = main.getByRole('region', { name: 'Recent runs' });
    const rows = runs.getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(runs.getByRole('list')).toBeHidden();
    await expect(rows.nth(1)).toContainText('#2');
    await expect(rows.nth(1)).toContainText('Failed');
    await expect(rows.nth(1)).toContainText('feature/retry-invoices');
    await expect(rows.nth(1)).toContainText('E2E Dev');
    await expect(rows.nth(1)).toContainText('5m 12s');
    await expect(rows.nth(2)).toContainText('#1');
    await expect(rows.nth(2)).toContainText('Successful');
    await expect(rows.nth(2)).toContainText('main');
    const setup = main.getByRole('region', { name: 'Setup' });
    await expect(setup.getByText('Off', { exact: true })).toBeVisible();
    await expect(setup.getByText(/Not on main yet — ask a chat in this project/)).toBeVisible();
    const repositoryVariables = main.getByRole('region', { name: 'Repository variables' });
    const production = main.getByRole('region', { name: 'Production' });
    await expect(repositoryVariables.getByText('No variables.')).toBeVisible();
    await expect(production.getByText('No variables.')).toBeVisible();
    await expect(production.getByText(/deploying to this production environment/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-page.png');

    // ── Turn it on ──
    await setup.getByRole('button', { name: 'Turn on' }).click();
    await expect(setup.getByText('On', { exact: true })).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Turn off' })).toBeVisible();

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
    await expect(setup.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await expect(repositoryVariables.getByText('NPM_TOKEN_RO')).toBeVisible();
    await expect(production.getByText('DEPLOY_KEY')).toBeVisible();
    await shot('code-pipelines-set.png');

    // ── Back on the project page, the card reflects it: on, two variables ──
    await main.getByRole('link', { name: ids.name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible();
    await expect(
      card.getByText(
        /^On · no bitbucket-pipelines\.yml on main yet · 2 variables across the repository and 1 environment/
      )
    ).toBeVisible();

    // ── Phone width: the page again, one column, the runs as cards
    //    rather than a table, nothing sideways ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(pagePath);
    await expect(page.getByRole('heading', { level: 1, name: /^Pipelines/ })).toBeVisible();
    await expect(runs.getByRole('table')).toBeHidden();
    const runCards = runs.getByRole('listitem');
    await expect(runCards).toHaveCount(2);
    await expect(runCards.nth(0)).toContainText('#2');
    await expect(runCards.nth(0)).toContainText('Failed');
    await expect(runCards.nth(0)).toContainText('feature/retry-invoices');
    await expect(runCards.nth(0)).toContainText('E2E Dev');
    await expect(runCards.nth(0)).toContainText('5m 12s');
    await expect(runCards.nth(1)).toContainText('Successful');
    await expect(production.getByText('DEPLOY_KEY')).toBeVisible();
    await production.getByRole('button', { name: 'Add variable' }).click();
    await expect(productionForm.getByLabel('Name', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-mobile.png');
  });
});
