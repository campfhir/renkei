/**
 * Does an arrival actually reach the browser's own Notification API?
 *
 * `window.Notification` is replaced (not the real thing — headless Chromium
 * under --no-sandbox doesn't reliably surface OS-level banners, and this
 * only needs to prove the app called the constructor with the right
 * arguments) with a spy that records every call. The tab is left "visible"
 * but not focused — `desktop-notifications.tsx` only fires while the tab is
 * NOT in front — and the desktop-notifications-enabled localStorage flag is
 * set before the first poll, same as flipping the switch in Preferences
 * would leave it.
 */

import { test, expect } from '@playwright/test';
import pg from 'pg';
import { E2E_SLUG, E2E_TENANT_ID, E2E_SUBJECT, AGENT_DEEP_ID } from './seed';

declare global {
  interface Window {
    __notifications: { title: string; options?: NotificationOptions }[];
  }
}

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

async function insertNotification(headline: string, refUrl: string | null): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO agent_notifications
         (id, tenant_id, subject, kind, category, connector, tool, entity, headline,
          ref_url, run_id, agent_id, agent_name, created_at)
       VALUES (gen_random_uuid(),$1,$2,'act','created','jira','jira_create_issue','issue',$3,
               $4,null,$5,'Triage yesterday into tickets', now())`,
      [E2E_TENANT_ID, E2E_SUBJECT, headline, refUrl, AGENT_DEEP_ID]
    );
  } finally {
    await client.end();
  }
}

/** Replaces window.Notification with a spy, and leaves the tab visible but
 *  unfocused — "not in front" per desktop-notifications.tsx. */
async function spyOnNotifications(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    window.__notifications = [];
    class SpyNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission(): Promise<NotificationPermission> {
        return Promise.resolve('granted');
      }
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        window.__notifications.push({ title, options });
      }
      close(): void {}
    }
    Object.defineProperty(window, 'Notification', { value: SpyNotification, writable: true });
    Object.defineProperty(document, 'hasFocus', { value: () => false, writable: true });
  });
}

test('a background arrival reaches window.Notification', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await spyOnNotifications(page);

  // Registered BEFORE navigating: NotificationCenter fires its seeding poll
  // on mount, and that poll must actually complete before the notification
  // below is inserted — otherwise it can land inside that first (discarded)
  // fetch and never be re-fetched as an "arrival" at all.
  const seedingPoll = page.waitForResponse((response) =>
    response.url().includes(`/api/tenant/${E2E_TENANT_ID}/notifications`)
  );
  await page.goto(`/${E2E_SLUG}`);
  await expect(page.getByRole('heading', { name: 'Actionable items' })).toBeVisible();
  await seedingPoll;

  // Same write the Preferences checkbox does when it's flipped on.
  await page.evaluate(
    (tenantId) =>
      window.localStorage.setItem(`renkei:desktop-notifications-enabled:${tenantId}`, '1'),
    E2E_TENANT_ID
  );

  // DesktopNotifications registers the service worker on mount — confirms
  // public/sw.js is valid and actually installs, independent of whether the
  // constructor path (exercised below) or the worker path ends up firing.
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r)), {
      timeout: 15_000,
    })
    .toBe(true);

  await insertNotification(
    'Created a Jira issue OPS-9001',
    'https://example.atlassian.net/browse/OPS-9001'
  );

  // NotificationCenter polls every 20s; the row above must survive past the
  // seeding poll (this page's very first fetch) to count as an "arrival".
  await expect
    .poll(() => page.evaluate(() => window.__notifications.length), {
      timeout: 30_000,
      intervals: [1_000],
    })
    .toBeGreaterThan(0);

  const captured = await page.evaluate(() => window.__notifications);
  expect(captured).toHaveLength(1);
  expect(captured[0].title).toBe('Created a Jira issue OPS-9001');
  expect(captured[0].options?.body).toBe('Triage yesterday into tickets');
  expect(captured[0].options?.data?.refUrl).toBe('https://example.atlassian.net/browse/OPS-9001');
});

test('with the switch off, nothing reaches window.Notification', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await spyOnNotifications(page);

  await page.goto(`/${E2E_SLUG}`);
  await expect(page.getByRole('heading', { name: 'Actionable items' })).toBeVisible();
  // Deliberately NOT setting the localStorage flag — the opt-in is off.

  await insertNotification('Created a Jira issue OPS-9002', null);

  // Give it the same window as the positive case, then assert nothing fired.
  await page.waitForTimeout(25_000);
  const count = await page.evaluate(() => window.__notifications.length);
  expect(count).toBe(0);
});
