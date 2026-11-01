/**
 * The notification surfaces: what only a browser shows.
 *
 * Both the feed row and the toast are made clickable by a stretched
 * `after:inset-0` pseudo-element, and a later change to either card's
 * positioning (dropping a `relative`, wrapping the body in a new div)
 * stops the click landing without changing how the page looks at all.
 * `elementFromPoint` at a corner of the card is the only check that
 * actually notices. The "Show more" pill waits for the person to scroll
 * to the end of the list (an IntersectionObserver), and one press of it
 * goes end to end: the older page fetched from the real route and drawn.
 *
 * Its rules moved out of the browser: the unread banner, "Mark all as
 * read" reaching rows past the page, what "Show more" asks for and when it
 * retires, select and delete, and the row menu's items are
 * app/(app)/notifications/notifications-list.model.test.ts; the paging
 * cursor, mark-all past the page and a delete sticking are
 * app/api/notifications/route.test.ts; the preferences' acts per connector
 * are app/(app)/preferences/preferences-form.model.test.ts.
 *
 * The notifications are the app's own: a colleague shares agents with the
 * person through each agent's access route (e2e/support/share-agents.ts),
 * and each share is an "… shared the agent … with you" row that opens the
 * agent in the app.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { createPerson } from './support/person';
import { shareAgentsWith } from './support/share-agents';
import { painted } from './support/settle';

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = true): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
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

test('notifications — show more waits for the end of the list, then loads the rest', async ({
  page,
  request,
  person,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A hundred shares: one project is enough.');
  test.setTimeout(300_000);
  // One more than the page's PAGE_SIZE (100). Shared oldest first, so
  // "Notification 000" is the newest and 100 falls past the page.
  const names = Array.from(
    { length: 101 },
    (_, index) => `Notification ${String(100 - index).padStart(3, '0')}`
  );
  await shareAgentsWith(request, person, names);
  const row = (n: number) =>
    page.getByText(new RegExp(`"Notification ${String(n).padStart(3, '0')} `));

  await page.goto(`/notifications`);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
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

  const fetched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/notifications' &&
      new URL(response.url()).searchParams.has('before')
  );
  await showMore.click();
  expect((await fetched).ok()).toBe(true);
  await expect(row(100)).toBeVisible();
  await expect(showMore).toHaveCount(0);
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

  // The menu opens over the row, and Escape closes it (its items are the model's).
  await menuButton.click();
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  await shot(page, testInfo, 'review-notifications-menu', false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);

  await shot(page, testInfo, 'review-notifications');
});

test('toast — the card opens its link, the dismiss still dismisses', async ({
  page,
  request,
  person,
}) => {
  test.setTimeout(90_000);
  // The centre seeds its cursor from the FIRST poll, so a row written
  // before that one lands is backlog and deliberately never toasts.
  const firstPoll = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/notifications'
  );
  await page.goto(`/agents`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await firstPoll;
  await painted(page);

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

  // The next poll is 20 seconds out; coming back to the tab polls at once,
  // which is what a person who switched away to share it would do.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
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
