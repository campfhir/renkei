/**
 * The shared fixtures (e2e/support/fixtures.ts, written once per server by
 * e2e/support/global-setup.ts through store calls) put on screen what
 * e2e/seed.ts's rows put there: the shared person's agents, their runs in
 * every state with the deep run's carried-out batch, the year of run log
 * and token ledger behind the usage panels, and the event monitor. Read
 * only — a spec that writes gets a person of its own.
 */

import { test, expect } from '@playwright/test';
import {
  AGENT_DEEP_ID,
  AGENT_RICH_ID,
  RUN_ITERATIONS_ID,
  RUN_STEP_FAILED_ID,
} from '../support/fixtures';
import { SHARED_STORAGE_STATE } from '../support/global-setup';

test.use({ storageState: SHARED_STORAGE_STATE });

test('the shared person’s agents and their runs', async ({ page }) => {
  await page.goto('/agents');
  await expect(page.getByText('Triage yesterday into tickets')).toBeVisible();
  await expect(page.getByText('Sweep the request queue')).toBeVisible();

  await page.goto(`/agents/${AGENT_RICH_ID}/runs`);
  // The parked run reads as paused for sign-in, not as waiting on an approval.
  await expect(page.getByText('Paused: sign in', { exact: true }).first()).toBeVisible();

  await page.goto(`/agents/${AGENT_RICH_ID}/runs/${RUN_STEP_FAILED_ID}`);
  await expect(page.getByRole('button', { name: 'Copy for debugging' })).toBeVisible();
  await expect(page.getByText('Searching yesterday’s activity.').first()).toBeVisible();

  await page.goto(`/agents/${AGENT_DEEP_ID}/runs/${RUN_ITERATIONS_ID}`);
  await expect(
    page.getByText('Escalate the VPN outage and acknowledge the laptop request.').first()
  ).toBeVisible();
  await expect(page.getByText('Comment 10041 added to OPS-301').first()).toBeVisible();
});

test('the agent overview’s memory and usage', async ({ page }) => {
  await page.goto(`/agents/${AGENT_RICH_ID}`);
  await expect(page.getByRole('heading', { name: 'Triage yesterday into tickets' })).toBeVisible();
  await page
    .locator('summary')
    .filter({ hasText: /^Memory$/ })
    .click();
  await expect(page.getByText('Summary (compacted', { exact: false })).toBeVisible();
  await page
    .locator('summary')
    .filter({ hasText: /^Usage$/ })
    .click();
  await page.getByRole('button', { name: 'All time' }).click();
  // The ledger's rows from before the model was recorded.
  await expect(page.getByText('Model not recorded').first()).toBeVisible();
});

test('the admin event monitor and agent oversight', async ({ page }) => {
  await page.goto('/admin/events');
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
  await expect(page.getByText('Failed · 1')).toBeVisible();

  await page.goto('/admin/agents');
  await expect(page.getByRole('heading', { name: 'Agent oversight' })).toBeVisible();
  await page.getByRole('button', { name: 'This year' }).click();
  await page.getByLabel('Sort by').selectOption('tokensIn');
  await expect(page.getByRole('link', { name: 'Triage yesterday into tickets' })).toBeVisible();
  await expect(page.getByText('claude-opus-5', { exact: false }).first()).toBeVisible();
});
