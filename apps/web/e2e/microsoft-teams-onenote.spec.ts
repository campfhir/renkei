/**
 * The Teams and OneNote panels on the Microsoft 365 card, in a browser:
 * the admin's Microsoft connector page renders the two scope groups; the
 * person's card renders just the panels they added; one press goes end to
 * end — Connect through the real flow (the in-memory app's fake OAuth, the
 * callback storing the grant as production does) and each panel drawing
 * what was granted ("5 of 5 on", "4 of 4 on") and that nothing of its is
 * indexed. Then the card at phone width.
 *
 * Where the rest went: the card's rules (which panels show, everything
 * ticked for a first connection, the "N of M" summaries, a product the org
 * withheld hidden, the consent URL, "Not approved yet" and "Approve
 * changes" after a changed checkbox, the disconnect question) are
 * connectors/microsoft-product-card.model.test.ts and
 * connectors/microsoft-connect-body.model.test.ts.
 *
 * The org's app registration is left on: other specs connect through it
 * too. Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
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

/**
 * The nested panel of one product, by its heading — the innermost box
 * holding it. The `has` locator is page-rooted on purpose: Playwright
 * resolves it relative to each candidate, so one chained off the card would
 * look for the card inside the panel.
 */
function panel(page: Page, card: Locator, title: string): Locator {
  return card
    .locator('div.rounded-lg')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) })
    .last();
}

test('Teams and OneNote: two panels on the one Microsoft consent', async ({
  browser,
  page,
  request,
  person: _person,
}, testInfo) => {
  // Microsoft 365 is set up for the org by an operator, who also sees the
  // new scope groups on the connector's admin page.
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
    const admin = await asOperator.newPage();
    await admin.goto('/admin/connectors/microsoft');
    const form = admin.getByRole('main');
    await expect(form.getByText('Teams', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(form.getByText('OneNote', { exact: true }).first()).toBeVisible();
    await expect(form.getByRole('checkbox', { name: /^Read chats/ })).toBeVisible();
    await expect(form.getByRole('checkbox', { name: /^Post in channels/ })).toBeVisible();
    await expect(form.getByRole('checkbox', { name: /^Read my notebooks/ })).toBeVisible();
    await expect(form.getByRole('checkbox', { name: /^Write in shared notebooks/ })).toBeVisible();
    await admin.close();
  } finally {
    await asOperator.close();
  }

  // The person adds the two products from the catalog, which puts the
  // Microsoft 365 card on their page with just those panels.
  await addConnectors(page.request, ['teams', 'onenote']);
  await page.goto('/connectors');
  await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible();
  const card = page.locator('[data-coach="card-microsoft"]').filter({ visible: true });
  await expect(card).toBeVisible();
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible();

  const teams = panel(page, card, 'Teams');
  const onenote = panel(page, card, 'OneNote');
  await expect(teams).toBeVisible();
  await expect(onenote).toBeVisible();
  // Only what was added: no Outlook or SharePoint panel on this card.
  await expect(card.getByRole('heading', { level: 3, name: 'Outlook', exact: true })).toHaveCount(
    0
  );
  await expect(card.getByRole('heading', { level: 3, name: 'SharePoint' })).toHaveCount(0);

  await shot(page, testInfo, 'microsoft-teams-onenote-01-before-connect');

  // Connect for real: the fake consent answers at once and the callback
  // stores the grant with every scope the card asked for.
  await connectThrough(page, '/api/microsoft/authorize');
  await expect(card.getByText('Connected', { exact: true })).toBeVisible();
  await expect(teams.getByText('5 of 5 on')).toBeVisible();
  await expect(onenote.getByText('4 of 4 on')).toBeVisible();
  await expect(teams.getByText(/Nothing from Teams is indexed/)).toBeVisible();
  await expect(onenote.getByText(/Nothing from OneNote is indexed/)).toBeVisible();
  await shot(page, testInfo, 'microsoft-teams-onenote-02-connected');

  // Phone width: the card and both panels fit without sideways scrolling.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(teams.getByText('5 of 5 on')).toBeVisible();
  await expect(onenote.getByText('4 of 4 on')).toBeVisible();
  const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'microsoft-teams-onenote-03-mobile');
});
