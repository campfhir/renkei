/**
 * The browser's timezone rides along with every prompt (lib/chat/client.ts)
 * so the model reads "today" in the person's day instead of guessing a zone
 * from an office address. The browser is put in Los Angeles; the send is
 * caught with page.route — no model runs — and answered with a refusal the
 * thread shows, so the test sees both what went out and that the page
 * handled the reply.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
import { lockOrganization, unlockOrganization } from './org-lock';

// The organization's rows are shared by every spec in a run: this one holds the
// lock for its whole file, so the rows are its own while it runs.
test.beforeAll(lockOrganization);
test.afterAll(unlockOrganization);

test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
  timezoneId: 'America/Los_Angeles',
});

/** Per-project ids: the Playwright projects share one database. */
function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `66666666-6666-4666-8666-6666666666${digit}1`,
    modelId: `66666666-6666-4666-8666-6666666666${digit}2`,
    title: `What day is it there? (${digit})`,
    modelLabel: `Timezone model ${digit}`,
  };
}

/** Sealed the way the app seals a model's secrets (chat-permission.spec.ts does the same). */
function sealSecret(plaintext: string): string {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join('.');
}

async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

test.describe('chat timezone', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    await withDb(async (client) => {
      await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
      await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
      // A model, so the composer is enabled; it is never called.
      await client.query(
        `INSERT INTO llm_model_configs (id, label, provider, model, encrypted_secrets, enabled, is_default)
         VALUES ($1, $2, 'anthropic', 'e2e-model', $3, true, false)`,
        [ids.modelId, ids.modelLabel, sealSecret(JSON.stringify({ apiKey: 'e2e' }))]
      );
      await client.query(
        `INSERT INTO chats (id, owner_subject, title, llm_model_id, last_message_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [ids.chatId, E2E_SUBJECT, ids.title, ids.modelId]
      );
    });
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    await withDb(async (client) => {
      await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
      await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
    });
  });

  test("a send carries the browser's timezone", async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const sent: unknown[] = [];
    await page.route(`**/api/chat/chats/${ids.chatId}/turns`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      sent.push(route.request().postDataJSON());
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'e2e', error: 'Held back by the test.' }),
      });
    });

    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { name: ids.title })).toBeVisible({ timeout: 30_000 });
    const composer = page.getByRole('main').getByPlaceholder('Message Renkei');
    await composer.fill('What is my timezone?');
    await composer.press('Enter');

    await expect(page.getByText('Held back by the test.')).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: 'What is my timezone?',
      timeZone: 'America/Los_Angeles',
    });
  });
});
