/**
 * The audience control on a connector's admin page (admin → Connectors →
 * <connector>, "Who … is for") says where groups come from — and, when no
 * groups claim is configured, that nobody is in any group, so a
 * restricted audience closes the connector to everyone.
 *
 * The memory server has no identity provider (see setup.spec.ts: the only
 * route that stores one first fetches the provider's discovery document,
 * and none answers in e2e), so there is no groups claim, and the page
 * shows exactly the "nobody is in a group" state. The named-claim half of
 * the old Postgres spec — PUT /api/admin/oidc-claims, the hint naming the
 * claim, the identity form on admin → Settings — needs a provider row to
 * hang the claim on (the route answers 409 "Sign-in is not configured
 * yet" without one) and is not reachable here. Read-only.
 * Pinned Chromium; mobile is a viewport resize.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');

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
  // No provider, so no claim: what the control reads.
  const claims = await (await page.request.get('/api/admin/oidc-claims')).json();
  expect(claims.configured).toBe(false);
  const refused = await page.request.put('/api/admin/oidc-claims', {
    data: { groupsClaim: 'e2e-member-of' },
  });
  expect(refused.status()).toBe(409);

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
