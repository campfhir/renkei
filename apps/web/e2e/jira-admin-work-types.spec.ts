/**
 * A work type for OPS, end to end in a browser: an "Incident" with the bug
 * icon, on Bug's screens and workflow, in a scheme HR shares — named in the
 * warning colour on the review page — then applied against the stand-in
 * Jira of e2e/sandbox-stub.mjs (reached through JIRA_ADMIN_API_BASE_URL),
 * where the type now exists.
 *
 * The rules moved out of the browser, each where it is decided:
 * - a work type's steps in words and what applying sends (the type, its
 *   icon, the scheme mappings) — lib/jira-admin/work-type.test.ts;
 * - changes to a screen (a field on, one off, a tab renamed, in order) —
 *   lib/jira-admin/screen-changes.test.ts;
 * - a request type, which applies on the JSM grant and is refused until
 *   that grant carries "Set up request types" — lib/jira-admin/request-type.test.ts
 *   (what it sends), lib/jira-admin/apply.test.ts (the refusal naming the
 *   box) and change-actions.model.test.ts beside the review page (Apply
 *   off, saying why).
 *
 * The person connects Jira Administration through the real connect flow —
 * the in-memory app's fake OAuth, e2e/support/jira-admin.ts — and the
 * proposal is their assistant's: a chat turn on the stand-in model calling
 * jira_admin_propose_work_type, which reads what it changes from the
 * stand-in Jira.
 *
 * Each person works in a Jira site of their own: the stub keeps each
 * site's work types apart.
 *
 * Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  connectJiraAdministration,
  fakeJiraSite,
  JIRA_STUB,
  prepareJiraAdministration,
  proposeInChat,
} from './support/jira-admin';
import { addStubModel, removeModel } from './support/stub-model';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** GET from the stand-in Jira for the person's site, as JSON. */
async function stub(subject: string, pathAndQuery: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(
    `${JIRA_STUB}/${fakeJiraSite(subject).cloudId}${pathAndQuery}`,
    init
  );
  return response.json();
}

function values(body: unknown): Record<string, unknown>[] {
  const list: unknown[] = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && 'values' in body && Array.isArray(body.values)
      ? body.values
      : [];
  return list.map((item) =>
    typeof item === 'object' && item !== null ? Object.fromEntries(Object.entries(item)) : {}
  );
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

/** Right after a full load React can still hold a hidden copy of a streamed segment outside <main>. */
function main(page: Page) {
  return page.getByRole('main');
}

let modelId = '';

test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
  await prepareJiraAdministration(request);
  await connectJiraAdministration(page);
  modelId = await addStubModel(
    page.request,
    `jira-work-types-${testInfo.project.name}-${randomUUID().slice(0, 6)}`
  );
});

test.afterEach(async ({ page }) => {
  if (modelId) await removeModel(page.request, modelId);
  modelId = '';
});

test('a work type is reviewed with the scheme another space shares, then created in Jira', async ({
  page,
  person,
}, testInfo) => {
  const id = await proposeInChat(page, modelId, 'jira_admin_propose_work_type', {
    space: 'OPS',
    name: 'Incident',
    description: 'Something is down',
    icon: 'bug',
    like: 'Bug',
    sharedScheme: true,
    reason: 'The on-call rota asked',
  });

  // --- Reviewed: each step, and the scheme HR shares, in the warning colour. ---
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible();
  await expect(main(page).getByTestId('change-title')).toHaveText(
    'New work type “Incident” for OPS'
  );
  const reach = main(page).getByTestId('change-reach');
  await expect(reach).toContainText(
    'OPS’s work type scheme is shared with HR, and the work type appears in those spaces as well.'
  );
  await expect(reach).toHaveClass(/bg-amber-50/);
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(5);
  expect(
    values(await stub(person.subject, '/rest/api/3/issuetype')).map((type) => type.name)
  ).toEqual(['Task', 'Bug']);
  await shot(page, testInfo, 'jira-admin-work-types-01-review');

  // --- Applied: every step done, and the type is in Jira. ---
  await page.getByRole('button', { name: 'Apply these 5 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations.nth(0)).toContainText(/Created as \d+\./);
  for (const index of [1, 2, 3, 4]) {
    await expect(operations.nth(index)).toContainText('Done');
  }

  const types = values(await stub(person.subject, '/rest/api/3/issuetype'));
  expect(types.find((type) => type.name === 'Incident')).toMatchObject({
    description: 'Something is down',
  });
  await shot(page, testInfo, 'jira-admin-work-types-02-applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-work-types-03-mobile');
});
