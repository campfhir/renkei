/**
 * Does flipping the "show system notifications" switch actually create a
 * push subscription, and does flipping it back off remove it?
 *
 * `PushManager.subscribe()` itself is mocked rather than exercised for
 * real: Chrome refuses the Push API in any context it treats as
 * incognito-like (crbug.com/401439), which is exactly what Playwright's
 * default browser contexts are — there is no way to feature-detect around
 * it, by design. Everything on THIS app's side of that boundary is driven
 * through the real Preferences UI and hits the real server: the service
 * worker registration, the public-key fetch, the POST to
 * /push/subscribe(/unsubscribe), and the row it writes or removes — only
 * the browser's own subscribe()/getSubscription() calls are stood in for,
 * with a canned-but-realistic subscription object.
 */

import { test, expect } from '@playwright/test';
import pg from 'pg';
import { E2E_SLUG, E2E_TENANT_ID, E2E_SUBJECT } from './seed';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

const FAKE_ENDPOINT = 'https://fake-push-service.example.test/subscription-abc';

async function mockPushManager(page: import('@playwright/test').Page): Promise<void> {
  // Assigned via defineProperty rather than a direct prototype write: a fake
  // subscription can't honestly satisfy PushSubscription's full DOM
  // interface (getKey, options, expirationTime — none of which anything
  // here reads), and PropertyDescriptor.value is deliberately untyped for
  // exactly this kind of stand-in.
  await page.addInitScript(
    ({ endpoint }) => {
      if (!('PushManager' in window)) return;
      const subscriptionJson = {
        endpoint,
        keys: { p256dh: 'fake-p256dh-value', auth: 'fake-auth-value' },
      };
      let current: typeof subscriptionJson | null = null;
      Object.defineProperty(window.PushManager.prototype, 'subscribe', {
        value: () => {
          current = subscriptionJson;
          return Promise.resolve({
            endpoint,
            toJSON: () => subscriptionJson,
            unsubscribe: () => {
              current = null;
              return Promise.resolve(true);
            },
          });
        },
      });
      Object.defineProperty(window.PushManager.prototype, 'getSubscription', {
        value: () =>
          Promise.resolve(
            current
              ? {
                  endpoint: current.endpoint,
                  toJSON: () => current,
                  unsubscribe: () => Promise.resolve(true),
                }
              : undefined
          ),
      });
    },
    { endpoint: FAKE_ENDPOINT }
  );
}

async function subscriptionRow(): Promise<{
  endpoint: string;
  p256dh: string;
  auth: string;
} | null> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE tenant_id = $1 AND subject = $2',
      [E2E_TENANT_ID, E2E_SUBJECT]
    );
    return rows[0] ?? null;
  } finally {
    await client.end();
  }
}

async function clearSubscriptions(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM push_subscriptions WHERE tenant_id = $1 AND subject = $2', [
      E2E_TENANT_ID,
      E2E_SUBJECT,
    ]);
  } finally {
    await client.end();
  }
}

test.beforeEach(async () => {
  await clearSubscriptions();
});

test('flipping the switch on subscribes this device and records it, off removes it', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications']);
  await mockPushManager(page);

  await page.goto(`/${E2E_SLUG}/preferences`);
  const checkbox = page.getByRole('checkbox', { name: /Show system notifications/i });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();

  // Not .check(): the box is a controlled input whose onChange does real
  // async work (fetch the VAPID key, subscribe, POST it) before React ever
  // flips `checked`, so the native click-then-verify .check() action can
  // observe it as unchanged. A plain click plus a retrying assertion gives
  // that async chain room to land instead.
  await checkbox.click();
  await expect(checkbox).toBeChecked({ timeout: 10_000 });

  await expect
    .poll(async () => subscriptionRow(), { timeout: 10_000 })
    .toEqual({ endpoint: FAKE_ENDPOINT, p256dh: 'fake-p256dh-value', auth: 'fake-auth-value' });

  await checkbox.click();
  await expect(checkbox).not.toBeChecked({ timeout: 10_000 });

  await expect.poll(async () => subscriptionRow(), { timeout: 10_000 }).toBeNull();
});

test('with the switch left off, nothing gets subscribed', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await mockPushManager(page);

  await page.goto(`/${E2E_SLUG}/preferences`);
  const checkbox = page.getByRole('checkbox', { name: /Show system notifications/i });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();

  // Give DesktopNotifications' mount-time self-heal effect (see
  // components/desktop-notifications.tsx) the same window the positive
  // case gets, then confirm it found nothing to heal.
  await page.waitForTimeout(3_000);
  expect(await subscriptionRow()).toBeNull();
});
