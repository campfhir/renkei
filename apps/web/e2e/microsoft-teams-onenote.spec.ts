/**
 * The Teams and OneNote panels on the Microsoft 365 card, as a person meets
 * them: before connecting, each panel offers its own capabilities (the
 * org's ceiling, all on by default for a first connection); after the real
 * connect flow (the in-memory app's fake OAuth, the callback storing the
 * grant as production does) each shows what was granted, says that nothing
 * of its is indexed, and a changed checkbox marks the panel as not yet
 * approved. The admin's Microsoft connector page shows the two new scope
 * groups. Then the same card at phone width.
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

  // Before connecting, each panel offers its own capabilities, all on for a
  // first connection.
  await expect(teams.getByText('What Renkei may do here (5 of 5)')).toBeVisible();
  await teams.locator('summary').click();
  for (const option of [
    'Read chats',
    'Send chat messages',
    'Read teams and channels',
    'Post in channels',
    'See availability',
  ]) {
    await expect(teams.getByRole('checkbox', { name: new RegExp(`^${option}`) })).toBeChecked();
  }
  await expect(onenote.getByText('What Renkei may do here (4 of 4)')).toBeVisible();
  await onenote.locator('summary').click();
  await expect(onenote.getByRole('checkbox', { name: /^Read my notebooks/ })).toBeChecked();
  await expect(onenote.getByRole('checkbox', { name: /^Write in shared notebooks/ })).toBeChecked();
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

  // A changed checkbox is a draft until re-authorized, and the panel says so.
  await teams.locator('summary').first().click();
  const presence = teams.getByRole('checkbox', { name: /^See availability/ });
  await presence.uncheck();
  await expect(teams.getByText('Not approved yet')).toBeVisible();
  await expect(card.getByRole('link', { name: /Approve changes/ })).toBeVisible();
  await presence.check();
  await expect(teams.getByText('Not approved yet')).toHaveCount(0);

  // Phone width: the card and both panels fit without sideways scrolling.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(teams.getByText('5 of 5 on')).toBeVisible();
  await expect(onenote.getByText('4 of 4 on')).toBeVisible();
  const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'microsoft-teams-onenote-03-mobile');
});
