/**
 * A sidebar chat row's "⋯" menu opens above its row when there is no room
 * below it. The sidebar is pinned to the bottom of the window, so a menu
 * that opened downward past that edge only grew the sidebar's scroll area
 * instead of showing. The window is made just tall enough for the row's
 * button, so the menu has to flip.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

// Enough rows that the column scrolls, so one can be brought into view at its end.
const ROWS = 14;

test('a row menu opens above its row when there is no room below', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'The pinned sidebar column is a desktop layout; the phone drawer is covered elsewhere.'
  );
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Titles carry the project name: the projects run in parallel against one database.
  const prefix = `Menu flip e2e ${testInfo.project.name}`;
  const titles = Array.from(
    { length: ROWS },
    (_, index) => `${prefix} ${String(index + 1).padStart(2, '0')}`
  );
  const target = titles[ROWS - 1];
  try {
    await client.query('DELETE FROM chats WHERE owner_subject = $1 AND title LIKE $2', [
      E2E_SUBJECT,
      `${prefix} %`,
    ]);
    for (const title of titles) {
      await client.query(
        'INSERT INTO chats (id, owner_subject, title, last_message_at) VALUES ($1, $2, $3, NOW())',
        [randomUUID(), E2E_SUBJECT, title]
      );
    }

    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto('/chat');
    const list = page.getByRole('navigation', { name: 'Chats' });
    const row = list.getByRole('link', { name: new RegExp(`^${target}`) });
    await expect(row).toBeAttached();
    await row.evaluate((element) => element.scrollIntoView({ block: 'end' }));

    const actions = row.locator('..').getByRole('button', { name: 'Chat actions' });
    await row.hover();
    // Shrink the window to a few pixels below the row's button: the menu
    // needs far more room than that, so it has to open above the row.
    const button = await actions.boundingBox();
    expect(button).toBeTruthy();
    await page.setViewportSize({
      width: 1280,
      height: Math.ceil(button!.y + button!.height) + 40,
    });

    // The click can land before the page has hydrated and attached its
    // handlers, so it is retried until the menu is open.
    const rename = page.getByRole('button', { name: 'Rename', exact: true });
    await expect(async () => {
      await actions.click();
      await expect(rename).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    const panel = rename.locator('..');

    const viewport = page.viewportSize();
    const menu = await panel.boundingBox();
    const trigger = await actions.boundingBox();
    expect(menu && trigger && viewport).toBeTruthy();
    // Inside the window, and wholly above the button that opened it.
    expect(menu!.y).toBeGreaterThanOrEqual(0);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(viewport!.height);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(trigger!.y);

    await testInfo.attach('menu-flipped-above-row', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // The menu still works from its flipped place: Rename opens its dialog.
    await rename.click();
    await expect(page.getByRole('dialog', { name: 'Rename chat' })).toBeVisible();
  } finally {
    await client.query('DELETE FROM chats WHERE owner_subject = $1 AND title LIKE $2', [
      E2E_SUBJECT,
      `${prefix} %`,
    ]);
    await client.end();
  }
});
