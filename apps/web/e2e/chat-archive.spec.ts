/**
 * The "Archive old chats" preference on the preferences page, end to end in
 * a browser: the default (never), saving a window, the refusal of a window
 * longer than the organization keeps chats, and clearing it back to never.
 *
 * The refusal is the part worth watching in a browser: the field stops an
 * over-long number before it leaves the page, and the server refuses the
 * same thing on its own, so both are asserted. The sweep that archives
 * chats runs in the worker, not here; this spec covers what a person sets.
 *
 * Each Playwright project gets its own person, derived from the project
 * name, because this spec writes its own preference row and projects run
 * concurrently against the same dev Postgres (AGENTS.md's isolation rule).
 * The organization's chat retention is shared by every spec in a run, so
 * this spec reads it rather than assuming its default.
 *
 * Runs on the pinned Chromium only, with a resized viewport for the phone
 * check (see llm-models.spec.ts for the convention this follows).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

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

function fixtureFor(projectName: string): {
  sessionId: string;
  subject: string;
} {
  return {
    sessionId: uuidFrom(`chat-archive-e2e-session:${projectName}`),
    subject: `e2e-chat-archive-${projectName}@example.com`,
  };
}

async function seedPerson(fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM user_preferences WHERE subject = $1 AND key = $2', [
      fixture.subject,
      'chat_archive',
    ]);
    await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM identities WHERE subject = $1', [fixture.subject]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [
        fixture.sessionId,
        fixture.subject,
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name)
       VALUES ($1, $2, $3)`,
      [fixture.subject, fixture.subject, 'E2E Tester']
    );
    // No coach marks tour stealing focus mid-screenshot.
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)
       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)
       ON CONFLICT (subject, key) DO UPDATE SET value = EXCLUDED.value`,
      [fixture.subject]
    );
    await enrollForE2E(client, fixture.subject);
  } finally {
    await client.end();
  }
}

/** The organization's chat retention in days, as the server reads it (0 = keep everything). */
async function orgRetentionDays(): Promise<number> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT value FROM settings WHERE key = 'chat_retention_days'`
    );
    const stored = result.rows[0]?.value;
    return stored === undefined ? 365 : Number(stored);
  } finally {
    await client.end();
  }
}

async function storedArchiveDays(subject: string): Promise<unknown> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT value FROM user_preferences WHERE subject = $1 AND key = 'chat_archive'`,
      [subject]
    );
    return result.rows[0]?.value?.afterDays ?? null;
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session`,
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

test('preferences: archive old chats after a chosen number of days, never longer than the org keeps them', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedPerson(fixture);
  await signIn(page, fixture);
  const retention = await orgRetentionDays();

  await page.goto(`/preferences`);
  const section = page.getByRole('region', { name: 'Archive old chats' });
  await expect(section).toBeVisible();

  // The default: never. An empty field, and nothing to save yet.
  const days = section.getByLabel('Archive chats after (days)');
  await expect(days).toHaveValue('');
  await expect(days).toHaveAttribute('placeholder', 'Never');
  await expect(section.getByRole('button', { name: 'Save' })).toBeDisabled();
  await shot(page, testInfo, 'chat-archive-01-default');

  // A window the org allows saves, survives a reload, and is what is stored.
  await days.fill('30');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(section.getByLabel('Archive chats after (days)')).toHaveValue('30');
  expect(await storedArchiveDays(fixture.subject)).toBe(30);
  await shot(page, testInfo, 'chat-archive-02-saved');

  // Longer than the organization keeps chats: refused in the field, and the
  // server refuses it too, so a stale page cannot save it around the check.
  const tooLong = retention > 0 ? retention + 1 : 3_651;
  if (retention > 0) {
    await section.getByLabel('Archive chats after (days)').fill(String(tooLong));
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByText(`Enter ${retention} days or fewer.`)).toBeVisible();
    await shot(page, testInfo, 'chat-archive-03-refused');
  }
  const refused = await page.request.put('/api/preferences', {
    data: { chatArchive: { afterDays: tooLong } },
  });
  expect(refused.status()).toBe(400);
  expect(await storedArchiveDays(fixture.subject)).toBe(30);

  // Clearing the field goes back to never.
  await section.getByLabel('Archive chats after (days)').fill('');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();
  expect(await storedArchiveDays(fixture.subject)).toBeNull();

  // Phone width: the field and its note still fit and stay usable.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.reload();
  await expect(section.getByLabel('Archive chats after (days)')).toBeVisible();
  await shot(page, testInfo, 'chat-archive-04-mobile');
});
