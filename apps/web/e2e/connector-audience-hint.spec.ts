/**
 * The audience control on a connector's admin page (admin → Connectors →
 * <connector>, "Who … is for") as it renders on the real server and at a
 * phone's width, in the state the memory server is always in: no identity
 * provider, so no groups claim, so the control says nobody is in any
 * group and a restricted audience closes the connector to everyone.
 * Read-only.
 *
 * Where its rules went: what the hint says with and without a claim, what
 * each choice saves and what a save says are
 * app/(app)/admin/connectors/[configKey]/audience-control.model.test.ts;
 * that no provider means no claim (GET configured: false, PUT 409) is
 * app/api/admin/oidc-claims/route.test.ts; what the audience route stores
 * is app/api/admin/connector-audience/[capabilityKey]/route.test.ts.
 *
 * Pinned Chromium; mobile is a viewport resize.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `audience-hint-${name}.png`),
    fullPage: true,
  });
}

test('with no groups claim, the audience control says nobody is in a group', async ({
  page,
  person: _person,
}, testInfo) => {
  await page.goto('/admin/connectors/atlassian-bitbucket');
  const control = page
    .locator('section', { has: page.getByRole('heading', { name: /^Who .* is for$/ }) })
    .first();
  await expect(control).toBeVisible();
  await expect(control).toContainText('No groups claim is configured');
  await expect(control).toContainText('closes the connector to everyone');
  await expect(control).toContainText('Nobody is in a group by default');
  await shot(page, testInfo, '01-no-claim');

  // ── Phone width: the control still reads ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(control).toContainText('No groups claim is configured');
  await shot(page, testInfo, '03-mobile');
});
