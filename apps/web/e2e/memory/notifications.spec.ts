/**
 * The notifications page on the in-memory data store: the feed in order,
 * the unread total, "Mark all as read" and a per-card "Mark as unread"
 * going through the real route to the store and surviving a reload, and
 * the empty state for somebody with nothing yet.
 */

import path from 'node:path';
import { test, expect, type MemoryPerson } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');

function notification(person: MemoryPerson, headline: string, minutesAgo: number, read = false) {
  const createdAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id: crypto.randomUUID(),
    subject: person.subject,
    kind: 'agent_run',
    headline,
    agent_name: 'Triage',
    created_at: createdAt,
    read_at: read ? createdAt : null,
  };
}

test('the feed, newest first, marked read and unread again', async ({ page, person }, testInfo) => {
  await person.seed({
    agent_notifications: [
      notification(person, 'Oldest: triaged 4 tickets', 30, true),
      notification(person, 'Newest: closed a duplicate', 1),
      notification(person, 'Middle: drafted a reply', 10),
    ],
  });

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
  // until the request has gone through.
  await expect(async () => {
    await page.getByRole('button', { name: 'Mark all as read' }).click({ timeout: 1_000 });
    await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0, {
      timeout: 1_000,
    });
  }).toPass();
  await page.reload();
  await expect(page.getByText('2 unread', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/unread notification/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Actions for "Middle: drafted a reply"' }).click();
  await page.getByRole('menuitem', { name: 'Mark as unread' }).click();
  await expect(page.getByText('1 unread', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('1 unread', { exact: true })).toBeVisible();
});

test('somebody with no notifications sees none, and no one else’s', async ({ page, person }) => {
  await person.seed({
    agent_notifications: [
      { ...notification(person, 'Somebody else’s news', 1), subject: `other-${person.subject}` },
    ],
  });
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await expect(page.getByText('Somebody else’s news')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
});
