/**
 * The org's act-approval policy on Settings → Agents: an operator picks
 * which agent runs pause a step that changes something, saves, and the
 * choice is what the settings route shows — refused outside the known
 * values when sent straight to the API.
 *
 * The setting is organization-wide and the projects run side by side on
 * one server, so the test holds the suite's lock on it
 * (e2e/support/org-lock.ts) and puts it back the way it found it.
 *
 * Mobile is a resized viewport, not the `mobile` project's device
 * descriptor (AGENTS.md, "UI changes").
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { holdExclusive } from './support/org-lock';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `approval-policy-${name}.png`),
    fullPage: true,
  });
}

async function policyOf(page: Page): Promise<unknown> {
  const read = await page.request.get(`/api/admin/org-settings`);
  expect(read.ok()).toBe(true);
  return (await read.json()).settings.agentActStepsRequireApproval;
}

test('act-step approval policy: default, change, save, API clamp', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(240_000);
  const release = await holdExclusive('org-setting-act-approval');
  try {
    // Whatever a run before this one left, start from the default.
    const reset = await page.request.put(`/api/admin/org-settings`, {
      data: { agentActStepsRequireApproval: 'externally_triggered' },
    });
    expect(reset.ok()).toBe(true);
    const settingsUrl = `/admin/settings`;
    const select = page.getByLabel('agentActStepsRequireApproval');

    // ── The default: runs an event or webhook started ──
    await page.goto(settingsUrl);
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('externally_triggered');
    await expect(page.getByText('A person must accept agent changes on')).toBeVisible();
    await select.scrollIntoViewIfNeeded();
    await shot(page, testInfo, '01-default');

    // ── Pick "every run" and save; the route agrees ──
    await select.selectOption('all');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect(await policyOf(page)).toBe('all');
    await shot(page, testInfo, '02-saved-all');
    // The form adopts the server's answer, so what it shows is what was stored.
    await expect(select).toHaveValue('all');

    // ── The API refuses a value outside the set, and takes a known one ──
    const refused = await page.request.put(`/api/admin/org-settings`, {
      data: { agentActStepsRequireApproval: 'sometimes' },
    });
    expect(refused.status()).toBe(400);
    const off = await page.request.put(`/api/admin/org-settings`, {
      data: { agentActStepsRequireApproval: 'off' },
    });
    expect((await off.json()).settings.agentActStepsRequireApproval).toBe('off');
    expect(await policyOf(page)).toBe('off');

    // ── Phone width: the row holds its layout ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(settingsUrl);
    await expect(select).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await select.scrollIntoViewIfNeeded();
    await shot(page, testInfo, '03-mobile');
  } finally {
    try {
      await page.request.put(`/api/admin/org-settings`, {
        data: { agentActStepsRequireApproval: 'externally_triggered' },
      });
    } finally {
      await release();
    }
  }
});
