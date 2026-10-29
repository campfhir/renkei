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
 * worker registration, the public-key fetch, and the POST to
 * /push/subscribe(/unsubscribe) the server accepts — only the browser's
 * own subscribe()/getSubscription() calls are stood in for, with a
 * canned-but-realistic subscription object. No route reads the stored
 * subscription back, so what the server was handed, and that it took it,
 * is the assertion.
 */

import type { Page, Request } from '@playwright/test';
import { test, expect } from './fixtures';
import { painted } from './support/settle';

const FAKE_ENDPOINT = 'https://fake-push-service.example.test/subscription-abc';

async function mockPushManager(page: Page): Promise<void> {
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

const isPush = (request: Request, path: 'subscribe' | 'unsubscribe') =>
  request.method() === 'POST' && new URL(request.url()).pathname === `/api/push/${path}`;

test('flipping the switch on subscribes this device and records it, off removes it', async ({
  page,
  context,
  person: _person,
}) => {
  await context.grantPermissions(['notifications']);
  await mockPushManager(page);

  await page.goto(`/preferences`);
  const checkbox = page.getByRole('checkbox', { name: /Show system notifications/i });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();

  // Not .check(): the box is a controlled input whose onChange does real
  // async work (fetch the VAPID key, subscribe, POST it) before React ever
  // flips `checked`, so the native click-then-verify .check() action can
  // observe it as unchanged. A plain click plus a retrying assertion gives
  // that async chain room to land instead.
  const subscribed = page.waitForResponse((response) => isPush(response.request(), 'subscribe'));
  await checkbox.click();
  await expect(checkbox).toBeChecked({ timeout: 10_000 });
  const subscribe = await subscribed;
  expect(subscribe.ok()).toBe(true);
  expect(subscribe.request().postDataJSON()).toMatchObject({
    endpoint: FAKE_ENDPOINT,
    keys: { p256dh: 'fake-p256dh-value', auth: 'fake-auth-value' },
  });

  const unsubscribed = page.waitForResponse((response) =>
    isPush(response.request(), 'unsubscribe')
  );
  await checkbox.click();
  await expect(checkbox).not.toBeChecked({ timeout: 10_000 });
  const unsubscribe = await unsubscribed;
  expect(unsubscribe.ok()).toBe(true);
  expect(unsubscribe.request().postDataJSON()).toMatchObject({ endpoint: FAKE_ENDPOINT });
});

test('with the switch left off, nothing gets subscribed', async ({
  page,
  context,
  person: _person,
}) => {
  await context.grantPermissions(['notifications']);
  await mockPushManager(page);
  const subscribes: string[] = [];
  const keys: string[] = [];
  page.on('request', (request) => {
    if (isPush(request, 'subscribe')) subscribes.push(request.url());
    if (new URL(request.url()).pathname === '/api/push/public-key') keys.push(request.url());
  });

  await page.goto(`/preferences`);
  const checkbox = page.getByRole('checkbox', { name: /Show system notifications/i });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();

  // DesktopNotifications' mount-time self-heal (components/desktop-notifications.tsx)
  // waits on the service worker before it would fetch the push key and
  // subscribe: once the worker is ready and the page has painted since, it
  // has had its chance, and found nothing to heal.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await painted(page);
  expect(keys).toEqual([]);
  expect(subscribes).toEqual([]);
});
