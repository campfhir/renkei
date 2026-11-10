/**
 * Admin → Settings in a browser: the page renders on the real server, one
 * Save goes through end to end (an operator renames the organization, the
 * PUT reaches the org-settings route, "Saved." is drawn and the route
 * answers the trimmed name), the sections' screenshots in both themes, and
 * the page at a phone's width without sideways scrolling.
 *
 * Where the rest went: the form's rules (Save off until something changed,
 * only the changed fields sent, the server's clamped answer adopted, a
 * refusal kept on screen, the GB/MB fields, a half-typed size) are
 * settings-form.model.test.ts; what the route stores, refuses with a 400
 * and clamps — a blank name, the AD Manager product name, the PHI
 * covered-model switch, the sandbox switches and container ceilings, the
 * approval policy, the checkout limit — is
 * app/api/admin/org-settings/route.test.ts. That took the whole of
 * phi-covered-model.spec.ts, sandbox-settings.spec.ts and
 * agent-approval-policy.spec.ts; their sections are still photographed
 * here.
 *
 * Organization settings are one row per key for the whole server, so the
 * flow runs once, in desktop-light, the dark theme a screenshot under
 * `emulateMedia`, and the default name is put back afterwards. Pinned
 * Chromium; mobile is a viewport resize.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const DEFAULT_NAME = 'Renkei';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `organization-name-${name}.png`),
    fullPage: true,
  });
}

async function settings(page: Page): Promise<Record<string, unknown>> {
  const read = await page.request.get('/api/admin/org-settings');
  expect(read.ok()).toBe(true);
  const body: unknown = await read.json();
  const value =
    typeof body === 'object' && body !== null && 'settings' in body ? body.settings : null;
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

test('an operator names the organization', async ({ page, person: _person }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'Organization settings are shared by every project: one writer, the dark theme as a screenshot.'
  );
  test.setTimeout(240_000);
  const name = `Acme Health (${testInfo.project.name})`;

  await page.goto('/admin/settings');
  const main = page.getByRole('main');
  const field = main.getByRole('textbox', { name: 'Organization name' });
  await expect(field).toBeVisible();
  await field.scrollIntoViewIfNeeded();
  await shot(page, testInfo, '01-default');

  // The sections whose specs became route tests, as they look.
  for (const [control, label] of [
    [main.getByRole('switch', { name: 'Require a BAA-covered model for PHI connectors' }), 'phi'],
    [main.getByLabel('agentActStepsRequireApproval'), 'approval-policy'],
    [main.getByRole('switch', { name: 'Charts' }), 'sandbox'],
  ] as const) {
    await expect(control).toBeVisible();
    await control.scrollIntoViewIfNeeded();
    await shot(page, testInfo, `01-section-${label}`);
  }

  try {
    // ── Rename, save: the press reaches the route, which answers the trimmed name ──
    await field.fill(`  ${name}  `);
    await main.getByRole('button', { name: 'Save settings' }).click();
    await expect(main.getByText('Saved.')).toBeVisible();
    expect((await settings(page)).organizationName).toBe(name);
    // The form adopts the server's answer.
    await expect(field).toHaveValue(name);
    await shot(page, testInfo, '02-saved');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, testInfo, '02-saved-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // ── Phone width: the page fits, the field still sits in its section ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/settings');
    const narrow = page.getByRole('main').getByRole('textbox', { name: 'Organization name' });
    await expect(narrow).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await narrow.scrollIntoViewIfNeeded();
    await shot(page, testInfo, '03-mobile');
  } finally {
    // The default back for everyone else on the server.
    const restored = await page.request.put('/api/admin/org-settings', {
      data: { organizationName: DEFAULT_NAME },
    });
    expect(restored.ok()).toBe(true);
  }
  expect((await settings(page)).organizationName).toBe(DEFAULT_NAME);
});
