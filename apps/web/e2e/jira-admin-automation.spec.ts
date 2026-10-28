/**
 * Automation rules on an Atlassian API token, end to end in a browser:
 *
 * - the Jira Administration card takes the person's API token; one the
 *   stand-in Atlassian (e2e/sandbox-stub.mjs, through
 *   JIRA_AUTOMATION_API_BASE_URL) refuses is not kept, one it accepts is
 *   saved — and the delegate sent it as HTTP Basic, email:token;
 * - an automation change request (disabling a rule) is reviewed, then
 *   applied on that token, and the stand-in's rule is disabled;
 * - the token is removed from the card again;
 * - without a token, the review page says so in place of Apply.
 *
 * The person connects Jira Administration through its real connect flow
 * (the in-memory app's fake OAuth, e2e/support/jira-admin.ts), and the
 * proposal is their assistant's: a chat turn on the stand-in model calling
 * jira_admin_propose_automation_rule_state, which reads the rules on the
 * token. The audit trail's row is not read back: no page lists it.
 *
 * Each person works in a Jira site of their own: the stub keeps each
 * site's rules apart.
 *
 * Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  connectJiraAdministration,
  fakeJiraSite,
  prepareJiraAdministration,
  proposeInChat,
} from './support/jira-admin';
import { SANDBOX_STUB_URL } from './constants';
import { addStubModel, removeModel } from './support/stub-model';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const STUB = `${SANDBOX_STUB_URL}/automation/jira`;
const EMAIL = 'dana@example.com';
const TOKEN = 'ATATT3x-e2e-token';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** The stand-in's view, as the token's owner would see it. */
async function stubRule(subject: string, uuid: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${STUB}/${fakeJiraSite(subject).cloudId}/rest/v1/rule/${uuid}`, {
    headers: { authorization: `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}` },
  });
  const body: unknown = await response.json();
  const rule: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'rule') : null;
  return typeof rule === 'object' && rule !== null ? Object.fromEntries(Object.entries(rule)) : {};
}

async function lastAuthorization(subject: string): Promise<unknown> {
  const response = await fetch(`${STUB}/${fakeJiraSite(subject).cloudId}/__last-authorization`);
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null ? Reflect.get(body, 'authorization') : null;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function main(page: Page) {
  return page.getByRole('main');
}

let modelId = '';

test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
  await prepareJiraAdministration(request);
  await connectJiraAdministration(page);
  modelId = await addStubModel(
    page.request,
    `jira-automation-${testInfo.project.name}-${randomUUID().slice(0, 6)}`
  );
});

test.afterEach(async ({ page }) => {
  if (modelId) await removeModel(page.request, modelId);
  modelId = '';
});

/** The card's token box: save the token as the person types it in. */
async function saveToken(page: Page, token: string): Promise<void> {
  const tokenBox = page
    .locator('[data-coach="card-jira-admin"]')
    .filter({ visible: true })
    .getByTestId('jira-admin-api-token');
  await tokenBox.getByLabel('Atlassian account email').fill(EMAIL);
  await tokenBox.getByLabel('API token').fill(token);
  await tokenBox.getByRole('button', { name: 'Save API token' }).click();
}

/** What the assistant proposes: switching the stub's first rule off. */
async function proposeDisable(page: Page): Promise<string> {
  return proposeInChat(page, modelId, 'jira_admin_propose_automation_rule_state', {
    rules: ['Escalate outages'],
    enabled: false,
    reason: 'Freeze week',
  });
}

test('an API token is refused, then saved and sent as Basic; a rule is disabled on it; the token is removed', async ({
  page,
  person,
}, testInfo) => {
  // --- The card takes the token; one Atlassian refuses is not kept. ---
  await page.goto(`/connectors`);
  const panel = page.locator('[data-coach="card-jira-admin"]').filter({ visible: true });
  await expect(panel.getByText('Connected as')).toBeVisible();
  const tokenBox = panel.getByTestId('jira-admin-api-token');
  await expect(tokenBox.getByText('Automation rules: an Atlassian API token')).toBeVisible();
  await saveToken(page, 'nope');
  await expect(tokenBox.getByRole('alert')).toContainText(
    'Atlassian refused that token, so it was not kept.'
  );
  await page.reload();
  await expect(tokenBox.getByRole('button', { name: 'Save API token' })).toBeVisible();
  await expect(tokenBox.getByTestId('jira-admin-api-token-saved')).toHaveCount(0);
  await shot(page, testInfo, 'jira-admin-automation-01-refused');

  // One it accepts is saved — and reached it as Basic, email:token.
  await saveToken(page, TOKEN);
  await expect(tokenBox.getByTestId('jira-admin-api-token-saved')).toContainText(
    `API token saved for ${EMAIL}.`,
    { timeout: 30_000 }
  );
  expect(await lastAuthorization(person.subject)).toBe(
    `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`
  );
  await page.reload();
  await expect(tokenBox.getByTestId('jira-admin-api-token-saved')).toContainText(
    `API token saved for ${EMAIL}.`
  );
  await shot(page, testInfo, 'jira-admin-automation-02-saved');

  // --- A change reviewed, then applied on the token. ---
  const id = await proposeDisable(page);
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-title')).toHaveText(
    'Disable the automation rule “Escalate outages”'
  );
  await expect(main(page).getByTestId('change-reach')).toContainText(
    'Runs on your Atlassian API token, as you.'
  );
  await expect(main(page).getByText('Freeze week')).toBeVisible();
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(1);
  await expect(operations.nth(0)).toContainText('Disable the automation rule “Escalate outages”');
  expect((await stubRule(person.subject, 'rule-1')).state).toBe('ENABLED');
  await shot(page, testInfo, 'jira-admin-automation-03-review');

  await page.getByRole('button', { name: 'Apply this change to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations.nth(0)).toContainText('Done');
  expect((await stubRule(person.subject, 'rule-1')).state).toBe('DISABLED');
  await shot(page, testInfo, 'jira-admin-automation-04-applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-automation-05-mobile');

  // --- Removed from the card again. ---
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/connectors`);
  await tokenBox.getByRole('button', { name: 'Remove API token' }).click();
  await tokenBox.getByRole('button', { name: 'Yes, remove it' }).click();
  await expect(tokenBox.getByRole('button', { name: 'Save API token' })).toBeVisible({
    timeout: 30_000,
  });
  await page.reload();
  await expect(tokenBox.getByTestId('jira-admin-api-token-saved')).toHaveCount(0);
  await shot(page, testInfo, 'jira-admin-automation-06-removed');
});

test('without a token, the review page says so in place of Apply', async ({
  page,
  person: _person,
}, testInfo) => {
  // The proposal reads the rules on the token; then the token goes.
  await page.goto(`/connectors`);
  const tokenBox = page
    .locator('[data-coach="card-jira-admin"]')
    .filter({ visible: true })
    .getByTestId('jira-admin-api-token');
  await saveToken(page, TOKEN);
  await expect(tokenBox.getByTestId('jira-admin-api-token-saved')).toBeVisible({
    timeout: 30_000,
  });
  const id = await proposeDisable(page);
  await page.goto(`/connectors`);
  await tokenBox.getByRole('button', { name: 'Remove API token' }).click();
  await tokenBox.getByRole('button', { name: 'Yes, remove it' }).click();
  await expect(tokenBox.getByRole('button', { name: 'Save API token' })).toBeVisible({
    timeout: 30_000,
  });

  await page.goto(`/jira-admin/changes/${id}`);
  await expect(page.getByRole('button', { name: 'Apply this change to Jira' })).toBeDisabled();
  await expect(main(page)).toContainText(
    'No Atlassian API token is saved. Automation rules are read and changed with one'
  );
  await shot(page, testInfo, 'jira-admin-automation-07-no-token');
});
