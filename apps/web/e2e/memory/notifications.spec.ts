/**
 * The notifications page on the in-memory data store: the feed in order,
 * the unread total, "Mark all as read" and a per-card "Mark as unread"
 * going through the real route to the store and surviving a reload, and
 * the empty state for somebody with nothing yet.
 */

import path from 'node:path';
import { test, expect, type MemoryPerson } from './fixtures';
import { forgetSubject } from '../support/store';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');

/** One agent-run notification, as the run's end writes it (notifications.insert). */
async function notify(
  person: MemoryPerson,
  headline: string,
  minutesAgo: number,
  options: { read?: boolean; subject?: string } = {}
): Promise<void> {
  const createdAt = new Date(Date.now() - minutesAgo * 60_000);
  await person.store.notifications.insert({
    id: crypto.randomUUID(),
    subject: options.subject ?? person.subject,
    kind: 'agent_run',
    category: null,
    connector: null,
    tool: null,
    entity: null,
    headline,
    refUrl: null,
    agentId: null,
    agentName: 'Triage',
    runId: null,
    meta: null,
    createdAt,
    readAt: options.read ? createdAt : null,
  });
}

test('the feed, newest first, marked read and unread again', async ({ page, person }, testInfo) => {
  await notify(person, 'Oldest: triaged 4 tickets', 30, { read: true });
  await notify(person, 'Newest: closed a duplicate', 1);
  await notify(person, 'Middle: drafted a reply', 10);

  await page.goto('/notifications');
  const headlines = page.getByText(/^(Oldest|Middle|Newest):/);
  await expect(headlines).toHaveText([
    'Newest: closed a duplicate',
    'Middle: drafted a reply',
    'Oldest: triaged 4 tickets',
  ]);
  await expect(page.getByText('2 unread', { exact: true })).toBeVisible();
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
  await expect(page.getByText('2 unread', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/unread notification/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Actions for "Middle: drafted a reply"' }).click();
  await page.getByRole('menuitem', { name: 'Mark as unread' }).click();
  await expect(page.getByText('1 unread', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('1 unread', { exact: true })).toBeVisible();
});

test('somebody with no notifications sees none, and no one else’s', async ({
  page,
  request,
  person,
}) => {
  const other = `other-${person.subject}`;
  await notify(person, 'Somebody else’s news', 1, { subject: other });
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await expect(page.getByText('Somebody else’s news')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
  // Nobody's fixture forgets the other subject's row.
  await forgetSubject(request, other);
});
