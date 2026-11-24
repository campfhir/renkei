/**
 * Health check-ins, end to end in a browser: an environment shows nothing
 * about health until someone sets it up; a token is issued for it, shown
 * once, and saved straight to the host as the environment's secret; the
 * application (here, plain requests with that token, as its own code would
 * send) says it is starting, then healthy, and the environment says so; a
 * check-in that is overdue shows as potentially failing, and three missed
 * in a row as failed; a token Renkei did not issue is refused; and taking
 * the token away stops the check-ins and the health showing.
 *
 * Where the rules went: the interface and how lateness is read —
 * lib/ci/health-rules.test.ts; tokens and what a check-in records —
 * lib/ci/health.test.ts and the two routes' tests; the words on the page —
 * health-checkins.model.test.ts.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  assignEnvironments,
  connectBitbucket,
  createCodeProject,
  prepareCodeHost,
} from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
  });
}

test('health check-ins: a token for the environment, the application says how it is, a late one shows', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  // A dev server compiles each route the first time it is asked for one.
  test.setTimeout(180_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  await prepareCodeHost(request);
  await connectBitbucket(page);
  const projectId = await createCodeProject(page.request, {
    name: `Health demo (${tag})`,
    repository: `acme/pipeline-demo-health-${tag}`,
    branch: 'main',
  });
  await assignEnvironments(page.request, projectId);

  await page.goto(`/code/${projectId}/environments`);
  const main = page.getByRole('main');
  const production = main.getByRole('region', { name: 'production', exact: true });
  const health = production.getByTestId('health-checkins');
  // Nothing about health until it is set up: only the way to.
  await expect(health.getByRole('button', { name: 'Set up health check-ins' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(health).not.toContainText('Healthy');

  // A token for the environment, shown once.
  await health.getByRole('button', { name: 'Set up health check-ins' }).click();
  const issued = health.getByRole('region', { name: 'The health token for production' });
  const token = (await issued.getByLabel('The token').innerText()).trim();
  expect(token).toMatch(/^rkh_[A-Za-z0-9_-]{40,}$/);
  await expect(health).toContainText('Waiting for the first check-in');
  await expect(issued.getByLabel('A check-in, as a command')).toContainText('/api/health/check-in');

  // Saved for the pipeline, straight to the host: the address plain, the token a secret.
  const saved = page.waitForRequest(
    (r) => r.url().endsWith(`/api/code/projects/${projectId}/variables`) && r.method() === 'PUT'
  );
  await issued.getByRole('button', { name: 'Save it for production’s pipeline' }).click();
  const sent = (await saved).postDataJSON();
  expect(sent.scope).toBe('environment');
  expect(sent.set.map((v: { key: string; secured: boolean }) => [v.key, v.secured])).toEqual([
    ['RENKEI_HEALTH_URL', false],
    ['RENKEI_HEALTH_TOKEN', true],
  ]);
  await expect(issued.getByRole('status')).toContainText(
    'Saved as RENKEI_HEALTH_URL and the secret RENKEI_HEALTH_TOKEN for production.'
  );
  await shot(page, testInfo, 'health-01-token');

  // Once the person has it, it is not on the page any more.
  await issued.getByRole('button', { name: 'I have it' }).click();
  await expect(issued).toHaveCount(0);
  expect(await page.content()).not.toContain(token);

  // The application checks in, as its own code would: starting, then healthy.
  const checkIn = (body: unknown, bearer = token) =>
    request.post('/api/health/check-in', {
      headers: { Authorization: `Bearer ${bearer}` },
      data: body,
    });
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  expect((await checkIn({ status: 'starting' })).status()).toBe(200);
  await page.reload();
  await expect(health).toContainText('Starting', { timeout: 30_000 });
  const answered = await checkIn({
    status: 'healthy',
    message: 'queue depth 3',
    version: '1.4.2',
    sentAt: ago(0),
    nextCheckInSeconds: 300,
  });
  expect(await answered.json()).toMatchObject({ recorded: true, nextCheckInSeconds: 300 });
  await page.reload();
  await expect(health).toContainText('Healthy', { timeout: 30_000 });
  await expect(health).toContainText('next expected within 5 minutes');
  await expect(health).toContainText('queue depth 3');
  await expect(health).toContainText('1.4.2');
  await shot(page, testInfo, 'health-02-healthy');

  // One that left eight minutes ago, due every five: overdue, so potentially failing.
  expect(
    (await checkIn({ status: 'healthy', sentAt: ago(8), nextCheckInSeconds: 300 })).status()
  ).toBe(200);
  await page.reload();
  await expect(health).toContainText('Potentially failing', { timeout: 30_000 });
  await expect(health).toContainText('1 check-in missed');
  await shot(page, testInfo, 'health-03-late');
  // Twenty minutes ago: three missed in a row, so failed.
  expect(
    (await checkIn({ status: 'healthy', sentAt: ago(20), nextCheckInSeconds: 300 })).status()
  ).toBe(200);
  await page.reload();
  await expect(health).toContainText('Failed', { timeout: 30_000 });
  await expect(health).toContainText('3 check-ins missed in a row');
  await shot(page, testInfo, 'health-04-failed');

  // A token Renkei did not issue says nothing, and a status that is not one is refused.
  expect((await checkIn({ status: 'healthy' }, 'rkh_not-a-token-renkei-issued')).status()).toBe(
    401
  );
  expect((await checkIn({ status: 'fine' })).status()).toBe(400);

  // Taking the token away stops the check-ins and the health showing.
  page.once('dialog', (dialog) => void dialog.accept());
  await health.getByRole('button', { name: 'Stop taking check-ins' }).click();
  await expect(health.getByRole('button', { name: 'Set up health check-ins' })).toBeVisible();
  await expect(health).not.toContainText('Failed');
  expect((await checkIn({ status: 'healthy' })).status()).toBe(401);
});
