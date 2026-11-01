/**
 * The notifications page on the in-memory data store: the feed renders on
 * the real server, and one press goes end to end — "Mark all as read" in,
 * the POST through the real route to the store, and a reload that shows
 * it stuck.
 *
 * Its rules moved out of the browser: what the feed shows and each press
 * sends (the unread count, mark read and unread, select and delete, the
 * empty feed) are app/(app)/notifications/notifications-list.model.test.ts;
 * the feed newest first and somebody else's rows never shown are
 * app/api/notifications/route.test.ts.
 *
 * The notifications are the app's own: a colleague shares agents with the
 * person through each agent's access route (e2e/support/share-agents.ts),
 * and one is marked read through the feed's route, as its menu does.
 */

import path from 'node:path';
import { test, expect } from './fixtures';
import { hydrated } from './support/settle';
import { shareAgentsWith } from './support/share-agents';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

test('the feed renders, and Mark all as read sticks', async ({
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

  // Pressed once the list has hydrated (a press on the server's HTML does
  // nothing), and the reload waits for the write behind it.
  await hydrated(page, 'notifications');
  const marked = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/notifications') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  expect((await marked).ok()).toBe(true);
  await page.reload();
  await expect(unread('2 unread')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
});
