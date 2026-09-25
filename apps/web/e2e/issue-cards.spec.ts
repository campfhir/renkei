/**
 * Auto-detected issue cards beside the project screen's active chat: a
 * Jira issue and a GitHub issue guessed from that chat's most recent
 * pull request title (lib/code/issue-refs.ts) and fetched live. Mocked
 * with page.route (AGENTS.md: a call that would hit a real vendor —
 * Jira/GitHub here — is mocked at the browser edge) since the lookup
 * runs server-side against …/chats/[chatId]/issues; asserts both cards
 * render on a match, and that the component renders nothing at all
 * (not an error) when the lookup finds neither.
 *
 * Own tenant fixtures under the shared e2e/seed.ts tenant, with a
 * project/chat id distinct from the other Code specs.
 */

import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    projectId: `55555555-5555-4555-8555-5555555555${digit}1`,
    chatId: `55555555-5555-4555-8555-5555555555${digit}2`,
    projectName: `Issue cards project (${digit})`,
    chatTitle: `Fix the retry loop (${digit})`,
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
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'code', 'github', 'acme/site', 'main')`,
      [ids.projectId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectName]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, project_id, title, last_message_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [ids.chatId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectId, ids.chatTitle]
    );
    await client.query('UPDATE chat_projects SET active_chat_id = $1 WHERE id = $2', [
      ids.chatId,
      ids.projectId,
    ]);
  } finally {
    await client.end();
  }
}

async function cleanFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
  } finally {
    await client.end();
  }
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(import.meta.dirname, '..', 'test-results', 'screens', testInfo.project.name, name),
    fullPage: false,
  });
}

test.describe('issue cards', () => {
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await cleanFixtures(idsFor(testInfo.project.name));
  });

  test('renders a Jira card and a GitHub issue card on a match', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const mobile = testInfo.project.name === 'mobile';
    await seedFixtures(ids);
    await page.route(
      `**/api/tenant/**/code/projects/${ids.projectId}/chats/${ids.chatId}/issues`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jira: {
              key: 'PROJ-9',
              title: 'Retry loop spins forever',
              status: 'In Progress',
              url: 'https://acme.atlassian.net/browse/PROJ-9',
            },
            github: {
              number: 41,
              title: 'Retry loop bug',
              state: 'open',
              url: 'https://github.com/acme/site/issues/41',
            },
          }),
        });
      }
    );

    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: /PROJ-9/ })).toBeVisible();
    await expect(main.getByText('In Progress')).toBeVisible();
    await expect(main.getByRole('link', { name: /#41.*open/ })).toBeVisible();
    await shot(page, testInfo, 'issue-cards-both.png');

    if (mobile) {
      await page.setViewportSize(MOBILE_VIEWPORT);
      await expect(main.getByRole('link', { name: /PROJ-9/ })).toBeVisible();
      await shot(page, testInfo, 'issue-cards-mobile.png');
    }
  });

  test('renders nothing when the lookup finds neither — no error shown', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    await seedFixtures(ids);
    await page.route(
      `**/api/tenant/**/code/projects/${ids.projectId}/chats/${ids.chatId}/issues`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jira: null, github: null }),
        });
      }
    );

    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: /PROJ-9/ })).toHaveCount(0);
    await expect(main.getByText(/could not be read|error/i)).toHaveCount(0);
  });

  test('renders nothing on a lookup failure (no token) — hidden, not an error', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    await seedFixtures(ids);
    await page.route(
      `**/api/tenant/**/code/projects/${ids.projectId}/chats/${ids.chatId}/issues`,
      async (route) => {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
    );

    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: /PROJ-9/ })).toHaveCount(0);
    await expect(main.getByText(/could not be read|error/i)).toHaveCount(0);
  });
});
