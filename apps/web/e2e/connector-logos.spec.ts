/**
 * Connector marks, as the admin connector list shows them: the shipped
 * Salesforce, GitHub and Mirth Connect SVGs, and Renkei's own mark on its
 * built-in surfaces, load as images (not the
 * built-in fallback glyph, which is what a missing or malformed file
 * silently degrades to), and GitHub's near-black mark is inverted on a dark
 * page only (lib/connector-logos.ts, INVERT_ON_DARK). And on the person's
 * own Connectors page, every card's heading carries a mark that loads —
 * the page where a missing icon was noticed. Which cards render depends on
 * the org's setup; every one that does is checked.
 *
 * Read-only, but signed in as its own operator so it does not depend on the
 * shared seed's roles; nothing organization-wide is written.
 *
 * Runs on the pinned Chromium only; "mobile" is a resized viewport, per AGENTS.md.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

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

async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Its own operator, with every connector added to their Connectors page. */
async function signIn(page: Page, projectName: string): Promise<void> {
  const sessionId = uuidFrom(`connector-logos-e2e-session:${projectName}`);
  const subject = `e2e-logos-${projectName}@example.com`;
  await withDb(async (client) => {
    for (const table of ['user_preferences', 'sessions', 'identities']) {
      await client.query(`DELETE FROM ${table} WHERE subject = $1`, [subject]);
    }
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [sessionId, subject, ['renkei-user', 'renkei-operator'], new Date(Date.now() + 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, 'E2E Tester')`,
      [subject, subject]
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value) VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [subject]
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value) VALUES ($1, 'connectors', $2::jsonb)`,
      [subject, JSON.stringify({ added: ADDED })]
    );
    await enrollForE2E(client, subject);
  });
  await page.context().addCookies([
    {
      name: 'renkei_session',
      value: sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

const ADDED = [
  'jira',
  'atlassian-confluence',
  'atlassian-bitbucket',
  'microsoft',
  'entra-developer',
  'github',
  'salesforce',
  'webex',
  'zoom',
  'onbase',
  'onbase-admin',
  'fileshares',
  'mirth',
  'admanager',
];

test('connector marks: shipped SVGs load, and GitHub inverts on dark only', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo.project.name);
  await page.goto('/admin/connectors');
  const dark = testInfo.project.name.includes('dark');
  for (const [name, file] of [
    ['Salesforce', 'salesforce'],
    ['GitHub', 'github'],
    ['Mirth Connect', 'mirth'],
    ['Renkei cards', 'renkei'],
    ['Renkei agents', 'renkei'],
    ['Renkei batch jobs', 'renkei'],
    ['Renkei logs', 'renkei'],
    ['Renkei memory', 'renkei'],
    ['Renkei sandbox', 'renkei'],
  ] as const) {
    const row = page.locator('li').filter({ has: page.getByRole('link', { name, exact: true }) });
    const mark = row.locator(`img[src="/connector-logos/${file}.svg"]`);
    await expect(mark, `${name} shows its shipped mark`).toBeVisible();
    // Decoded as an image, so the file is a valid SVG (a wrong namespace
    // fails here) and the fallback glyph is not what is on screen.
    await expect
      .poll(() => mark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await expect(row.locator('svg[aria-hidden="true"] text')).toHaveCount(0);
    const filter = await mark.evaluate((img) => getComputedStyle(img).filter);
    expect(filter, `${name}'s filter`).toBe(file === 'github' && dark ? 'invert(1)' : 'none');
  }
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, 'connector-logos.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  // Salesforce and Salesforce Admin both wear it.
  await expect(page.locator('img[src="/connector-logos/salesforce.svg"]').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('connectors page: every card heading carries a mark that loads', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo.project.name);
  await page.goto('/connectors');
  const headings = page.locator('[data-coach^="card-"] :is(h2, h3)');
  await expect(headings.first()).toBeVisible();
  const count = await headings.count();
  const seen: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const heading = headings.nth(i);
    if (!(await heading.isVisible())) continue;
    const name = (await heading.innerText()).trim();
    seen.push(name);
    const mark = heading.locator('img, svg').first();
    await expect(mark, `"${name}" has a mark`).toBeVisible();
    if ((await mark.evaluate((el) => el.tagName.toLowerCase())) === 'img') {
      await expect
        .poll(
          () => mark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
          { message: `"${name}"'s mark loads` }
        )
        .toBe(true);
    }
  }
  // Browser secrets had no mark; the org-configured cards that had none
  // (Mirth Connect, File shares, ADManager Plus) render only where the org
  // runs those servers, and are guarded by app/(app)/connectors/card-marks.test.ts.
  expect(seen.some((heading) => heading.includes('Browser secrets'))).toBe(true);
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, 'connectors-page-marks.png'),
    fullPage: true,
  });
});
