/**
 * The notification surfaces, and the canvas mark.
 *
 * Unlike screenshots.spec.ts these carry real assertions, because the thing
 * they cover fails SILENTLY: both the feed row and the toast are made
 * clickable by a stretched `after:inset-0` pseudo-element, and a later
 * change to either card's positioning (dropping a `relative`, wrapping the
 * body in a new div) stops the click landing without changing how the page
 * looks at all. `elementFromPoint` at a corner of the card is the only
 * check that actually notices.
 *
 * The notifications are the app's own: a colleague shares agents with the
 * person through each agent's access route (e2e/support/share-agents.ts),
 * and each share is an "… shared the agent … with you" row that opens the
 * agent in the app. (The rows an agent run's acts leave — a Jira issue
 * linked out in a new tab, "Show run" — only a run acting on a vendor
 * writes, so the stretched link is checked on the in-app kind here.)
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { createPerson } from '../support/person';
import { shareAgentsWith } from '../support/share-agents';

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = true): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
    fullPage,
  });
}

/** The shares' agent names: what each row's headline carries. */
const NAMES = ['Triage yesterday into tickets', 'Q3 invoice follow-up', 'Vendor sync'];

test('notifications — mark all as read reaches rows past the page, show more loads them', async ({
  page,
  request,
  person,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A hundred shares: one project is enough.');
  test.setTimeout(300_000);
  // More than PAGE_SIZE (100) unread rows — the case the render cap used to
  // make unreachable. Shared oldest first, so "Notification 000" is the
  // newest and 100-104 fall past the page and only appear after "Show more".
  const names = Array.from(
    { length: 105 },
    (_, index) => `Notification ${String(104 - index).padStart(3, '0')}`
  );
  await shareAgentsWith(request, person, names);
  const row = (n: number) =>
    page.getByText(new RegExp(`"Notification ${String(n).padStart(3, "0")} `));

  await page.goto(`/notifications`);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

  // The banner reports the TRUE total, not just what rendered.
  await expect(page.getByText('105 unread (some not shown below)')).toBeVisible();
  const markAllRead = page.getByRole('button', { name: 'Mark all as read' });
  await expect(markAllRead).toBeVisible();

  // Only the newest 100 are on the page; the oldest 5 need "Show more".
  await expect(row(99)).toBeVisible();
  await expect(row(100)).toHaveCount(0);

  // The pill stays out of the way until the person actually scrolls to the
  // end of the loaded list — it must not be sitting over content unscrolled.
  const showMore = page.getByRole('button', { name: 'Show more' });
  await expect(showMore).toHaveCount(0);
  await row(99).scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 400);
  await expect(showMore).toBeVisible();
  await shot(page, testInfo, 'review-notifications-show-more-and-mark-all', false);

  await showMore.click();
  await expect(row(104)).toBeVisible();
  // Exactly 105 rows: one "Show more" click exhausts the remaining 5, so
  // the button retires rather than offering another empty page.
  await expect(showMore).toHaveCount(0);

  // "Mark all as read" reaches every row, including the 5 that only just
  // loaded and the ones that never did — a single `{ all: true }` call,
  // not one per visible row.
  await markAllRead.click();
  await expect(markAllRead).toHaveCount(0);
  await expect(page.getByText(/\d+ unread/)).toHaveCount(0);

  // Reload to prove the server actually persisted it beyond the optimistic
  // client state — rows past the render cap that could never be marked
  // read before.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText(/\d+ unread/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
});

test('notifications — the whole row opens the link', async ({
  page,
  request,
  person,
}, testInfo) => {
  const [shared] = await shareAgentsWith(request, person, NAMES);
  await page.goto(`/notifications`);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

  const linked = page.getByRole('link', { name: shared.headline });
  await expect(linked).toHaveAttribute('href', `/agents/${shared.agentId}`);
  // In the app, so the same tab.
  await expect(linked).not.toHaveAttribute('target', '_blank');

  // The stretched pseudo-element must actually cover the row: a click near
  // the row's right edge, far from the text, has to land on the anchor.
  const row = page.locator('li', { hasText: shared.headline }).last();
  const box = await row.boundingBox();
  if (!box) throw new Error('The row is not on screen.');
  const hit = await page.evaluate(
    ([x, y]) => {
      const element = document.elementFromPoint(x, y);
      const anchor = element?.closest('a');
      return anchor instanceof HTMLAnchorElement ? anchor.pathname : (element?.tagName ?? 'none');
    },
    [box.x + box.width - 90, box.y + box.height - 8]
  );
  expect(hit).toBe(`/agents/${shared.agentId}`);

  // Every per-card action lives in the ⋯ menu — no standalone link
  // outside it.
  await expect(row.getByRole('link', { name: 'Run' })).toHaveCount(0);
  const menuButton = row.getByRole('button', { name: /Actions for/ });
  await expect(menuButton).toBeVisible();
  // ...and it has to be reachable through the stretched anchor.
  const menuBox = await menuButton.boundingBox();
  if (!menuBox) throw new Error('The menu button is not on screen.');
  const menuHit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('button') !== null,
    [menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2]
  );
  expect(menuHit).toBe(true);

  await menuButton.click();
  await expect(page.getByRole('menuitem', { name: 'Open agent' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Select' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  await shot(page, testInfo, 'review-notifications-menu', false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);

  await shot(page, testInfo, 'review-notifications');
});

test('notifications — select and delete through the menu', async ({
  page,
  request,
  person,
}, testInfo) => {
  const [first, second, third] = await shareAgentsWith(request, person, NAMES);
  await page.goto(`/notifications`);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

  // "Select" in a card's menu enters selection mode: checkboxes replace
  // the connector icons and the sticky footer appears.
  const row = page.locator('li', { hasText: first.headline }).last();
  await row.getByRole('button', { name: /Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Select' }).click();
  await expect(page.getByRole('checkbox', { name: `Select "${first.headline}"` })).toBeChecked();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('checkbox', { name: `Select "${third.headline}"` }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await shot(page, testInfo, 'review-notifications-selection', false);

  // The footer's Delete opens the confirmation — nothing is deleted yet.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm delete' });
  await expect(dialog.getByText('Delete 2 notifications?')).toBeVisible();
  await shot(page, testInfo, 'review-notifications-confirm', false);

  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  const main = page.getByRole('main');
  await expect(main.getByText(first.headline)).toHaveCount(0);
  await expect(main.getByText(third.headline)).toHaveCount(0);
  await expect(main.getByText(second.headline)).toBeVisible();
  // Selection mode ended with its rows.
  await expect(page.getByText('2 selected')).toHaveCount(0);
  // And the server agrees: a reload shows only the one kept.
  await page.reload();
  await expect(main.getByText(second.headline)).toBeVisible();
  await expect(main.getByText(first.headline)).toHaveCount(0);
});

test('preferences — acts enumerated per connector', async ({
  page,
  person: _person,
}, testInfo) => {
  await page.goto(`/preferences`);
  await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();

  // Each connector's acts are listed under it (its catch-all reads "Anything else in …").
  await shot(page, testInfo, 'review-preferences-collapsed');

  // Everyday Jira, not Jira Administration (which has its own group and sorts alongside).
  const notifications = page.getByRole('region', { name: 'Notifications' });
  const jira = notifications
    .locator('details')
    .filter({ hasText: 'Jira' })
    .filter({ hasNotText: 'Jira Administration' })
    .filter({ hasNotText: 'Jira Service Management' })
    .first();
  await jira.locator('summary').click();
  // A connector's acts are grouped by what they do, each with its own switches.
  await expect(jira.getByText('Creates something')).toBeVisible();
  await expect(jira.getByText('Updates something')).toBeVisible();
  await expect(jira.getByText('Anything else')).toBeVisible();
  await expect(jira.getByRole('checkbox', { name: /Creates something — App$/ })).toBeVisible();
  await shot(page, testInfo, 'review-preferences-jira', false);

  // Outlook is where the user's own list came from — check it reads back.
  // By its summary: an open group's table mentions "Outlook" as a column too.
  const outlook = notifications
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: /^\s*Outlook/ }) })
    .first();
  await outlook.locator('summary').click();
  await expect(outlook.getByText('Sends something')).toBeVisible();
  await expect(outlook.getByRole('checkbox', { name: /Sends something — App$/ })).toBeVisible();
  await shot(page, testInfo, 'review-preferences-outlook', false);
});

test('toast — the card opens its link, the dismiss still dismisses', async ({
  page,
  request,
  person,
}) => {
  test.setTimeout(90_000);
  await page.goto(`/agents`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The centre seeds its cursor from the FIRST poll, so a row written
  // before that one lands is backlog and deliberately never toasts.
  await page.waitForTimeout(2_000);

  // A toast is a link when its row carries one: a colleague sharing a
  // chat does (the chat's own page), through the chat's grants route.
  const sharer = await createPerson(request, { displayName: 'Sam Sharer' });
  const created = await request.post('/api/chat/chats', { headers: sharer.headers, data: {} });
  expect(created.status(), await created.text()).toBe(201);
  const { chatId } = await created.json();
  const title = `Toast: weekly digest ${randomUUID().slice(0, 6)}`;
  const renamed = await request.patch(`/api/chat/chats/${chatId}`, {
    headers: sharer.headers,
    data: { title },
  });
  expect(renamed.ok()).toBe(true);
  const granted = await request.post(`/api/chat/chats/${chatId}/grants`, {
    headers: sharer.headers,
    data: { granteeSubject: person.subject },
  });
  expect(granted.ok(), await granted.text()).toBe(true);

  const toast = page.getByRole('link', { name: `Sam Sharer shared "${title}" with you` });
  await expect(toast).toBeVisible({ timeout: 40_000 });
  await expect(toast).toHaveAttribute('href', `/chat/${chatId}`);

  // The stretched link has to cover the card without swallowing dismiss.
  const card = page.locator('article', { hasText: title });
  const box = await card.boundingBox();
  if (!box) throw new Error('The toast is not on screen.');
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href') ?? 'none',
    [box.x + 20, box.y + box.height - 10]
  );
  expect(hit).toBe(`/chat/${chatId}`);

  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toHaveCount(0);
  expect(page.url()).toContain('/agents');
});
