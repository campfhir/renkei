/**
 * The Code section from a person's side: the index, a new code project
 * made through the form (a repository, a branch, a pasted .env with a
 * line that is not a variable), the project page following the clone to
 * Ready, the environment replaced and pruned, the repository re-pointed,
 * a chat started in the project (its title bar pointing back at /code),
 * the menu listing the project and its chat apart from ordinary chats,
 * and deletion. The sandbox worker is the stub in sandbox-stub.mjs; the
 * repository picker's Bitbucket call is answered here so the datalist is
 * exercised without a network. Screenshots land under
 * test-results/screens/<project>/code-*.png for the eye.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  // The mobile project's device descriptor asks for WebKit, which is not
  // installed here; the pinned Chromium runs every project.
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/**
 * `@renkei/crypto`'s secretbox, reproduced: `v1.<iv>.<tag>.<ciphertext>`
 * (aes-256-gcm, base64 parts) under TOKEN_ENCRYPTION_KEY — what a stored
 * grant token looks like, so the app can open the seeded Bitbucket grant.
 */
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

/** Per-project fixtures: the three Playwright projects share one database. */
function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    digit,
    seededProjectId: `88888888-8888-4888-8888-8888888888${digit}1`,
    seededChatId: `88888888-8888-4888-8888-8888888888${digit}2`,
    seededName: `Billing service (${digit})`,
    seededChatTitle: `Why does the invoice job retry? (${digit})`,
    newName: `Notifications gateway (${digit})`,
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
    // The person's Bitbucket grant: real-looking sealed tokens, far from
    // expiry so nothing tries to refresh them. The stub never checks the
    // header; the app only needs to be able to build one.
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
        ['account', 'repository', 'repository:write', 'pullrequest'],
        JSON.stringify({ username: 'e2e-dev' }),
      ]
    );
    await client.query('DELETE FROM chats WHERE id = $1', [ids.seededChatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.seededProjectId]);
    await client.query(`DELETE FROM chat_projects WHERE tenant_id = $1 AND name = $2`, [
      E2E_TENANT_ID,
      ids.newName,
    ]);
    // A code project whose checkout is gone (never cloned, or expired): the
    // page's "Not cloned" state, with Clone as the way back.
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'Invoices, dunning and the nightly jobs.', 'code', 'atlassian-bitbucket', 'acme/billing-service', 'main')`,
      [ids.seededProjectId, E2E_TENANT_ID, E2E_SUBJECT, ids.seededName]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, project_id, title, last_message_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [ids.seededChatId, E2E_TENANT_ID, E2E_SUBJECT, ids.seededProjectId, ids.seededChatTitle]
    );
  } finally {
    await client.end();
  }
}

async function cleanFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chats WHERE id = $1', [ids.seededChatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.seededProjectId]);
    await client.query(`DELETE FROM chat_projects WHERE tenant_id = $1 AND name = $2`, [
      E2E_TENANT_ID,
      ids.newName,
    ]);
  } finally {
    await client.end();
  }
}

/** The page never scrolls sideways — the mobile project is where it would. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The Bitbucket picker, answered locally: no network, a known list. */
async function answerRepoPicker(page: Page): Promise<void> {
  await page.route('**/api/tenant/*/code/repos*', (route) =>
    route.fulfill({
      json: {
        repos: [
          {
            fullName: 'acme/notifications-gateway',
            mainBranch: 'develop',
            updatedOn: '2026-09-01',
          },
          { fullName: 'acme/billing-service', mainBranch: 'main', updatedOn: '2026-08-20' },
        ],
      },
    })
  );
}

test.describe('code projects', () => {
  // Playwright requires the destructuring pattern even when no fixture is used.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seedFixtures(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await cleanFixtures(idsFor(testInfo.project.name));
  });

  test('index, menu, new project, project page, chat, delete', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const mobile = testInfo.project.name === 'mobile';
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
    const menu = page.getByRole('navigation', { name: 'Application' });
    // The menu lists the same project and chat; the page's own column is
    // what these steps look at.
    const main = page.getByRole('main');
    const openMenu = async () => {
      if (mobile) await page.getByRole('button', { name: 'Open menu' }).click();
    };
    const sectionOf = (name: string) =>
      main.locator('section', { has: page.getByRole('heading', { level: 2, name }) });

    // ── The index: the seeded project under Mine, its repository beneath ──
    await page.goto(`/${E2E_SLUG}/code`);
    await expect(page.getByRole('heading', { level: 1, name: 'Code' })).toBeVisible();
    const seededRow = main.getByRole('link', { name: ids.seededName });
    await expect(seededRow).toBeVisible();
    await expect(seededRow).toContainText('acme/billing-service');
    await expect(page.getByRole('link', { name: 'New code project' }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-index.png');

    // ── The menu: Code sits in the Chat section beside Projects, with no
    //    "+" of its own — the Code page's button makes projects; projects
    //    and their chats are listed there, and the chat is NOT among the
    //    person's ordinary chats ──
    await openMenu();
    const codeEntry = menu.getByRole('link', { name: 'Code', exact: true });
    await expect(codeEntry).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'New code project' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: ids.seededName })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: ids.seededChatTitle })).toHaveCount(0);
    if (!mobile) await shot('code-menu.png');
    if (mobile) await page.getByRole('button', { name: 'Close menu' }).click();

    // ── The seeded project's page: Not cloned, then Clone → Cloning → Ready ──
    await seededRow.click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();
    await expect(page.getByText('Your code project')).toBeVisible();
    // A code project keeps no files of its own; its chats are listed here.
    await expect(main.getByRole('heading', { level: 2, name: 'Files', exact: true })).toHaveCount(
      0
    );
    await expect(
      main.getByRole('heading', { level: 2, name: 'Chats in this project' })
    ).toBeVisible();
    await expect(main.getByRole('link', { name: ids.seededChatTitle })).toBeVisible();
    // A subheading sits under its title, not beside it.
    const memoryTitle = main.getByRole('heading', { level: 2, name: 'Memory' });
    const memoryNote = main.getByText("Notes the assistant keeps across this project's chats.");
    expect((await memoryNote.boundingBox())!.y).toBeGreaterThan(
      (await memoryTitle.boundingBox())!.y + 10
    );
    const repository = sectionOf('Repository');
    await expect(repository.getByText('Not cloned')).toBeVisible();
    await expect(repository.getByText('acme/billing-service')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-project-not-cloned.png');
    await repository.getByRole('button', { name: 'Clone', exact: true }).click();
    await expect(repository.getByText('Cloning…')).toBeVisible();
    await shot('code-project-cloning.png');
    await expect(repository.getByText('Ready')).toBeVisible({ timeout: 15_000 });
    await expect(repository.getByText(/4\.1 MB on the sandbox/)).toBeVisible();
    await shot('code-project-ready.png');

    // ── The repository tree: beside the sections on a wide screen, folded
    //    above them on a narrow one; folders open as they are clicked ──
    if (mobile) await main.getByText('Repository files', { exact: true }).click();
    const tree = main.getByRole('tree', { name: 'Repository files' });
    await expect(tree.getByText('package.json')).toBeVisible();
    await tree.getByRole('button', { name: 'src' }).click();
    await expect(tree.getByText('billing.ts')).toBeVisible();
    await shot('code-project-tree.png');

    // ── Instructions: a project made without any shows the developer's
    //    brief, unsaved until Save; then it is the project's own ──
    const about = sectionOf('About');
    await expect(about.getByLabel(/^Instructions/)).toHaveValue(/test-first/);
    await expect(about.getByText(/not saved yet/)).toBeVisible();
    await about.getByRole('button', { name: 'Save' }).click();
    await expect(about.getByText('Saved.')).toBeVisible();
    await page.reload();
    await expect(sectionOf('About').getByLabel(/^Instructions/)).toHaveValue(/test-first/);
    await expect(sectionOf('About').getByText(/not saved yet/)).toHaveCount(0);

    // ── A person's files go into the checkout, not onto the project ──
    await repository.getByRole('button', { name: 'Add files' }).click();
    const addFiles = repository.getByRole('form', { name: 'Add files to the repository' });
    await addFiles.getByLabel('Folder (optional)').fill('docs');
    await addFiles.getByLabel('Files').setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Notes\n'),
    });
    await shot('code-project-add-files.png');
    await addFiles.getByRole('button', { name: 'Add to checkout' }).click();
    await expect(
      repository.getByText(/Added docs\/notes\.md to the checkout, uncommitted/)
    ).toBeVisible();
    await expect(addFiles).toHaveCount(0);

    // ── Environment: none yet; paste a .env with one bad line; names appear,
    //    values never do; the bad line is reported; remove one; replace all ──
    const environment = sectionOf('Environment');
    await expect(environment.getByText('No environment variables.')).toBeVisible();
    await environment.getByRole('button', { name: 'Add .env' }).click();
    await environment
      .getByLabel('.env contents')
      .fill(
        '# registry\nNPM_TOKEN=npm_secret_value_123\nexport DATABASE_URL="postgres://x:y@db/app"\nthis is not a variable\n'
      );
    await environment.getByRole('button', { name: 'Save' }).click();
    await expect(environment.getByText('NPM_TOKEN')).toBeVisible();
    await expect(environment.getByText('DATABASE_URL')).toBeVisible();
    await expect(environment.getByText(/line 4: not a NAME=value line/)).toBeVisible();
    await expect(page.getByText('npm_secret_value_123')).toHaveCount(0);
    await expect(page.getByText('postgres://x:y@db/app')).toHaveCount(0);
    await shot('code-project-env.png');
    page.once('dialog', (dialog) => dialog.accept());
    await environment
      .getByRole('listitem')
      .filter({ hasText: 'DATABASE_URL' })
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(environment.getByText('DATABASE_URL')).toHaveCount(0);
    await expect(environment.getByText('NPM_TOKEN')).toBeVisible();
    await environment.getByRole('button', { name: 'Replace .env' }).click();
    await environment.getByLabel('.env contents').fill('API_BASE_URL=https://api.example.test\n');
    await environment.getByRole('button', { name: 'Save' }).click();
    await expect(environment.getByText('API_BASE_URL')).toBeVisible();
    await expect(environment.getByText('NPM_TOKEN')).toHaveCount(0);

    // ── Re-point the repository: the checkout is replaced and clones again ──
    await repository.getByRole('button', { name: 'Change repository' }).click();
    await repository.getByLabel('Repository').fill('acme/billing-service-v2');
    await repository.getByLabel('Branch').fill('release/2026-09');
    await repository.getByRole('button', { name: 'Clone', exact: true }).click();
    await expect(repository.getByText('acme/billing-service-v2')).toBeVisible();
    await expect(repository.getByText('Ready')).toBeVisible({ timeout: 15_000 });
    await expect(repository.getByText('@ release/2026-09')).toBeVisible();

    // ── A chat started in the project: its title bar names the project and
    //    links back to the Code page, not the chat projects page ──
    await main.getByRole('link', { name: 'New chat' }).click();
    await expect(
      page.getByRole('heading', { name: `New chat in ${ids.seededName}` })
    ).toBeVisible();
    const crumb = main.getByRole('link', { name: ids.seededName });
    await expect(crumb).toHaveAttribute('href', `/${E2E_SLUG}/code/${ids.seededProjectId}`);
    await expectNoHorizontalOverflow(page);
    await shot('code-chat-new.png');

    // ── The title bar's code buttons: Changes carries the checkout's
    //    +added −deleted and opens every diff (side by side on a wide
    //    screen); Environment opens the project's variables ──
    const changes = main.getByRole('button', { name: 'Changes' });
    await expect(changes).toContainText('+3');
    await expect(changes).toContainText('−1');
    await changes.click();
    const changesDialog = page.getByRole('dialog', { name: 'Changes' });
    await expect(changesDialog.getByText('src/billing.ts')).toBeVisible();
    await expect(changesDialog.getByText(/MAX_ATTEMPTS/).first()).toBeVisible();
    await expect(
      changesDialog.getByRole('button', { name: 'Ask the chat to open a pull request' })
    ).toBeVisible();
    await shot('code-chat-changes.png');
    await changesDialog.getByRole('button', { name: 'Close' }).click();
    await main.getByRole('button', { name: 'Environment' }).click();
    const envDialog = page.getByRole('dialog', { name: 'Environment' });
    await expect(envDialog.getByText('API_BASE_URL')).toBeVisible();
    await shot('code-chat-env.png');
    await envDialog.getByRole('button', { name: 'Close' }).click();
    await crumb.click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();
    await expect(main.getByRole('link', { name: ids.seededChatTitle })).toBeVisible();

    // ── A new code project through the form, with the picker and a .env ──
    await answerRepoPicker(page);
    await page.goto(`/${E2E_SLUG}/code/new`);
    await expect(page.getByRole('heading', { level: 1, name: 'New code project' })).toBeVisible();
    await expect(page.getByText('Connect Bitbucket first')).toHaveCount(0);
    const create = page.getByRole('button', { name: 'Create and clone' });
    await expect(create).toBeDisabled();
    await page.getByLabel('Name', { exact: true }).fill(ids.newName);
    await page.getByLabel(/^Repository/).fill('notif');
    await expect(
      page.locator('#code-project-repos option[value="acme/notifications-gateway"]')
    ).toHaveCount(1);
    await page.getByLabel(/^Repository/).fill('acme/notifications-gateway');
    await expect(page.getByLabel('Branch', { exact: true })).toHaveAttribute(
      'placeholder',
      'develop'
    );
    await page.getByLabel(/^\.env/).fill('SENDGRID_KEY=sg_live_abc\n');
    // The developer's brief is there to start from, and can be replaced.
    await expect(page.getByLabel(/^Instructions/)).toHaveValue(/test-first/);
    await page.getByLabel(/^Instructions/).fill('Run pnpm test before every commit.');
    await expectNoHorizontalOverflow(page);
    await shot('code-new.png');
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}/code/[0-9a-f-]{36}$`));
    await expect(page.getByRole('heading', { level: 1, name: ids.newName })).toBeVisible();
    const newRepo = sectionOf('Repository');
    await expect(newRepo.getByText('acme/notifications-gateway')).toBeVisible();
    await expect(newRepo.getByText('Ready')).toBeVisible({ timeout: 15_000 });
    const newEnv = sectionOf('Environment');
    await expect(newEnv.getByText('SENDGRID_KEY')).toBeVisible();
    await expect(page.getByText('sg_live_abc')).toHaveCount(0);
    await expect(page.getByText('Run pnpm test before every commit.')).toBeVisible();

    // ── Delete: the confirm names what goes, and the index no longer lists it ──
    await page.getByRole('button', { name: 'Delete project' }).click();
    await expect(
      page.getByText(/checkout on the sandbox, its environment variables/)
    ).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}/code$`));
    await expect(main.getByRole('link', { name: ids.newName })).toHaveCount(0);
    await expect(main.getByRole('link', { name: ids.seededName })).toBeVisible();
  });

  test('a clone that fails says so and offers to clone again', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const client = await db();
    try {
      await client.query(`UPDATE chat_projects SET repo_full_name = 'acme/fails' WHERE id = $1`, [
        ids.seededProjectId,
      ]);
    } finally {
      await client.end();
    }
    await page.goto(`/${E2E_SLUG}/code/${ids.seededProjectId}`);
    const repository = page
      .getByRole('main')
      .locator('section', { has: page.getByRole('heading', { level: 2, name: 'Repository' }) });
    await repository.getByRole('button', { name: 'Clone', exact: true }).click();
    await expect(repository.getByText('Clone failed', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(repository.getByText('The clone failed: repository not found.')).toBeVisible();
    await expect(repository.getByRole('button', { name: 'Clone again' })).toBeEnabled();
  });
});
