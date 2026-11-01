/**
 * The Outlook background opt-in on the connectors page, in a browser: the
 * person connects Microsoft 365 through its real connect flow, the card
 * draws the one Mail toggle, and one press goes end to end — the box
 * ticked, the PUT reaching /api/microsoft/indexing (which writes the
 * grant's metadata and enqueues the bootstrap event the in-process
 * dispatcher takes up and gives up on, with no Graph here), the notice
 * drawn, and a reload reading the choice back. Then the card at a phone's
 * width.
 *
 * Where the rest went: the section's rules (one Mail toggle and no
 * Calendar or Tasks, disabled until the choice is read, what a click
 * sends, the notices for on and off, a refused save putting the box back)
 * are connectors/outlook-indexing-prefs.model.test.ts; the route's (what
 * the grant then says, a calendar or tasks flag dropped, the bootstrap
 * woken, 404 without a connection) are
 * app/api/microsoft/indexing/route.test.ts, which replaced this spec's two
 * polls of the route.
 *
 * On the in-memory app the consent is the app's own fake OAuth
 * (packages/provider-grants/src/fake-oauth.ts), and the callback stores the
 * grant as production does. The org's app registration is left on: other
 * specs connect through it too. Pinned Chromium; "mobile" is a resized
 * viewport, per AGENTS.md.
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

test('Outlook opt-in: Mail wakes agents, saved for real', async ({
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

  // The one toggle, off for a fresh connection.
  const mail = prefs.getByRole('checkbox', { name: /^Mail/ });
  await expect(prefs.getByRole('checkbox')).toHaveCount(1);
  await expect(mail).toBeEnabled();
  await expect(mail).not.toBeChecked();
  // Nothing in Outlook indexes, so the card carries no indexing progress
  // and no re-index control.
  await expect(card.getByText('Indexing', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Re-index' })).toHaveCount(0);
  await shot(page, testInfo, 'outlook-indexing-01-off');

  // Opt into the trigger feed: the real PUT, its notice, and a reload reading it back.
  await mail.check();
  await expect(prefs.getByText(/start waking agents/)).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, 'outlook-indexing-02-mail-on');
  await page.reload();
  await expect(prefs.getByRole('checkbox', { name: /^Mail/ })).toBeChecked();

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(prefs.getByText('What runs in the background')).toBeVisible();
  await expect(mail).toBeVisible();
  await shot(page, testInfo, 'outlook-indexing-03-mobile');
});
