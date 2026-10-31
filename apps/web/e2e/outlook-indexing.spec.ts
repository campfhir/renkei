/**
 * The Outlook background opt-in on the connectors page, after mail,
 * calendar and To Do all left the knowledge index: one Mail toggle that
 * only wires new mail to the "An email arrives" agent trigger (and says
 * so), NO Tasks or Calendar toggle, and no indexing progress or re-index
 * control, since nothing in Outlook indexes. Driven against the real
 * /api/microsoft/indexing route — a PUT writes the grant's metadata and
 * enqueues the bootstrap event, which the in-process event dispatcher
 * takes up and gives up on (no Graph here) — and the saved shape read back
 * through the same route the card reads.
 *
 * The person connects Microsoft 365 through its real connect flow: on the
 * in-memory app the consent is the app's own fake OAuth
 * (packages/provider-grants/src/fake-oauth.ts), and the callback stores the
 * grant as production does. The org's app registration is left on: other
 * specs connect through it too.
 *
 * Not reachable here: a grant from before calendar and tasks left the
 * index (a `calendar: true` flag the page must neither show nor keep), and
 * the subscription rows the worker leaves behind — only an old grant and
 * the worker's Graph round trips write those.
 *
 * Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { addConnectors, connectThrough, registerConnector } from './support/connectors';
import { createPerson, signIn } from './support/person';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

/** What the card reads: the grant's Outlook opt-in. */
async function savedIndexing(page: Page): Promise<unknown> {
  const response = await page.request.get('/api/microsoft/indexing');
  expect(response.ok(), await response.text()).toBe(true);
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null ? Reflect.get(body, 'indexing') : null;
}

test('Outlook opt-in: Mail is a trigger feed; Tasks and Calendar are gone', async ({
  browser,
  page,
  request,
  person: _person,
}, testInfo) => {
  // Microsoft 365 is set up for the org (by an operator) and connected for this person.
  const operator = await createPerson(request, {
    roles: ['renkei-user', 'renkei-operator'],
    displayName: 'Microsoft operator',
  });
  const asOperator = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    await signIn(asOperator, operator);
    await registerConnector(
      asOperator.request,
      'microsoft',
      {
        clientId: 'e2e-microsoft-client',
        clientSecret: 'e2e-microsoft-secret',
        directoryTenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
      ['directoryTenantId']
    );
  } finally {
    await asOperator.close();
  }
  await addConnectors(page.request, ['microsoft']);
  await connectThrough(page, '/api/microsoft/authorize');

  await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible();
  const card = page.locator('[data-coach="card-microsoft"]').filter({ visible: true });
  await expect(card.getByText('Connected', { exact: true })).toBeVisible();
  const prefs = card.locator('[data-coach="outlook-indexing"]');
  await expect(prefs.getByText('What runs in the background')).toBeVisible();

  // Exactly one toggle, saying what it now means.
  const mail = prefs.getByRole('checkbox', { name: /^Mail/ });
  await expect(prefs.getByRole('checkbox')).toHaveCount(1);
  await expect(prefs.getByText(/Calendar/)).toHaveCount(0);
  await expect(prefs.getByText(/Tasks|To Do/)).toHaveCount(0);
  await expect(prefs.getByText(/"An email arrives" trigger/)).toBeVisible();
  await expect(prefs.getByText(/never indexed/)).toBeVisible();
  await expect(mail).toBeEnabled();
  await expect(mail).not.toBeChecked();

  // Nothing in Outlook indexes, so the card carries no indexing progress
  // and no re-index control.
  await expect(card.locator('li', { hasText: /indexed/ })).toHaveCount(0);
  await expect(card.getByText('Indexing', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Re-index' })).toHaveCount(0);
  await shot(page, testInfo, 'outlook-indexing-01-off');

  // Opt into the trigger feed: the real PUT, then the saved shape.
  await mail.check();
  await expect(prefs.getByText(/start waking agents/)).toBeVisible({ timeout: 30_000 });
  await expect(prefs.getByText(/Nothing is indexed/)).toBeVisible();
  await expect.poll(() => savedIndexing(page)).toEqual({ mail: true });
  await shot(page, testInfo, 'outlook-indexing-02-mail-on');

  await mail.uncheck();
  await expect(prefs.getByText('New mail no longer wakes your agents.')).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => savedIndexing(page)).toEqual({ mail: false });
  // Saved for real: a reload reads it back off.
  await page.reload();
  await expect(prefs.getByRole('checkbox', { name: /^Mail/ })).not.toBeChecked();

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(prefs.getByText('What runs in the background')).toBeVisible();
  await expect(mail).toBeVisible();
  await shot(page, testInfo, 'outlook-indexing-03-mobile');
});
