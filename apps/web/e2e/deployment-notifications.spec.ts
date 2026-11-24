/**
 * Deployment and health changes, end to end in a browser: the Deployments
 * card in Preferences is there only for someone with a code host
 * connected, with failures on and the quiet ones off; an application that
 * checks in with an error puts a notification in the feed that opens its
 * environment, and wakes the person's agent that listens for it; and a
 * setting switched on in Preferences (healthy again) is honoured by the
 * next change.
 *
 * Bitbucket is the sandbox stub's; the application's check-ins are plain
 * requests with the environment's token, as its own code would send them.
 * Where the rules went: which change falls under which setting and how it
 * reads — packages/ci-blocks/src/changes.test.ts; who is told and which
 * agents wake — apps/worker/src/deployments/changes.test.ts; when a
 * check-in or a report is a change — lib/ci/deployment-changes.test.ts;
 * the card's saving — preferences-form.model.test.ts.
 *
 * The model is organization-wide: it carries this run's tag and goes
 * again through the admin route at the end.
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
import { createAgent } from './support/agents';
import { addStubModel } from './support/stub-model';

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
    fullPage: true,
  });
}

test('deployment notifications: the settings, a failing application in the feed, and the agent it wakes', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  // A dev server compiles each route the first time it is asked for one.
  test.setTimeout(240_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const projectName = `Health alerts (${tag})`;
  let modelId: string | null = null;

  // Without a code host connected, Preferences has nothing about deployments.
  await page.goto('/preferences');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Batch jobs' })).toBeVisible({ timeout: 30_000 });
  await expect(main.getByRole('region', { name: 'Deployments' })).toHaveCount(0);
  // The page reads this browser's notification switch once mounted; let it finish.
  await page.waitForLoadState('networkidle');

  await prepareCodeHost(request);
  await connectBitbucket(page);
  try {
    const projectId = await createCodeProject(page.request, {
      name: projectName,
      repository: `acme/pipeline-demo-alerts-${tag}`,
      branch: 'main',
    });
    await assignEnvironments(page.request, projectId);
    modelId = await addStubModel(page.request, tag);
    // An agent of the person's that wakes when one of their applications reports an error.
    const agentId = await createAgent(page.request, {
      name: `Error responder ${tag}`,
      instructions: 'Say that the work is finished, then finish the run.',
      llmModelId: modelId,
      triggers: [
        {
          draft: {
            kind: 'event',
            eventId: 'deployments/health.changed',
            match: { states: ['error'] },
          },
          enabled: true,
        },
      ],
    });

    // Connected: the card is there, failures on, the quiet ones off.
    await page.goto('/preferences');
    const card = main.getByRole('region', { name: 'Deployments' });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByLabel('A deployment fails — App')).toBeChecked();
    await expect(card.getByLabel('An application fails — App')).toBeChecked();
    await expect(card.getByLabel('An application stops — App')).toBeChecked();
    await expect(card.getByLabel('An application is unhealthy — App')).toBeChecked();
    await expect(card.getByLabel('A deployment succeeds — App')).not.toBeChecked();
    await expect(card.getByLabel('An application may be failing — App')).not.toBeChecked();
    await expect(card.getByLabel('An application is healthy again — App')).not.toBeChecked();

    // Healthy again is switched on, and saved with this card alone.
    await card.getByLabel('An application is healthy again — App').check();
    const saved = page.waitForRequest(
      (r) => r.url().endsWith('/api/preferences') && r.method() !== 'GET'
    );
    await card.getByRole('button', { name: 'Save' }).click();
    const sent = (await saved).postDataJSON().notifications;
    expect(sent.appRecovered).toEqual({ app: true, email: false, webex: false });
    expect(sent.deploymentFailed).toEqual({ app: true, email: false, webex: false });
    expect(Object.keys(sent)).not.toContain('batchFinished');
    await expect(card.getByText('Saved.')).toBeVisible();
    await card.screenshot({
      path: path.join(
        import.meta.dirname,
        '..',
        'test-results',
        'screens',
        testInfo.project.name,
        'deployment-notifications-01-preferences.png'
      ),
    });

    // The application checks in: healthy, then with an error, then healthy again.
    const issued = await page.request.post(`/api/code/projects/${projectId}/health-token`, {
      data: { environment: 'production' },
    });
    expect(issued.ok(), await issued.text()).toBe(true);
    const { token } = await issued.json();
    const checkIn = async (body: unknown) => {
      const answered = await request.post('/api/health/check-in', {
        headers: { Authorization: `Bearer ${token}` },
        data: body,
      });
      expect(answered.status(), await answered.text()).toBe(200);
    };
    await checkIn({ status: 'healthy' });
    await checkIn({ status: 'error', message: 'database unreachable' });

    // The error is in the feed, from Deployments; a first healthy check-in was nobody's news.
    const errorRow = page
      .getByRole('link', { name: `production of “${projectName}” reports an error` })
      .filter({ visible: true });
    await expect(async () => {
      await page.goto('/notifications');
      await expect(errorRow).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await expect(
      page.getByText(`production of “${projectName}” is healthy`, { exact: false })
    ).toHaveCount(0);

    await checkIn({ status: 'healthy', message: 'recovered' });
    const recovered = page
      .getByRole('link', { name: `production of “${projectName}” is healthy again` })
      .filter({ visible: true });
    await expect(async () => {
      await page.reload();
      await expect(recovered).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole('main').getByText('Deployments').first()).toBeVisible();
    await shot(page, testInfo, 'deployment-notifications-02-feed');

    // The agent that listens for an error was woken by it, once, and ran to the end.
    await expect(async () => {
      await page.goto(`/agents/${agentId}`);
      await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
        timeout: 3_000,
      });
    }).toPass({ timeout: 60_000 });
    await shot(page, testInfo, 'deployment-notifications-03-agent-run');

    // The notification opens the environment it is about.
    await page.goto('/notifications');
    await errorRow.click();
    await expect(page).toHaveURL(new RegExp(`/code/${projectId}/environments\\?env=production`));
    await expect(
      page.getByRole('main').getByRole('region', { name: 'production', exact: true })
    ).toContainText('Healthy', { timeout: 30_000 });
  } finally {
    if (modelId) await page.request.delete(`/api/admin/llm-models/${modelId}`);
  }
});
