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
        ['account', 'repository', 'repository:write', 'pullrequest', 'pullrequest:write'],
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
    // The one chat in the project is its active chat, as starting it
    // through the app would have left it (lib/code/active-chat.ts).
    await client.query('UPDATE chat_projects SET active_chat_id = $1 WHERE id = $2', [
      ids.seededChatId,
      ids.seededProjectId,
    ]);
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
    //    "+" of its own — the Code page's button makes projects, and the
    //    projects are listed there, not here. The chat inside one IS among
    //    the person's chats, marked as a code chat and naming its project
    //    beneath its title ──
    await openMenu();
    const codeEntry = menu.getByRole('link', { name: 'Code', exact: true });
    await expect(codeEntry).toBeVisible();
    await expect(codeEntry.locator('svg')).toHaveCount(1);
    await expect(menu.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'New code project' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: ids.seededName, exact: true })).toHaveCount(0);
    const chatRow = menu.getByRole('link', { name: ids.seededChatTitle });
    await expect(chatRow).toBeVisible();
    await expect(chatRow.locator('[data-kind="code"]')).toHaveCount(1);
    await expect(chatRow.getByText(ids.seededName)).toBeVisible();
    if (!mobile) await shot('code-menu.png');
    if (mobile) await page.getByRole('button', { name: 'Close menu' }).click();

    // ── The seeded project's page: not cloned yet (the first chat does
    //    that), the repository fixed — no clone or change buttons — and
    //    the README from Bitbucket in place of a description ──
    await seededRow.click();
    // First hit on a project page in this test: dev-mode's on-demand
    // compile can outrun the default assertion timeout.
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Your code project')).toBeVisible();
    // A code project keeps no files of its own, has a toolset of its own
    // (the picker in its header, which its chats start from), and
    // describes itself through its README; its chats are listed here.
    await expect(main.getByRole('button', { name: 'Add files' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Tools' })).toBeVisible();
    await expect(main.getByLabel('Description')).toHaveCount(0);
    await expect(
      main.getByRole('heading', { level: 2, name: 'Chats in this project' })
    ).toBeVisible();
    await expect(main.getByRole('link', { name: ids.seededChatTitle })).toBeVisible();
    const readme = sectionOf('README');
    await expect(readme.getByRole('heading', { name: 'Billing service' })).toBeVisible();
    await expect(readme.getByRole('heading', { name: 'Running it' })).toBeVisible();
    // The chats come right after the environment — what the page is opened
    // for — with the README beneath them, and the README folds away.
    const headings = await main.getByRole('heading', { level: 2 }).allTextContents();
    const at = (name: string) => headings.findIndex((text) => text.startsWith(name));
    expect(at('Environment')).toBeGreaterThan(at('Repository'));
    expect(at('Chats in this project')).toBeGreaterThan(at('Environment'));
    expect(at('README')).toBeGreaterThan(at('Chats in this project'));
    expect(at('About')).toBeGreaterThan(at('README'));
    await readme.getByRole('heading', { level: 2, name: 'README' }).click();
    await expect(readme.getByRole('heading', { name: 'Running it' })).toBeHidden();
    await expect(readme.getByRole('heading', { level: 2, name: 'README' })).toBeVisible();
    await shot('code-project-readme-folded.png');
    await readme.getByRole('heading', { level: 2, name: 'README' }).click();
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
    // The project screen carries no file browser — that lives in the code
    // pane beside a chat (see 'the code pane: read, edit, save, commit and
    // push beside the chat', below).
    await expect(main.getByRole('tree', { name: 'Files' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-project-not-cloned.png');

    // ── Back to Code, and in again ──
    await main.getByRole('link', { name: 'Back to Code' }).click();
    await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}/code$`));
    await seededRow.click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();

    // ── With a checkout (as a first chat would leave it): Ready ──
    await seedCheckout(ids);
    await page.reload();
    await expect(repository.getByText('Ready')).toBeVisible();
    await expect(repository.getByText(/4\.1 MB on the sandbox/)).toBeVisible();
    await shot('code-project-ready.png');

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
    await main.getByRole('button', { name: 'New chat' }).click();
    // First hit on the chat page in this test — and, beside it, the code
    // pane's own bundle: dev-mode's on-demand compile can outrun the
    // default assertion timeout.
    await expect(page.getByRole('heading', { name: `New chat in ${ids.seededName}` })).toBeVisible({
      timeout: 30_000,
    });
    const crumb = main.getByRole('link', { name: ids.seededName });
    await expect(crumb).toHaveAttribute('href', `/${E2E_SLUG}/code/${ids.seededProjectId}`);
    await expect(main.getByRole('link', { name: 'Back to project' })).toHaveAttribute(
      'href',
      `/${E2E_SLUG}/code/${ids.seededProjectId}`
    );
    // The code pane opens beside a code chat on a wide screen (its own
    // test below) and narrows the chat's column into its compact title
    // bar; these steps are about that bar's own buttons, so the pane is
    // put away first.
    if (!mobile) {
      await main.getByRole('button', { name: 'Hide the code' }).click();
      await expect(main.getByRole('tablist', { name: 'Open files' })).toHaveCount(0);
    }
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
    //    sentence inside the work fold after the prompt; the commit is
    //    lifted out of the fold as a milestone card of its own, with its
    //    git glyph and the result on its line ──
    await seedTranscript(ids);
    await main.getByRole('link', { name: ids.seededChatTitle }).click();
    await expect(main.getByText('Why does the invoice job retry forever?')).toBeVisible();
    const work = main.locator('details.chat-fold:not([data-milestone])').first();
    await expect(work).toContainText('1 tool call');
    await work.locator('> summary').click();
    const steps = work.locator('ol > li > details.chat-fold');
    const cloneStep = steps.filter({ hasText: 'Cloned the repository' });
    await expect(cloneStep).toBeVisible();
    await cloneStep.locator('> summary').click();
    await expect(cloneStep.getByText(/4\.1 MB on the sandbox/)).toBeVisible();
    const commitCard = main.locator('details[data-milestone="code_git_commit"]');
    await expect(commitCard).toBeVisible();
    await expect(commitCard).toContainText('Committed');
    await expect(commitCard).toContainText('3f2a9c1');
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

  test('the code pane: read, edit, save, commit and push beside the chat', async ({
    page,
  }, testInfo) => {
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
    const main = page.getByRole('main');
    await seedCheckout(ids);
    await page.goto(`/${E2E_SLUG}/chat/${ids.seededChatId}`);
    await expect(page.getByRole('heading', { name: ids.seededChatTitle })).toBeVisible();

    if (mobile) {
      // ── A phone: the pane is the Code tab of a switch in the title bar.
      //    It opens on the working tree's changed files, then the tree,
      //    with Commit along the bottom ──
      const tabs = main.getByRole('tablist', { name: 'Chat or code' });
      await expect(tabs.getByRole('tab', { name: /Chat/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await tabs.getByRole('tab', { name: /Code/ }).click();
      await expect(main.getByText('Changed · not committed')).toBeVisible({ timeout: 20_000 });
      await expect(main.getByRole('button', { name: /src\/billing\.ts/ }).first()).toBeVisible();
      await expect(main.getByRole('tree', { name: 'Files' })).toBeVisible();
      await expect(main.getByRole('button', { name: /^Commit/ })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('code-pane-mobile-files.png');

      // ── A file opens over the list, in a plain text area with accessory
      //    keys, Save above the keyboard ──
      await main
        .getByRole('button', { name: /src\/billing\.ts/ })
        .first()
        .click();
      const area = main.getByLabel('Contents of src/billing.ts');
      await expect(area).toBeVisible();
      await expect(area).toHaveValue(/MAX_ATTEMPTS/);
      await expect(main.getByRole('toolbar', { name: 'Keys' })).toBeVisible();
      // The text area is coloured: the same text drawn beneath it in the
      // chat's code palette, TypeScript keywords and strings told apart.
      const backdrop = main.locator('.code-area-backdrop');
      await expect(backdrop.locator('.hljs-keyword', { hasText: 'import' }).first()).toBeVisible();
      await expect(backdrop.locator('.hljs-string', { hasText: './util' })).toBeVisible();
      const save = main.getByRole('button', { name: 'Save to checkout' });
      await expect(save).toBeDisabled();
      await area.focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\n// reviewed by hand\n');
      await expect(save).toBeEnabled();
      await expect(tabs.getByRole('tab', { name: /Code/ })).toContainText('1');
      // What was just typed is coloured as it lands: a comment.
      await expect(
        backdrop.locator('.hljs-comment', { hasText: 'reviewed by hand' })
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('code-pane-mobile-editing.png');
      await save.click();
      await expect(save).toBeDisabled();

      // ── Commit from the list, as a dialog; then the Chat tab shows what
      //    was done ──
      await main.getByRole('button', { name: 'Back to files' }).click();
      await main.getByRole('button', { name: /^Commit/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Commit changes' });
      await expect(dialog.getByText('src/billing.ts')).toBeVisible();
      await expect(dialog.getByText('edited here')).toBeVisible();
      await dialog.getByLabel('Message').fill('Note the manual review');
      await shot('code-pane-mobile-commit.png');
      await dialog.getByRole('button', { name: /^Commit 1 file/ }).click();
      const done = page.getByRole('dialog', { name: 'Committed' });
      await expect(done.getByText(/Committed c0ffee/)).toBeVisible();
      await done.getByRole('button', { name: 'Done' }).click();
      await tabs.getByRole('tab', { name: /Chat/ }).click();
      await expect(main.getByText(/You edited/)).toBeVisible();
      await expect(main.getByText(/You committed c0ffee/)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('code-pane-mobile-chat-notes.png');
      return;
    }

    // ── A wide screen: the pane beside the chat, open at first, with the
    //    back arrow at the page's left edge, the changed files above the
    //    tree, and the chat in its compact form on the right ──
    const openFiles = main.getByRole('tablist', { name: 'Open files' });
    await expect(openFiles).toBeVisible();
    // First hits on the tree and diff routes in this test: dev-mode's
    // on-demand compile can outrun the default assertion timeout.
    const tree = main.getByRole('tree', { name: 'Files' });
    await expect(tree.getByText('package.json')).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText('Changed · not committed')).toBeVisible({ timeout: 20_000 });
    const back = main.getByRole('link', { name: 'Back to project' });
    await expect(back).toHaveAttribute('href', `/${E2E_SLUG}/code/${ids.seededProjectId}`);
    expect((await back.boundingBox())!.x).toBeLessThan((await tree.boundingBox())!.x);
    expect((await back.boundingBox())!.x).toBeLessThan((await openFiles.boundingBox())!.x);
    // The chat column is narrow beside the pane: its title bar folds.
    await expect(main.getByRole('button', { name: 'More', exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Changes' })).toHaveCount(0);

    // ── A file from the tree opens in Monaco, read as the checkout has it ──
    // (each row's own "More for <name>" button also matches on a loose
    // name — anchoring at the start keeps this the row's own button)
    await tree.getByRole('button', { name: 'src', exact: true }).click();
    await tree.getByRole('button', { name: /^billing\.ts/ }).click();
    await expect(openFiles.getByRole('tab', { name: /billing\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const editor = main.locator('.monaco-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.getByText('MAX_ATTEMPTS').first()).toBeVisible();
    await expect(
      main.getByText('Saved to the checkout · not committed until you commit')
    ).toBeVisible();
    // Coloured as TypeScript, in the pane's own theme: the status line names
    // the language, and the tokens on screen are painted in several colours
    // (Monaco gives each colour of the theme its own class).
    await expect(main.getByText('TypeScript', { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        editor
          .locator('.view-lines span[class*="mtk"]')
          .evaluateAll((spans) => new Set(spans.map((span) => span.className)).size)
      )
      .toBeGreaterThan(3);
    await expectNoHorizontalOverflow(page);
    await shot('code-pane-desktop.png');

    // ── Typing marks the tab and counts as unsaved; Save writes it to the
    //    checkout and the chat notes what was done ──
    const saveButton = main.getByRole('button', { name: /^Save/ });
    await expect(saveButton).toBeDisabled();
    await editor.locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n// reviewed by hand\n');
    await expect(main.getByText('1 unsaved')).toBeVisible();
    await expect(saveButton).toBeEnabled();
    await expect(main.getByText('Unsaved edits · Save writes to the checkout')).toBeVisible();
    await shot('code-pane-desktop-editing.png');
    await saveButton.click();
    await expect(main.getByText('1 unsaved')).toHaveCount(0);
    await expect(main.getByText(/You edited/)).toBeVisible();
    await expect(main.getByRole('button', { name: 'src/billing.ts', exact: true })).toBeVisible();

    // ── Commit: the changed files with who-changed-what tags, a message,
    //    then the hash and a push ──
    await main.getByRole('button', { name: /^Commit/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Commit changes' });
    await expect(dialog.getByText('src/billing.ts')).toBeVisible();
    await expect(dialog.getByText('edited here')).toBeVisible();
    await expect(dialog.getByText(/Nothing leaves the sandbox until you push/)).toBeVisible();
    await dialog.getByLabel('Message').fill('Note the manual review');
    await dialog.getByLabel('Description').fill('A comment for the next reader.');
    await shot('code-pane-desktop-commit.png');
    await dialog.getByRole('button', { name: /^Commit 1 file/ }).click();
    const done = page.getByRole('dialog', { name: 'Committed' });
    await expect(done.getByText(/Committed c0ffee/)).toBeVisible();
    await expect(done.getByText('not pushed')).toBeVisible();
    await done.getByRole('button', { name: 'Push branch' }).click();
    await expect(done.getByText(/pushed to origin\/main/)).toBeVisible();
    await shot('code-pane-desktop-pushed.png');
    await done.getByRole('button', { name: 'Done' }).click();
    await expect(main.getByText(/You committed c0ffee/)).toBeVisible();
    await expect(main.getByText(/You pushed main/)).toBeVisible();

    // ── Hidden, the chat takes the whole column back and the back arrow
    //    returns to its title bar; shown again, it comes back with its tabs ──
    await main.getByRole('button', { name: 'Hide the code' }).click();
    await expect(openFiles).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Changes' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Back to project' })).toBeVisible();
    await shot('code-pane-desktop-hidden.png');
    await main.getByRole('button', { name: 'Show the code' }).click();
    await expect(openFiles.getByRole('tab', { name: /billing\.ts/ })).toBeVisible();
  });

  test('the code pane: a language server behind the editor', async ({ page }, testInfo) => {
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
    const main = page.getByRole('main');
    await seedCheckout(ids);
    await page.goto(`/${E2E_SLUG}/chat/${ids.seededChatId}`);
    await expect(page.getByRole('heading', { name: ids.seededChatTitle })).toBeVisible();

    if (mobile) {
      // A phone has the text area, which has no language server: the
      // file opens and colours as before, and nothing claims a server.
      const tabs = main.getByRole('tablist', { name: 'Chat or code' });
      await tabs.getByRole('tab', { name: /Code/ }).click();
      await main
        .getByRole('button', { name: /src\/billing\.ts/ })
        .first()
        .click({ timeout: 20_000 });
      await expect(main.getByLabel('Contents of src/billing.ts')).toHaveValue(/MAX_ATTEMPTS/);
      await expect(main.getByText(/language server/)).toHaveCount(0);
      return;
    }

    // ── The file opens; the stub worker has a TypeScript server, which the
    //    pane starts and names in the status line ──
    const tree = main.getByRole('tree', { name: 'Files' });
    await expect(tree.getByText('package.json')).toBeVisible({ timeout: 20_000 });
    // (each row's own "More for <name>" button also matches on a loose
    // name — anchoring at the start keeps this the row's own button)
    await tree.getByRole('button', { name: 'src', exact: true }).click();
    await tree.getByRole('button', { name: /^billing\.ts/ }).click();
    const editor = main.locator('.monaco-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.getByText('MAX_ATTEMPTS').first()).toBeVisible();
    await expect(
      main.getByRole('status').filter({ hasText: 'TypeScript language server' })
    ).toBeVisible({
      timeout: 20_000,
    });

    // ── The server's diagnostic is a marker on the declaration it names ──
    await expect(editor.locator('.squiggly-warning').first()).toBeVisible({ timeout: 20_000 });

    // ── Hover asks the server; its answer is the hover card ──
    await editor.getByText('MAX_ATTEMPTS').first().hover();
    // Monaco keeps two hover widgets (the text's and the glyph margin's);
    // the one that shows is the text's.
    const hover = page.locator('.monaco-hover:not(.hidden)');
    await expect(hover).toBeVisible({ timeout: 20_000 });
    await expect(hover).toContainText('From the stub language server');
    await shot('code-pane-lsp-hover.png');

    // ── Completion comes from the server too ──
    await page.keyboard.press('Escape');
    await editor.locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('ret');
    const suggest = page.locator('.suggest-widget');
    try {
      await expect(suggest).toBeVisible({ timeout: 5_000 });
    } catch {
      // Quick suggestions did not open it; ask outright.
      await page.keyboard.press('Control+Space');
    }
    await expect(suggest).toBeVisible({ timeout: 20_000 });
    // The label and its detail line both carry the name; the label is first.
    await expect(suggest.getByText('retryInvoice', { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    await shot('code-pane-lsp-completion.png');
    await page.keyboard.press('Escape');

    // ── Go to definition lands in another file: it opens as a tab of the
    //    pane, its model loaded, the range revealed ──
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('F12');
    const openFiles = main.getByRole('tablist', { name: 'Open files' });
    await expect(openFiles.getByRole('tab', { name: /index\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 20_000 }
    );
    await expect(editor.getByText('retryInvoice').first()).toBeVisible();
    await shot('code-pane-lsp-definition.png');

    // Back on the first tab the server is still attached (one per language, not per file).
    await openFiles
      .getByRole('tab', { name: /billing\.ts/ })
      .getByRole('button')
      .first()
      .click();
    await expect(
      main.getByRole('status').filter({ hasText: 'TypeScript language server' })
    ).toBeVisible();

    // ── A file whose language has no server is counted in
    //    code_language_gaps (no UI; an operator's query) ──
    await tree.getByRole('button', { name: /^package\.json/ }).click();
    await expect(openFiles.getByRole('tab', { name: /package\.json/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect
      .poll(
        async () => {
          const client = await db();
          try {
            const rows = await client.query(
              `SELECT reason, sample_path FROM code_language_gaps
                WHERE tenant_id = $1 AND extension = 'json' AND language = 'json'`,
              [E2E_TENANT_ID]
            );
            return rows.rows[0] ?? null;
          } finally {
            await client.end();
          }
        },
        { timeout: 10_000 }
      )
      .toMatchObject({ reason: 'no_server', sample_path: 'package.json' });
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
