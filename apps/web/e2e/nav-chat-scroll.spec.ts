/**
 * The app menu column: the version stays pinned to its foot and only the
 * chat list scrolls. The menu's sections above it do not move with the list.
 *
 * Whether the list actually overflows depends on how many chats the seed
 * holds, so the scroll itself is exercised only when it can overflow; the
 * layout that must hold either way is asserted unconditionally.
 */

import path from 'node:path';
import { test, expect } from '@playwright/test';
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
