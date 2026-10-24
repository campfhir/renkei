/**
 * The app menu column: the version stays pinned to its foot and only the
 * chat list scrolls. The menu's sections above it do not move with the list.
 *
 * Whether the list actually overflows depends on how many chats the seed
 * holds, so the scroll itself is exercised only when it can overflow; the
 * layout that must hold either way is asserted unconditionally.
 */

import path from 'node:path';
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

test('app menu: version is pinned to the foot and the chat list scrolls on its own', async ({
  page,
}, testInfo) => {
  // A standard desktop window. Below this height the menu sections and the
  // list's minimum no longer fit, and the column scrolls as a fallback.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/agents`);

  const column = page.getByRole('navigation', { name: 'Application' });
  const chats = column.getByRole('navigation', { name: 'Chats' });
  const version = column.locator(':scope > p').last();
  await expect(chats).toBeVisible();
  await expect(version).toBeVisible();

  // The chat list is its own scroll box; the column above it is not.
  await expect(chats).toHaveCSS('overflow-y', 'auto');
  const overflowing = await chats.evaluate((el) => el.scrollHeight > el.clientHeight + 1);

  const footerBox = await version.boundingBox();
  const columnBox = await column.boundingBox();
  expect(footerBox && columnBox).toBeTruthy();
  // Pinned: the version sits at the foot of the column, inside its padding.
  expect(footerBox!.y + footerBox!.height).toBeGreaterThan(columnBox!.y + columnBox!.height - 40);
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(
    columnBox!.y + columnBox!.height + 1
  );

  // The menu's own sections never scroll with the chat list.
  const workspace = column.getByRole('link', { name: 'Home', exact: true });
  const workspaceBefore = await workspace.boundingBox();

  if (overflowing) {
    await chats.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => chats.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  }

  const footerAfter = await version.boundingBox();
  const workspaceAfter = await workspace.boundingBox();
  expect(footerAfter!.y).toBeCloseTo(footerBox!.y, 0);
  expect(workspaceAfter!.y).toBeCloseTo(workspaceBefore!.y, 0);

  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      'nav-chat-scroll.png'
    ),
  });
});

test('app menu: three chats show at a desktop height without scrolling the list', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop column check.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Titles carry the project name: the projects run in parallel against one database.
  const prefix = `Menu height e2e ${testInfo.project.name}`;
  try {
    await client.query('DELETE FROM chats WHERE owner_subject = $1 AND title LIKE $2', [
      E2E_SUBJECT,
      `${prefix} %`,
    ]);
    for (let index = 1; index <= 5; index += 1) {
      await client.query(
        'INSERT INTO chats (id, owner_subject, title, last_message_at) VALUES ($1, $2, $3, NOW())',
        [randomUUID(), E2E_SUBJECT, `${prefix} ${index}`]
      );
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/agents`);
    const chats = page
      .getByRole('navigation', { name: 'Application' })
      .getByRole('navigation', { name: 'Chats' });
    const rows = chats.getByRole('link', { name: new RegExp(`^${prefix} \\d`) });
    await expect(rows).toHaveCount(5);

    // Each row whose top and bottom both sit inside the list's visible box.
    const visible = await rows.evaluateAll(
      (links, list) => {
        const box = list.getBoundingClientRect();
        return links.filter((link) => {
          const row = link.getBoundingClientRect();
          return row.top >= box.top && row.bottom <= box.bottom;
        }).length;
      },
      await chats.elementHandle()
    );
    expect(visible).toBeGreaterThanOrEqual(3);
  } finally {
    await client.query('DELETE FROM chats WHERE owner_subject = $1 AND title LIKE $2', [
      E2E_SUBJECT,
      `${prefix} %`,
    ]);
    await client.end();
  }
});

test('app menu: the column never scrolls, only the chat list does, on desktop and in the phone drawer', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A layout check at two widths.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const prefix = 'Menu scroll e2e';
  try {
    await client.query('DELETE FROM chats WHERE owner_subject = $1 AND title LIKE $2', [
      E2E_SUBJECT,
      `${prefix} %`,
    ]);
    // More chats than the menu holds, so the list has to scroll.
    for (let index = 1; index <= 14; index += 1) {
      await client.query(
        "INSERT INTO chats (id, owner_subject, title, last_message_at) VALUES ($1, $2, $3, NOW() - ($4 || ' minutes')::interval)",
        [randomUUID(), E2E_SUBJECT, `${prefix} ${index}`, index]
      );
    }

    // The phone drawer, a laptop, and a desktop: the menu never scrolls at any of them.
    for (const size of [
      { width: 390, height: 844 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await page.goto('/agents');
      if (size.width < 1024) await page.getByRole('button', { name: 'Open menu' }).click();
      const column = page.locator('nav[aria-label="Application"]:visible').first();
      const chats = column.getByRole('navigation', { name: 'Chats' });
      await expect(chats).toBeVisible();
      await expect(column.getByRole('link', { name: `${prefix} 1`, exact: true })).toBeAttached();

      const layout = await column.evaluate((element) => {
        const list = element.querySelector('nav[aria-label="Chats"]') as HTMLElement;
        const footer = [...element.querySelectorAll(':scope > p')].pop() as HTMLElement;
        return {
          columnScrolls: element.scrollHeight > element.clientHeight + 1,
          listScrolls: list.scrollHeight > list.clientHeight + 1,
          footerInside:
            footer.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1,
        };
      });
      expect(layout, `menu at ${size.width}px`).toEqual({
        columnScrolls: false,
        listScrolls: true,
        footerInside: true,
      });
      // The list always has room for four chats at once.
      const fourShown = await chats.evaluate((list) => {
        const box = list.getBoundingClientRect();
        return [...list.querySelectorAll('a')].filter((link) => {
          const row = link.getBoundingClientRect();
          return row.top >= box.top && row.bottom <= box.bottom;
        }).length;
      });
      expect(fourShown, `chats shown at ${size.width}px`).toBeGreaterThanOrEqual(4);
    }
  } finally {
    await client.query('DELETE FROM chats WHERE owner_subject = $1 AND title LIKE $2', [
      E2E_SUBJECT,
      `${prefix} %`,
    ]);
    await client.end();
  }
});
