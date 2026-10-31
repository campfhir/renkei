/**
 * The notifications page on the in-memory data store: the feed in order,
 * the unread total, "Mark all as read" and a per-card "Mark as unread"
 * going through the real route to the store and surviving a reload, and
 * the empty state for somebody with nothing yet.
 *
 * The notifications are the app's own: a colleague shares agents with the
 * person through each agent's access route (e2e/support/share-agents.ts),
 * and one is marked read through the feed's route, as its menu does.
 */

import path from 'node:path';
import { test, expect } from './fixtures';
import { createPerson } from './support/person';
import { shareAgentsWith } from './support/share-agents';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

test('the feed, newest first, marked read and unread again', async ({
  page,
  request,
  person,
}, testInfo) => {
  const [oldest, middle, newest] = await shareAgentsWith(request, person, [
    'Oldest: triage',
    'Middle: reply drafts',
    'Newest: duplicates',
  ]);
  const markedRead = await page.request.post('/api/notifications', {
    data: { ids: [oldest.notificationId] },
  });
  expect(markedRead.ok()).toBe(true);

  await page.goto('/notifications');
  // A reload can leave a streamed copy of the count in the page for a
  // moment, hidden (AGENTS.md, "Pitfalls"): only the one shown counts.
  const unread = (text: string) => page.getByText(text, { exact: true }).filter({ visible: true });
  const headlines = page.getByText(/shared the agent "(Oldest|Middle|Newest):/);
  await expect(headlines).toHaveText([newest.headline, middle.headline, oldest.headline]);
  await expect(unread('2 unread')).toBeVisible();
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, 'notifications-01-feed.png'),
    fullPage: true,
  });

  // On a cold dev server the first click can land before hydration; retry
  // until the request has gone through — and the route, compiling on its
  // first hit, answered it (the button hides on any answer).
  await expect(async () => {
    const button = page.getByRole('button', { name: 'Mark all as read' });
    if ((await button.count()) === 0) await page.reload();
    const marked = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/notifications') && response.request().method() === 'POST',
      { timeout: 5_000 }
    );
    await button.click({ timeout: 2_000 });
    expect((await marked).ok()).toBe(true);
  }).toPass({ timeout: 30_000 });
  await page.reload();
  await expect(unread('2 unread')).toHaveCount(0);
  await expect(page.getByLabel(/unread notification/)).toHaveCount(0);

  await page.getByRole('button', { name: `Actions for "${middle.headline}"` }).click();
  // The count changes the moment it is pressed (optimistic); the reload
  // waits for the write behind it, or it can read the row from before.
  const unmarked = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/notifications') && response.request().method() === 'POST'
  );
  await page.getByRole('menuitem', { name: 'Mark as unread' }).click();
  await expect(unread('1 unread')).toBeVisible();
  expect((await unmarked).ok()).toBe(true);
  await page.reload();
  await expect(unread('1 unread')).toBeVisible();
});

test('somebody with no notifications sees none, and no one else’s', async ({
  page,
  request,
  person: _person,
}) => {
  // Somebody else gets a notification; this person gets nothing.
  const somebodyElse = await createPerson(request);
  const [{ headline }] = await shareAgentsWith(request, somebodyElse, ['Somebody else’s news']);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await expect(page.getByText(headline)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
});
