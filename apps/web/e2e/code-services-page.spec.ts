/**
 * A code project's Services from the person's side: the card on the
 * project page (none yet, how many images are allowed) opening the
 * project's Services page, where a Postgres is started from the form
 * with its container variables and an export, listed running with its
 * address and the variables it sets, its lines in the combined tail
 * that follows as it writes, then stopped —
 * and the page at phone width. The sandbox worker is the stub in
 * sandbox-stub.mjs (no engine: a start reads running at a made-up
 * address at once), which seeds the same allowed images migration 121
 * does. Each Playwright project seeds a project of its own, so the
 * three never share a service.
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
    projectId: `66666666-6666-4666-8666-6666666666${digit}1`,
    name: `Services demo (${digit})`,
    repo: `acme/services-demo-${digit}`,
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
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'Where a database runs beside the checkout.', 'code', 'atlassian-bitbucket', $5, 'main')`,
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

/** Nothing scrolls sideways — the document, and the frame's own scroll container inside it. */
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

test.describe('Code project services', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seedFixtures(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await cleanFixtures(idsFor(testInfo.project.name));
  });

  test('card, page, start, tail, stop, phone width', async ({ page }, testInfo) => {
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
    const pagePath = `/${E2E_SLUG}/code/${ids.projectId}/services`;

    // ── The project page: a card after the environment, before the chats ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    const card = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Services' }),
    });
    const headings = await main.getByRole('heading', { level: 2 }).allTextContents();
    const at = (name: string) => headings.findIndex((text) => text.startsWith(name));
    expect(at('Services')).toBeGreaterThan(at('Environment'));
    expect(at('Chats in this project')).toBeGreaterThan(at('Services'));
    await expect(card.getByText(/^None yet · \d+ allowed images/)).toBeVisible();
    await expect(card.getByText('None running')).toBeVisible();
    await expect(card.getByRole('button')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-services-card.png');

    // ── Into the page: nothing running, the allowed images listed ──
    await card.getByRole('link', { name: /Running services & logs/ }).click();
    await expect(page).toHaveURL(new RegExp(`${pagePath}$`));
    await expect(page.getByRole('heading', { level: 1, name: /^Services/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(main.getByText(ids.repo)).toBeVisible();
    const running = main.getByRole('region', { name: 'Running' });
    await expect(running.getByText(/^No services\./)).toBeVisible();
    const allowed = main.getByRole('region', { name: 'Allowed images' });
    await expect(allowed.getByText('docker.io/library/postgres', { exact: true })).toBeVisible();
    await expect(
      allowed.getByRole('link', { name: 'Organization → Code services' })
    ).toHaveAttribute('href', `/${E2E_SLUG}/admin/code-services`);
    await expectNoHorizontalOverflow(page);
    await shot('code-services-page-empty.png');

    // ── Start a Postgres from the form: the container's variables and an
    //    export as text; it lists running with its address and what it sets ──
    await running.getByRole('button', { name: 'Start a service' }).click();
    const form = running.getByRole('form', { name: 'Start a service' });
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue('db');
    await form.getByLabel('Image', { exact: true }).fill('postgres:16');
    await form.getByLabel(/^Container variables/).fill('POSTGRES_PASSWORD=test\nPOSTGRES_DB=app');
    await form
      .getByLabel(/^Exports/)
      .fill('DATABASE_URL=postgres://postgres:test@{host}:{port}/app');
    await shot('code-services-start-form.png');
    await form.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(running.getByRole('status')).toContainText('Started db');
    await expect(form).toHaveCount(0);
    const services = running.getByRole('list', { name: 'Services' });
    const dbRow = services.getByRole('listitem').filter({ hasText: 'db' });
    await expect(dbRow).toHaveCount(1);
    await expect(dbRow.getByText('Running')).toBeVisible();
    await expect(dbRow.getByText('docker.io/library/postgres:16')).toBeVisible();
    await expect(dbRow.getByText(/At 172\.20\.0\.\d+ on port 5432/)).toBeVisible();
    await expect(dbRow.getByText(/SERVICE_DB_HOST, SERVICE_DB_PORT, DATABASE_URL/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: /^Services/ })).toContainText(
      '1 running'
    );
    await expectNoHorizontalOverflow(page);
    await shot('code-services-running.png');

    // ── A refusal names what is allowed: a second service from an image
    //    outside the rules, under another name ──
    await running.getByRole('button', { name: 'Start a service' }).click();
    await form.getByLabel('Name', { exact: true }).fill('cache');
    await form.getByLabel('Image', { exact: true }).fill('bitnami/redis:7');
    await form.getByLabel(/^Container variables/).fill('');
    await form.getByLabel(/^Exports/).fill('');
    await form.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(main.getByRole('alert').filter({ hasText: /./ })).toContainText(
      'not an image this organization allows'
    );
    await running.getByRole('button', { name: 'Cancel' }).click();

    // ── The combined tail: the service's lines, named and stamped, and
    //    while Follow is on a line written later arrives on its own ──
    const logsCard = main.getByRole('region', { name: 'Logs' });
    const tail = logsCard.getByLabel('Combined logs');
    await expect(logsCard.getByLabel('Follow')).toBeChecked();
    await expect(tail).toContainText('db');
    await expect(tail).toContainText('database system is ready to accept connections');
    await expect(tail).toContainText('checkpoint 1', { timeout: 15_000 });
    await shot('code-services-logs.png');
    // Filtered to one service, its name drops out of every line; paused, nothing new comes.
    await logsCard.getByLabel('Show logs of').selectOption('db');
    await expect(tail).toContainText('ready to accept');
    await logsCard.getByLabel('Follow').uncheck();
    await logsCard.getByRole('button', { name: 'Clear' }).click();
    await expect(tail).toContainText('(nothing from db yet)');
    await logsCard.getByLabel('Show logs of').selectOption('');
    await logsCard.getByLabel('Follow').check();
    await expect(tail).toContainText('checkpoint', { timeout: 15_000 });

    // ── Back on the project page, the card reflects it ──
    await main.getByRole('link', { name: ids.name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible();
    await expect(card.getByText('1 running')).toBeVisible();
    await expect(card.getByText(/^db · \d+ allowed images/)).toBeVisible();

    // ── Phone width: the page again, the service still a card; stop it ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(pagePath);
    await expect(page.getByRole('heading', { level: 1, name: /^Services/ })).toBeVisible();
    await expect(dbRow.getByText('Running')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-services-mobile.png');
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Stop db?');
      void dialog.accept();
    });
    await dbRow.getByRole('button', { name: 'Stop' }).click();
    await expect(running.getByText(/^No services\./)).toBeVisible();
    await expect(tail).toContainText('(no services)');
    await expect(page.getByRole('heading', { level: 1, name: /^Services/ })).toContainText(
      'None running'
    );
  });
});
