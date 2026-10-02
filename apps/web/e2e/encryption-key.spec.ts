/**
 * Bring your own key, end to end in a browser (docs/user-encryption-keys-design.md,
 * "Your own key"): a person on the managed key switches to a passphrase of
 * their own, locks it, sees their chat refuse to open, unlocks it (a wrong
 * passphrase first), and goes back to the managed key — with the chat
 * readable at every unlocked step, which is the proof the rewrap carried
 * its key across each change.
 *
 * Real routes against the real dev database: the whole point is that the
 * key derivation, the rewrap and the strict readers agree with each other,
 * and a mock on any of them would answer nothing.
 *
 * Its own tenant per Playwright project (the way llm-models.spec.ts does
 * it): this spec changes the person's key, and a shared tenant would have
 * every other spec's seeded rows flipping between keys underneath them.
 *
 * Pinned Chromium only; "mobile" is a resized viewport, not the `mobile`
 * project — see AGENTS.md's "UI changes" section.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { keyFor, secretbox } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const PASSPHRASE = 'correct horse battery staple';
const PROMPT_TEXT = 'Which issues slipped out of the last OPS sprint?';
const REPLY_TEXT = 'Two issues slipped: OPS-41 and OPS-44.';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** A deterministic (stable across reruns), valid-looking v4 UUID from a seed string. */
function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

interface Fixture {
  tenantId: string;
  sessionId: string;
  slug: string;
  subject: string;
  chatId: string;
  turnId: string;
  modelId: string;
}

function fixtureFor(projectName: string): Fixture {
  return {
    tenantId: uuidFrom(`encryption-key-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`encryption-key-e2e-session:${projectName}`),
    slug: `e2e-encryption-key-${projectName}`,
    subject: `e2e-encryption-key-${projectName}@example.com`,
    chatId: uuidFrom(`encryption-key-e2e-chat:${projectName}`),
    turnId: uuidFrom(`encryption-key-e2e-turn:${projectName}`),
    modelId: uuidFrom(`encryption-key-e2e-model:${projectName}`),
  };
}

/** `llm_model_configs.encrypted_secrets` is a bare secretbox under TOKEN_ENCRYPTION_KEY. */
function sealSecret(plaintext: string): string {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.byteLength !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes for this spec to seed rows.');
  }
  return secretbox(plaintext, key);
}

/**
 * A tenant, a signed-in person on the managed key, and one chat of theirs
 * with two sealed messages — the thing that has to survive every key
 * change below.
 */
async function seed(fixture: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM chats WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM resource_keys WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM user_encryption_keys WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM llm_model_configs WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM user_preferences WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM sessions WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM identities WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [fixture.tenantId]);
    await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [
      fixture.tenantId,
      fixture.slug,
    ]);
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        fixture.sessionId,
        fixture.tenantId,
        fixture.subject,
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name)
       VALUES ($1, $2, $3, $4)`,
      [fixture.tenantId, fixture.subject, fixture.subject, 'E2E Tester']
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    await client.query(
      `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, enabled, is_default)
       VALUES ($1, $2, 'E2E model', 'anthropic', 'e2e-model', $3, true, true)`,
      [fixture.modelId, fixture.tenantId, sealSecret(JSON.stringify({ apiKey: 'e2e' }))]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
       VALUES ($1, $2, $3, 'Sprint slippage', $4, NOW())`,
      [fixture.chatId, fixture.tenantId, fixture.subject, fixture.modelId]
    );
    const chatKey = await keyFor(client, {
      tenantId: fixture.tenantId,
      kind: 'chat',
      resourceId: fixture.chatId,
      ownerSubject: fixture.subject,
    });
    await client.query(
      `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, input_tokens, output_tokens, finished_at)
       VALUES ($1, $2, $3, 'completed', $4, 1, 120, 34, NOW())`,
      [fixture.turnId, fixture.tenantId, fixture.chatId, fixture.modelId]
    );
    const rows = [
      { seq: 0, role: 'user', kind: 'prompt', text: PROMPT_TEXT },
      { seq: 1, role: 'assistant', kind: 'assistant', text: REPLY_TEXT },
    ];
    for (const row of rows) {
      const assistant = row.role === 'assistant';
      await client.query(
        `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, stop_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10, $11)`,
        [
          fixture.tenantId,
          fixture.chatId,
          fixture.turnId,
          row.seq,
          row.role,
          row.kind,
          chatKey.seal(JSON.stringify([{ type: 'text', text: row.text }])),
          assistant ? fixture.modelId : null,
          assistant ? 'anthropic' : null,
          assistant ? 'e2e-model' : null,
          assistant ? 'end_turn' : null,
        ]
      );
    }
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session_${fixture.tenantId}`,
      value: fixture.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

async function expectChatReadable(page: Page, fixture: Fixture): Promise<void> {
  await page.goto(`/${fixture.slug}/chat/${fixture.chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sprint slippage' })).toBeVisible();
  await expect(page.getByText(PROMPT_TEXT)).toBeVisible();
  await expect(page.getByText(REPLY_TEXT)).toBeVisible();
  await expect(page.getByTestId('chat-key-locked-notice')).toHaveCount(0);
}

test('own key: adopt, lock, unlock, revert — the chat follows the key', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  await signIn(page, fixture);

  // Before anything: readable on the managed key.
  await expectChatReadable(page, fixture);

  await page.goto(`/${fixture.slug}/preferences`);
  const section = page.getByTestId('encryption-key');
  await expect(section.getByRole('heading', { name: 'Encryption key' })).toBeVisible();
  await expect(section.getByTestId('encryption-key-mode')).toHaveText('Managed by Renkei');
  await shot(page, testInfo, 'encryption-key-01-managed');

  // Adopt: the browser-side checks first (short, then mismatched), then
  // the real thing.
  await section.getByRole('button', { name: 'Use my own passphrase' }).click();
  const adopt = section.getByTestId('encryption-key-adopt');
  await adopt.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await adopt.getByLabel('Confirm passphrase').fill(`${PASSPHRASE} no`);
  await adopt.getByRole('button', { name: 'Switch to my own key' }).click();
  await expect(adopt.getByRole('alert')).toHaveText('The two passphrases do not match.');
  await adopt.getByLabel('Confirm passphrase').fill(PASSPHRASE);
  await adopt.getByLabel('Stay unlocked for').selectOption('1');
  await shot(page, testInfo, 'encryption-key-02-adopt-form');
  await adopt.getByRole('button', { name: 'Switch to my own key' }).click();
  await expect(section.getByTestId('encryption-key-mode')).toHaveText('Your own key');
  await expect(section.getByTestId('encryption-key-state')).toContainText('Unlocked until');
  await shot(page, testInfo, 'encryption-key-03-own-unlocked');

  // The chat's key was rewrapped under the new KEK: still readable.
  await expectChatReadable(page, fixture);

  // Lock: the chat page says so instead of showing markers for every row.
  await page.goto(`/${fixture.slug}/preferences`);
  await section.getByRole('button', { name: 'Lock now' }).click();
  await expect(section.getByTestId('encryption-key-state')).toHaveText('Locked');
  await expect(
    section.getByRole('status').filter({ hasText: 'While your key is locked' })
  ).toBeVisible();
  await shot(page, testInfo, 'encryption-key-04-locked');

  await page.goto(`/${fixture.slug}/chat/${fixture.chatId}`);
  const locked = page.getByTestId('chat-key-locked-notice');
  await expect(locked).toBeVisible();
  await expect(page.getByText(PROMPT_TEXT)).toHaveCount(0);
  await expect(page.getByText(REPLY_TEXT)).toHaveCount(0);
  await shot(page, testInfo, 'encryption-key-05-chat-locked');
  await locked.getByRole('link', { name: 'Unlock in Preferences' }).click();
  await expect(page).toHaveURL(new RegExp(`/${fixture.slug}/preferences$`));

  // Unlock: a wrong passphrase is refused in so many words; the right one
  // opens the window again.
  await section.getByRole('button', { name: 'Unlock', exact: true }).click();
  const unlock = section.getByTestId('encryption-key-unlock');
  await unlock.getByLabel('Passphrase', { exact: true }).fill('not the passphrase at all');
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(unlock.getByRole('alert')).toHaveText('That is not your passphrase.');
  await expect(section.getByTestId('encryption-key-state')).toHaveText('Locked');
  await unlock.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(section.getByTestId('encryption-key-state')).toContainText('Unlocked until');

  await expectChatReadable(page, fixture);

  // Revert: back under a key Renkei derives, and the chat still opens.
  await page.goto(`/${fixture.slug}/preferences`);
  await section.getByRole('button', { name: 'Go back to the managed key' }).click();
  const revert = section.getByTestId('encryption-key-revert');
  await revert.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await revert.getByRole('button', { name: 'Go back to the managed key' }).click();
  await expect(section.getByTestId('encryption-key-mode')).toHaveText('Managed by Renkei');
  await expect(section.getByTestId('encryption-key-state')).toHaveCount(0);
  await shot(page, testInfo, 'encryption-key-06-reverted');

  await expectChatReadable(page, fixture);
});

test('own key: the section and the locked notice at phone width', async ({ page }, testInfo) => {
  const fixture = fixtureFor(`${testInfo.project.name}-mobile`);
  await seed(fixture);
  await signIn(page, fixture);
  await page.setViewportSize(MOBILE_VIEWPORT);

  await page.goto(`/${fixture.slug}/preferences`);
  const section = page.getByTestId('encryption-key');
  await section.getByRole('button', { name: 'Use my own passphrase' }).click();
  const adopt = section.getByTestId('encryption-key-adopt');
  await adopt.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await adopt.getByLabel('Confirm passphrase').fill(PASSPHRASE);
  await shot(page, testInfo, 'encryption-key-mobile-01-adopt-form');
  await adopt.getByRole('button', { name: 'Switch to my own key' }).click();
  await expect(section.getByTestId('encryption-key-mode')).toHaveText('Your own key');
  await section.getByRole('button', { name: 'Lock now' }).click();
  await expect(section.getByTestId('encryption-key-state')).toHaveText('Locked');
  // Nothing in the section runs past the phone's edge.
  const box = await section.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'encryption-key-mobile-02-locked');

  await page.goto(`/${fixture.slug}/chat/${fixture.chatId}`);
  await expect(page.getByTestId('chat-key-locked-notice')).toBeVisible();
  await shot(page, testInfo, 'encryption-key-mobile-03-chat-locked');
});
