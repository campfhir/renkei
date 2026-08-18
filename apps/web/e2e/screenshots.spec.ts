/**
 * Screenshot sweep of the agent surfaces — a dev aid for LOOKING at layouts
 * (light/dark/mobile via the three projects), not a pixel-diff gate. Each
 * test anchors on page content (never the <title>, which is still the
 * create-next-app default) and then captures a full-page PNG under
 * test-results/screens/<project>/.
 */

import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { E2E_SLUG, AGENT_RICH_ID, AGENT_PLAIN_ID, RUN_STEP_FAILED_ID } from './seed';

async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { fullPage?: boolean } = {}
): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
    // fullPage's temporary viewport resize can remount client subtrees and
    // lose transient state (an opened <details>); shots of transient UI
    // pass fullPage: false and capture the viewport instead.
    fullPage: options.fullPage ?? true,
  });
}

test('agents list', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Triage yesterday into tickets')).toBeVisible();
  await shot(page, testInfo, 'agents-list');
});

test('agent overview', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}`);
  await expect(page.getByRole('heading', { name: 'Triage yesterday into tickets' })).toBeVisible();
  await shot(page, testInfo, 'agent-overview');
});

test('agent overview — memory section open', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}`);
  await expect(page.getByRole('heading', { name: 'Triage yesterday into tickets' })).toBeVisible();
  const isMobile = testInfo.project.name === 'mobile';
  if (isMobile) {
    // On phones the section is a button that opens a modal.
    await page.getByRole('button', { name: 'Memory' }).click();
    await expect(page.getByRole('dialog', { name: 'Memory' })).toBeVisible();
  } else {
    await page.getByText('Memory', { exact: true }).click();
  }
  await expect(page.getByText('Summary (compacted', { exact: false })).toBeVisible();
  await shot(page, testInfo, 'agent-overview-memory-open');
});

test('runs list', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/runs`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'runs-list');
});

test('failed run detail', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/runs/${RUN_STEP_FAILED_ID}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'run-detail-failed');
});

test('builder — new agent', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/new`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'builder-new');
});

test('builder — edit rich agent', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'builder-edit');
});

test('builder — step editor open', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /File follow-up tickets/ }).click();
  // Desktop: docked sidebar; mobile: modal — either way the step name field
  // appears in the editing surface.
  await expect(page.getByLabel('Step name')).toBeVisible();
  const failureSummary = page.locator('summary', { hasText: 'If something goes wrong' });
  await expect(failureSummary).toBeVisible();
  // Expanded for the screenshot — the disclosure is collapsed by default.
  await failureSummary.click();
  await failureSummary.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'builder-step-editor', { fullPage: false });
});

test('builder — branch editor open', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Edit branch: Anything actionable/ }).click();
  await expect(page.getByLabel('Branch name')).toBeVisible();
  await expect(page.getByLabel('If yes, path')).toBeVisible();
  await shot(page, testInfo, 'builder-branch-editor');
});

test('builder — schedule editor open (wide panel)', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Every weekday/ }).click();
  await expect(page.getByText('Blackout dates', { exact: false })).toBeVisible();
  await shot(page, testInfo, 'builder-schedule-editor');
});

test('builder — edit plain agent', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_PLAIN_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'builder-edit-plain');
});
