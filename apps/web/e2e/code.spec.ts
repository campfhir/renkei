/**
 * The Code section from a person's side: the index and the menu, a
 * project page before and after its checkout exists (with its README
 * from Bitbucket, its tree, the developer's brief kept on Save, the
 * environment replaced and pruned), a chat in it (back link, Add files
 * into the checkout, Changes with its diff, Environment), a new project
 * made through the form with the repository browsed on Bitbucket, and
 * deletion. The sandbox worker AND Bitbucket are the stub in
 * sandbox-stub.mjs (the app is pointed at it for both), so nothing here
 * needs the network. Screenshots land under
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
    // A repository created on the fly, through the "Create new repository"
    // tab — its own project so it never collides with the browsed-repo one.
    createdRepoName: `Analytics pipeline (${digit})`,
    createdRepoSlug: `analytics-pipeline-${digit}`,
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
    await client.query(`DELETE FROM chat_projects WHERE tenant_id = $1 AND name = ANY($2)`, [
      E2E_TENANT_ID,
      [ids.newName, ids.createdRepoName],
    ]);
    // A code project with no checkout yet — the first chat makes one.
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
    await client.query(`DELETE FROM chat_projects WHERE tenant_id = $1 AND name = ANY($2)`, [
      E2E_TENANT_ID,
      [ids.newName, ids.createdRepoName],
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

/** `chat_messages.content`: the content envelope — `renc1:` + the secretbox. */
function sealContent(plaintext: string): string {
  return `renc1:${secretbox(plaintext)}`;
}

/**
 * A finished turn in the seeded chat, as the runner leaves one in a code
 * project: the prompt, the clone step the runner wrote (a tool_use the
 * model never made, with its result row), the model's own commit call
 * with its result, and the reply.
 */
async function seedTranscript(ids: ReturnType<typeof idsFor>): Promise<void> {
  const turnId = `88888888-8888-4888-8888-8888888888${ids.digit}3`;
  const rows: {
    seq: number;
    role: string;
    kind: string;
    stop: string | null;
    blocks: unknown[];
  }[] = [
    {
      seq: 1,
      role: 'user',
      kind: 'prompt',
      stop: null,
      blocks: [{ type: 'text', text: 'Why does the invoice job retry forever?' }],
    },
    {
      seq: 2,
      role: 'assistant',
      kind: 'assistant',
      stop: 'tool_use',
      blocks: [
        {
          type: 'tool_use',
          id: 'prelude_e2e_clone',
          name: 'code_clone',
          input: { repository: 'acme/billing-service', branch: 'main' },
        },
      ],
    },
    {
      seq: 3,
      role: 'user',
      kind: 'tool_results',
      stop: null,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'prelude_e2e_clone',
          content:
            'Cloned acme/billing-service @ main — 4.1 MB on the sandbox, 12s. The code_* tools work in it now.',
        },
      ],
    },
    {
      seq: 4,
      role: 'assistant',
      kind: 'assistant',
      stop: 'tool_use',
      blocks: [
        {
          type: 'tool_use',
          id: 'toolu_e2e_commit',
          name: 'code_git_commit',
          input: { message: 'Cap invoice retries at MAX_ATTEMPTS', newBranch: 'fix/retry-cap' },
        },
      ],
    },
    {
      seq: 5,
      role: 'user',
      kind: 'tool_results',
      stop: null,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'toolu_e2e_commit',
          content: 'Committed 3f2a9c1 on fix/retry-cap.',
        },
      ],
    },
    {
      seq: 6,
      role: 'assistant',
      kind: 'assistant',
      stop: 'end_turn',
      blocks: [
        {
          type: 'text',
          text: 'The retry loop had no ceiling; it now stops at MAX_ATTEMPTS, committed on fix/retry-cap.',
        },
      ],
    },
  ];
  const client = await db();
  try {
    await client.query(
      `INSERT INTO chat_turns (id, tenant_id, chat_id, status, iterations, input_tokens, output_tokens, finished_at)
       VALUES ($1, $2, $3, 'completed', 2, 900, 120, NOW())`,
      [turnId, E2E_TENANT_ID, ids.seededChatId]
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, stop_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8)`,
        [
          E2E_TENANT_ID,
          ids.seededChatId,
          turnId,
          row.seq,
          row.role,
          row.kind,
          sealContent(JSON.stringify(row.blocks)),
          row.stop,
        ]
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * A checkout for the seeded project, as a first chat would leave it: the
 * stub worker clones it under the project's own scope and the row points
 * at it — the page never clones anything itself.
 */
async function seedCheckout(ids: ReturnType<typeof idsFor>): Promise<void> {
  const worker = process.env.SANDBOX_WORKER_URL ?? 'http://127.0.0.1:8092';
  const headers = {
    authorization: `Bearer ${process.env.SANDBOX_WORKER_API_KEY ?? 'e2e-sandbox-key'}`,
    'content-type': 'application/json',
  };
  const target = { tenantId: E2E_TENANT_ID, subject: `code-project:${ids.seededProjectId}` };
  const cloned = await fetch(`${worker}/v1/workspaces/clone`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...target,
      provider: 'atlassian-bitbucket',
      repoFullName: 'acme/billing-service',
      branch: 'main',
      cloneUrl: 'https://bitbucket.org/acme/billing-service.git',
      authHeader: 'Basic e2e',
    }),
  });
  const { workspace }: { workspace: { id: string } } = await cloned.json();
  for (let tries = 0; tries < 20; tries += 1) {
    const got = await fetch(`${worker}/v1/workspaces/get`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...target, id: workspace.id }),
    });
    const state: { workspace: { status: string } } = await got.json();
    if (state.workspace.status === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const client = await db();
  try {
    await client.query('UPDATE chat_projects SET workspace_id = $1 WHERE id = $2', [
      workspace.id,
      ids.seededProjectId,
    ]);
  } finally {
    await client.end();
  }
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

    // ── The seeded project's page: not cloned yet (the first chat does
    //    that), the repository fixed — no clone or change buttons — and
    //    the README from Bitbucket in place of a description ──
    await seededRow.click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();
    await expect(page.getByText('Your code project')).toBeVisible();
    // A code project keeps no files of its own, picks its tools per chat,
    // and describes itself through its README; its chats are listed here.
    await expect(main.getByRole('button', { name: 'Add files' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Tools' })).toHaveCount(0);
    await expect(main.getByLabel('Description')).toHaveCount(0);
    await expect(
      main.getByRole('heading', { level: 2, name: 'Chats in this project' })
    ).toBeVisible();
    await expect(main.getByRole('link', { name: ids.seededChatTitle })).toBeVisible();
    const readme = sectionOf('README');
    await expect(readme.getByRole('heading', { name: 'Billing service' })).toBeVisible();
    await expect(readme.getByRole('heading', { name: 'Running it' })).toBeVisible();
    // A subheading sits under its title, not beside it.
    const memoryTitle = main.getByRole('heading', { level: 2, name: 'Memory' });
    const memoryNote = main.getByText("Notes the assistant keeps across this project's chats.");
    expect((await memoryNote.boundingBox())!.y).toBeGreaterThan(
      (await memoryTitle.boundingBox())!.y + 10
    );
    const repository = sectionOf('Repository');
    await expect(repository.getByText('Not cloned yet')).toBeVisible();
    await expect(repository.getByText('acme/billing-service')).toBeVisible();
    await expect(repository.getByText(/The first chat in this project clones it/)).toBeVisible();
    await expect(repository.getByRole('button')).toHaveCount(0);
    await expect(repository.getByRole('link', { name: 'Open on Bitbucket' })).toHaveAttribute(
      'href',
      'https://bitbucket.org/acme/billing-service'
    );
    // The tree is there before any checkout, read from Bitbucket.
    if (mobile) await main.getByText('Files', { exact: true }).click();
    const tree = main.getByRole('tree', { name: 'Files' });
    await expect(tree.getByText('package.json')).toBeVisible();
    await expect(main.getByText('origin/main')).toBeVisible();
    await expect(main.getByText('not cloned yet', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-project-not-cloned.png');

    // ── Back to Code, and in again ──
    await main.getByRole('link', { name: 'Back to Code' }).click();
    await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}/code$`));
    await seededRow.click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();

    // ── With a checkout (as a first chat would leave it): Ready, the tree ──
    await seedCheckout(ids);
    await page.reload();
    await expect(repository.getByText('Ready')).toBeVisible();
    await expect(repository.getByText(/4\.1 MB on the sandbox/)).toBeVisible();
    await shot('code-project-ready.png');

    // ── The repository tree, now from the checkout: beside the sections on
    //    a wide screen, folded above them on a narrow one; folders open as
    //    they are clicked ──
    if (mobile) await main.getByText('Files', { exact: true }).click();
    await expect(tree.getByText('package.json')).toBeVisible();
    await expect(main.getByText('working branch', { exact: true })).toBeVisible();
    await expect(main.getByText('origin/main')).toHaveCount(0);
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

    // ── Environment: none yet; paste a .env with one bad line; names appear,
    //    the bad line is reported, a value is never rendered ──
    const environment = sectionOf('Environment');
    await expect(environment.getByText('No environment variables.')).toBeVisible();
    await environment.getByRole('button', { name: 'Add .env' }).click();
    await environment
      .getByLabel('.env contents')
      .fill(
        'NPM_TOKEN=npm_secret_value_123\nDATABASE_URL=postgres://u:p@db/app\nexport DEBUG=1\nthis line is broken\n'
      );
    await environment.getByRole('button', { name: 'Save' }).click();
    await expect(environment.getByText('NPM_TOKEN')).toBeVisible();
    await expect(environment.getByText('DATABASE_URL')).toBeVisible();
    await expect(environment.getByText('DEBUG')).toBeVisible();
    await expect(environment.getByText(/Not read from the pasted \.env: line 4/)).toBeVisible();
    await expect(page.getByText('npm_secret_value_123')).toHaveCount(0);
    await expect(page.getByText('postgres://u:p@db/app')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-project-env.png');
    // Remove one; replace the rest.
    page.once('dialog', (dialog) => void dialog.accept());
    await environment
      .getByRole('listitem')
      .filter({ hasText: 'DEBUG' })
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(environment.getByText('DEBUG')).toHaveCount(0);
    await environment.getByRole('button', { name: 'Replace .env' }).click();
    await environment.getByLabel('.env contents').fill('API_BASE_URL=https://api.example.test\n');
    await environment.getByRole('button', { name: 'Save' }).click();
    await expect(environment.getByText('API_BASE_URL')).toBeVisible();
    await expect(environment.getByText('NPM_TOKEN')).toHaveCount(0);

    // ── A chat started in the project: its title bar names the project,
    //    links back to it, and carries the code buttons ──
    await main.getByRole('link', { name: 'New chat' }).click();
    await expect(
      page.getByRole('heading', { name: `New chat in ${ids.seededName}` })
    ).toBeVisible();
    const crumb = main.getByRole('link', { name: ids.seededName });
    await expect(crumb).toHaveAttribute('href', `/${E2E_SLUG}/code/${ids.seededProjectId}`);
    await expect(main.getByRole('link', { name: 'Back to project' })).toHaveAttribute(
      'href',
      `/${E2E_SLUG}/code/${ids.seededProjectId}`
    );
    await expectNoHorizontalOverflow(page);
    await shot('code-chat-new.png');

    // On a phone the title bar keeps Tools and folds the rest into "More".
    const action = async (name: string) => {
      if (mobile) {
        await main.getByRole('button', { name: 'More' }).click();
        await main.getByRole('menuitem', { name }).click();
      } else await main.getByRole('button', { name }).click();
    };

    // ── Add files: picked (or dropped) files land in the checkout,
    //    untracked, for the chat's tools ──
    await action('Add files');
    const filesDialog = page.getByRole('dialog', { name: 'Add files' });
    await expect(filesDialog.getByText(/land as untracked files/)).toBeVisible();
    await filesDialog.getByLabel('Folder (optional)').fill('docs');
    await filesDialog.locator('input[type="file"]').setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Notes\n'),
    });
    await expect(filesDialog.getByText('notes.md')).toBeVisible();
    await shot('code-chat-add-files.png');
    await filesDialog.getByRole('button', { name: 'Add to repository' }).click();
    await expect(filesDialog.getByText('Added to the checkout: docs/notes.md.')).toBeVisible();
    await filesDialog.getByRole('button', { name: 'Done' }).click();

    // ── Changes carries the checkout's +added −deleted and opens every
    //    diff (side by side on a wide screen); Environment opens the
    //    project's variables ──
    if (mobile) await main.getByRole('button', { name: 'More' }).click();
    const changes = mobile
      ? main.getByRole('menuitem', { name: 'Changes' })
      : main.getByRole('button', { name: 'Changes' });
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
    await action('Environment');
    const envDialog = page.getByRole('dialog', { name: 'Environment' });
    await expect(envDialog.getByText('API_BASE_URL')).toBeVisible();
    await shot('code-chat-env.png');
    await envDialog.getByRole('button', { name: 'Close' }).click();
    await main.getByRole('link', { name: 'Back to project' }).click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();
    await expect(main.getByRole('link', { name: ids.seededChatTitle })).toBeVisible();

    // ── A finished turn in the project's chat: the clone step reads as a
    //    sentence after the prompt, the commit by its own name, each with
    //    its git glyph, both opening to their input and result ──
    await seedTranscript(ids);
    await main.getByRole('link', { name: ids.seededChatTitle }).click();
    await expect(main.getByText('Why does the invoice job retry forever?')).toBeVisible();
    const work = main.locator('details.chat-fold').first();
    await expect(work).toContainText('2 tool calls');
    await work.locator('> summary').click();
    const steps = work.locator('ol > li > details.chat-fold');
    const cloneStep = steps.filter({ hasText: 'Cloned the repository' });
    await expect(cloneStep).toBeVisible();
    await cloneStep.locator('> summary').click();
    await expect(cloneStep.getByText(/4\.1 MB on the sandbox/)).toBeVisible();
    const commitStep = steps.filter({ hasText: 'Called Commit' });
    await expect(commitStep).toBeVisible();
    await expect(main.getByText('Calling', { exact: false })).toHaveCount(0);
    await shot('code-chat-transcript.png');
    await main.getByRole('link', { name: 'Back to project' }).click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();

    // ── A new code project through the form: the repository browsed on
    //    Bitbucket (workspace → project → repositories), a .env pasted,
    //    the brief there to start from; nothing cloned yet ──
    await page.goto(`/${E2E_SLUG}/code/new`);
    await expect(page.getByRole('heading', { level: 1, name: 'New code project' })).toBeVisible();
    await expect(page.getByText('Connect Bitbucket first')).toHaveCount(0);
    const create = page.getByRole('button', { name: 'Create project' });
    await expect(create).toBeDisabled();
    await page.getByLabel(/^Name/).fill(ids.newName);
    const workspacePick = page.getByRole('combobox', { name: /^Workspace/ });
    await expect(workspacePick).toBeEnabled({ timeout: 15_000 });
    await workspacePick.selectOption('acme');
    const projectPick = page.getByRole('combobox', { name: /^Project/ });
    await expect(projectPick).toBeEnabled({ timeout: 15_000 });
    await projectPick.selectOption('NOTIF');
    const repoList = page.getByRole('list', { name: 'Repositories' });
    await expect(repoList.getByText('acme/notifications-gateway')).toBeVisible();
    await expect(repoList.getByText('acme/billing-service')).toHaveCount(0);
    await shot('code-new-browse.png');
    await repoList.getByRole('button', { name: /notifications-gateway/ }).click();
    await expect(page.getByText('acme/notifications-gateway')).toBeVisible();
    await expect(page.getByLabel('Branch (optional)')).toHaveAttribute('placeholder', 'develop');
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
    await expect(newRepo.getByText('Not cloned yet')).toBeVisible();
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

  test('new project via a freshly created Bitbucket repository', async ({ page }, testInfo) => {
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
    const sectionOf = (name: string) =>
      main.locator('section', { has: page.getByRole('heading', { level: 2, name }) });

    // ── "Create new repository", beside "Choose existing": pick the
    //    workspace and project, name it, and an empty repo appears on
    //    Bitbucket — used exactly like one the browser would have found ──
    await page.goto(`/${E2E_SLUG}/code/new`);
    await page.getByLabel(/^Name/).fill(ids.createdRepoName);
    await page.getByRole('tab', { name: 'Create new' }).click();
    const workspacePick = page.getByRole('combobox', { name: /^Workspace/ });
    await expect(workspacePick).toBeEnabled({ timeout: 15_000 });
    await workspacePick.selectOption('acme');
    const projectPick = page.getByRole('combobox', { name: /^Project/ });
    await expect(projectPick).toBeEnabled({ timeout: 15_000 });
    await projectPick.selectOption('NOTIF');
    const createRepo = page.getByRole('button', { name: 'Create repository', exact: true });
    await expect(createRepo).toBeDisabled();
    await page.getByLabel('Repository name').fill(ids.createdRepoName);
    await expect(
      page.getByText(`Creates acme/${ids.createdRepoSlug} — empty and private.`)
    ).toBeVisible();
    await expect(createRepo).toBeEnabled();
    await shot('code-new-create-repo.png');
    await createRepo.click();

    // ── The created repo drops into the same "chosen" slot a browsed one
    //    would; the rest of the form (branch placeholder, instructions,
    //    Create project) behaves identically to an existing repository ──
    await expect(page.getByText(`acme/${ids.createdRepoSlug}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose another' })).toBeVisible();
    await expect(page.getByLabel('Branch (optional)')).toHaveAttribute(
      'placeholder',
      'main branch'
    );
    const create = page.getByRole('button', { name: 'Create project' });
    await expect(create).toBeEnabled();
    await create.click();
    // First hit on these routes in this test (unlike the big walkthrough
    // above, which has already warmed them up) — dev-mode's on-demand
    // compile can outrun the default assertion timeout.
    await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}/code/[0-9a-f-]{36}$`), {
      timeout: 20_000,
    });
    await expect(page.getByRole('heading', { level: 1, name: ids.createdRepoName })).toBeVisible();
    const newRepo = sectionOf('Repository');
    await expect(newRepo.getByText(`acme/${ids.createdRepoSlug}`)).toBeVisible();
    await expect(newRepo.getByText('Not cloned yet')).toBeVisible();
  });
});
