/**
 * A Bitbucket code project's Pipelines: the card on the project page
 * (off, no file, the last run) opening the project's Pipelines page,
 * where the recent runs are listed, the switch turned on, the pipeline
 * file started from a template and committed, a run started, a secured and a plain repository variable added
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

/**
 * What migration 122 seeds for a real tenant, in short: global-setup
 * deletes and reinserts the e2e tenant on every run, and tenant_id
 * cascades — which drops the seeded rows. Patched in the way
 * project-templates.spec.ts patches its own catalog.
 */
const SEED_PIPELINE_TEMPLATES = [
  {
    name: 'Node with pnpm',
    description: 'Install with pnpm, then lint, typecheck and test on every push.',
    body: 'image: node:22\n\npipelines:\n  default:\n    - step:\n        script:\n          - pnpm install --frozen-lockfile\n          - pnpm test\n',
  },
  {
    name: 'Bare skeleton',
    description: 'One step with one command — the shape of a pipeline, nothing assumed.',
    body: 'pipelines:\n  default:\n    - step:\n        script:\n          - echo "Replace me"\n',
  },
];

function customTemplateNameFor(project: string): string {
  return `Playwright pipeline template (${project})`;
}

async function seedFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    for (const template of SEED_PIPELINE_TEMPLATES) {
      await client.query(
        `INSERT INTO pipeline_templates (tenant_id, provider, name, description, body)
         VALUES ($1, 'atlassian-bitbucket', $2, $3, $4)
         ON CONFLICT (tenant_id, provider, name) DO NOTHING`,
        [E2E_TENANT_ID, template.name, template.description, template.body]
      );
    }
    await client.query(`DELETE FROM pipeline_templates WHERE tenant_id = $1 AND name = $2`, [
      E2E_TENANT_ID,
      customTemplateNameFor(ids.digit),
    ]);
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
    await expect(card.getByRole('link', { name: '#2', exact: true })).toHaveAttribute(
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
    await expect(setup.getByText(/Not on main yet\./)).toBeVisible();
    await expect(setup.getByText(/A chat in this project can write one/)).toBeVisible();
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

    // ── The pipeline file, from a template: the editor fills from the
    //    picked one, the text is committed to the branch, and the setup
    //    then says the file is there ──
    await setup.getByRole('button', { name: 'Start from a template' }).click();
    const fileForm = setup.getByRole('form', { name: 'Pipeline file' });
    const fileText = fileForm.getByLabel('bitbucket-pipelines.yml');
    await expect(fileText).toHaveValue('');
    const pnpmOption = fileForm.getByRole('option', { name: /^Node with pnpm/ });
    await fileForm
      .getByLabel('Start from a template')
      .selectOption((await pnpmOption.getAttribute('value')) ?? '');
    await expect(fileText).toHaveValue(/pnpm install --frozen-lockfile/);
    await fileText.fill((await fileText.inputValue()).replace('pnpm test', 'pnpm test -- --ci'));
    await expect(fileForm.getByLabel('Commit message')).toHaveValue('Add bitbucket-pipelines.yml');
    await shot('code-pipelines-file-template.png');
    await expect(fileForm.getByText(/Commit goes straight to main/)).toBeVisible();
    await fileForm.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(setup.getByRole('status')).toContainText(
      'Committed bitbucket-pipelines.yml to main'
    );
    await expect(
      setup.getByRole('status').getByRole('link', { name: 'Open on Bitbucket' })
    ).toHaveAttribute('href', `https://bitbucket.org/${ids.repo}/src/main/bitbucket-pipelines.yml`);
    await expect(setup.getByText('On main.')).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Start from a template' })).toHaveCount(0);
    // Editing it again opens what was committed, as the person left it.
    await setup.getByRole('button', { name: 'Edit file' }).click();
    await expect(fileText).toHaveValue(/pnpm test -- --ci/);
    await expect(fileForm.getByLabel('Commit message')).toHaveValue(
      'Update bitbucket-pipelines.yml'
    );
    await fileForm.getByRole('button', { name: 'Cancel' }).click();

    // ── Start a run: the project's branch is offered, a custom pipeline
    //    is optional; the run is named and heads the list ──
    await runs.getByRole('button', { name: 'Run pipeline' }).click();
    const runForm = runs.getByRole('form', { name: 'Run pipeline' });
    await expect(runForm.getByLabel('Branch or tag')).toHaveValue('main');
    await runForm.getByLabel('Custom pipeline (optional)').fill('deploy');
    await runForm.getByRole('button', { name: 'Start run' }).click();
    await expect(runs.getByRole('status')).toContainText('Run #3 started on main');
    await expect(runForm).toHaveCount(0);
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(1)).toContainText('#3');
    await expect(rows.nth(1)).toContainText('Pending');
    await expect(rows.nth(1)).toContainText('E2E Dev');
    await shot('code-pipelines-run-started.png');

    // ── The repository's variables, as one text box: a secured line, a
    //    plain one, and a line that is nothing — the names appear, the
    //    bad line is reported, the secured value is never on the page ──
    await repositoryVariables.getByRole('button', { name: 'Add variables' }).click();
    const repoForm = repositoryVariables.getByRole('form', { name: 'Edit Repository variables' });
    const repoText = repoForm.getByLabel('Repository variables as text');
    await expect(repoText).toHaveValue('');
    await repoText.fill(
      'secret NPM_TOKEN=npm_secret_value_123\nAPI_BASE_URL: https://api.example.test\nthis line is broken\n'
    );
    await repoForm.getByRole('button', { name: 'Save' }).click();
    await expect(repositoryVariables.getByRole('status')).toContainText(
      'added NPM_TOKEN, API_BASE_URL'
    );
    await expect(repositoryVariables.getByText(/Not read as variables: line 3/)).toBeVisible();
    const npmRow = repositoryVariables.getByRole('listitem').filter({ hasText: 'NPM_TOKEN' });
    await expect(npmRow.getByText('Secured')).toBeVisible();
    const apiRow = repositoryVariables.getByRole('listitem').filter({ hasText: 'API_BASE_URL' });
    await expect(apiRow.getByText('https://api.example.test')).toBeVisible();
    await expect(page.getByText('npm_secret_value_123')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-variables.png');

    // ── Editing again: the box holds the set, the secured one without its
    //    value; a changed plain value applies, the secured one is kept ──
    await repositoryVariables.getByRole('button', { name: 'Edit variables' }).click();
    await expect(repoText).toHaveValue('API_BASE_URL=https://api.example.test\nsecret NPM_TOKEN=');
    await repoText.fill('API_BASE_URL=https://api.example.test/v2\nsecret NPM_TOKEN=\n');
    await repoForm.getByRole('button', { name: 'Save' }).click();
    await expect(repositoryVariables.getByRole('status')).toHaveText('changed API_BASE_URL.');
    await expect(apiRow.getByText('https://api.example.test/v2')).toBeVisible();
    await expect(npmRow.getByText('Secured')).toBeVisible();

    // ── A line taken out removes its variable, after a confirmation ──
    await repositoryVariables.getByRole('button', { name: 'Edit variables' }).click();
    await repoText.fill('secret NPM_TOKEN=\n');
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Remove API_BASE_URL?');
      void dialog.accept();
    });
    await repoForm.getByRole('button', { name: 'Save' }).click();
    await expect(repositoryVariables.getByRole('status')).toHaveText('removed API_BASE_URL.');
    await expect(apiRow).toHaveCount(0);
    await expect(npmRow).toBeVisible();

    // ── A deployment environment's set is its own box ──
    await production.getByRole('button', { name: 'Add variables' }).click();
    const productionForm = production.getByRole('form', { name: 'Edit Production' });
    await productionForm
      .getByLabel('Production as text')
      .fill('secret DEPLOY_KEY=deploy-key-bytes');
    await productionForm.getByRole('button', { name: 'Save' }).click();
    await expect(production.getByRole('status')).toHaveText('added DEPLOY_KEY.');
    const deployRow = production.getByRole('listitem').filter({ hasText: 'DEPLOY_KEY' });
    await expect(deployRow.getByText('Secured')).toBeVisible();
    await expect(
      repositoryVariables.getByRole('listitem').filter({ hasText: 'DEPLOY_KEY' })
    ).toHaveCount(0);
    await expect(page.getByText('deploy-key-bytes')).toHaveCount(0);

    // ── It all survives a reload: the stub is the truth, not the page ──
    await page.reload();
    await expect(setup.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await expect(repositoryVariables.getByText('NPM_TOKEN')).toBeVisible();
    await expect(production.getByText('DEPLOY_KEY')).toBeVisible();
    await shot('code-pipelines-set.png');

    // ── Back on the project page, the card reflects it: on, two variables ──
    await main.getByRole('link', { name: ids.name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible();
    await expect(
      card.getByText(
        /^On · bitbucket-pipelines\.yml on main · 2 variables across the repository and 1 environment/
      )
    ).toBeVisible();

    // ── Phone width: the page again, one column, the runs as cards
    //    rather than a table, nothing sideways ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(pagePath);
    await expect(page.getByRole('heading', { level: 1, name: /^Pipelines/ })).toBeVisible();
    await expect(runs.getByRole('table')).toBeHidden();
    const runCards = runs.getByRole('listitem');
    await expect(runCards).toHaveCount(3);
    await expect(runCards.nth(0)).toContainText('#3');
    await expect(runCards.nth(0)).toContainText('Pending');
    await expect(runCards.nth(1)).toContainText('#2');
    await expect(runCards.nth(1)).toContainText('Failed');
    await expect(runCards.nth(1)).toContainText('feature/retry-invoices');
    await expect(runCards.nth(1)).toContainText('E2E Dev');
    await expect(runCards.nth(1)).toContainText('5m 12s');
    await expect(runCards.nth(2)).toContainText('Successful');
    // The form fits the phone too.
    await runs.getByRole('button', { name: 'Run pipeline' }).click();
    await expect(runs.getByRole('form', { name: 'Run pipeline' })).toBeVisible();
    await runs.getByRole('button', { name: 'Cancel' }).click();
    await expect(production.getByText('DEPLOY_KEY')).toBeVisible();
    await production.getByRole('button', { name: 'Edit variables' }).click();
    await expect(productionForm.getByLabel('Production as text')).toHaveValue('secret DEPLOY_KEY=');
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-mobile.png');
  });

  test('the admin catalog: seeded rows, one added, edited and deleted', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const name = customTemplateNameFor(ids.digit);
    await page.goto(`/${E2E_SLUG}/admin/pipeline-templates`);
    await expect(page.getByRole('heading', { level: 1, name: 'Pipeline templates' })).toBeVisible({
      timeout: 30_000,
    });
    const main = page.getByRole('main');
    await expect(main.getByText('Node with pnpm', { exact: true })).toBeVisible();
    await expect(main.getByText('Bare skeleton', { exact: true })).toBeVisible();

    await main.getByRole('button', { name: '+ New template' }).click();
    await main.getByLabel('Name', { exact: true }).fill(name);
    await main.getByLabel(/^Description/).fill('Made by the browser suite.');
    await main
      .getByLabel('bitbucket-pipelines.yml')
      .fill('pipelines:\n  default:\n    - step:\n        script:\n          - make test\n');
    await main.getByRole('button', { name: 'Create template' }).click();
    const row = main.getByRole('listitem').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText('Made by the browser suite.')).toBeVisible();

    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(main.getByLabel('bitbucket-pipelines.yml')).toHaveValue(/make test/);
    await main.getByLabel(/^Description/).fill('Edited by the browser suite.');
    await main.getByRole('button', { name: 'Save template' }).click();
    await expect(row.getByText('Edited by the browser suite.')).toBeVisible();

    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    await expect(main.getByText('Node with pnpm', { exact: true })).toBeVisible();
  });
});
