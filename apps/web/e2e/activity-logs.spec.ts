/**
 * Failures reach the log, and a person can see their own.
 *
 * The memory store keeps no log table, so what is checked here is the
 * page's half: a person with no Jira grant is shown their own activity
 * (lines tagged with their subject) rather than turned away, and a
 * request that fails in the browser is reported to /api/logs/client with
 * the status and the server's reason, which the route accepts.
 */

import { test, expect } from './fixtures';

test('a person without a Jira grant sees their own activity, not a refusal', async ({
  page,
  person: _person,
}) => {
  await page.goto('/logs');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(main.getByText('Connect Jira to see your activity')).toHaveCount(0);
  await expect(main.getByText(/^No /).filter({ visible: true })).toBeVisible();
});

test('an upload the server refuses is reported to the log with its reason', async ({
  page,
  person: _person,
}) => {
  await page.goto('/chat/artifacts');
  await page.route('**/api/chat/attachments?*', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, json: { error: 'object store unavailable' } })
      : route.fallback()
  );
  const reported = page.waitForRequest(
    (request) => request.url().endsWith('/api/logs/client') && request.method() === 'POST'
  );

  await page
    .getByRole('main')
    .getByLabel('Upload artifacts')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello\n') });

  // The page says it failed, and says why.
  await expect(
    page.getByRole('main').getByText(/notes\.txt: object store unavailable/).filter({ visible: true })
  ).toBeVisible();

  const report = await reported;
  const body: unknown = report.postDataJSON();
  expect(body).toMatchObject({
    level: 'error',
    component: 'fetch',
    page: '/chat/artifacts',
    attrs: { method: 'PUT', path: '/api/chat/attachments', status: 500, detail: 'object store unavailable' },
  });
  expect((await report.response())?.status()).toBe(200);
});

test('at phone width the Activity page still opens for a person without Jira', async ({
  page,
  person: _person,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/logs');
  await expect(page.getByRole('main').getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(page.getByRole('main').getByText('Connect Jira to see your activity')).toHaveCount(0);
});
