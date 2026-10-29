/**
 * The Sandbox section of admin → Settings: the switches that replaced the
 * SANDBOX_*_ENABLED environment variables (migration 152). The features
 * are switched on first, through the same route (e2e/support/code-host.ts
 * — they stay on for every other spec); an operator turns charts off,
 * saves, and the API the page reads answers it — then the spec puts it
 * back. The settings are the one organization's, shared by every test on
 * the server, so only one Playwright project flips them. Mobile is a
 * viewport resize.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { prepareCodeHost } from './support/code-host';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `sandbox-settings-${name}.png`),
    fullPage: true,
  });
}

async function settings(page: Page): Promise<Record<string, unknown>> {
  const read = await page.request.get(`/api/admin/org-settings`);
  expect(read.ok()).toBe(true);
  const body: { settings: Record<string, unknown> } = await read.json();
  return body.settings;
}

test('sandbox features are the organization’s own switches', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'Organization-wide switches: one project flips them, so the other never sees them mid-change.'
  );
  test.setTimeout(240_000);
  await prepareCodeHost(request);

  // ── Every sandbox feature on, so the Code index offers the section proper ──
  await page.goto(`/code`);
  await expect(page.getByRole('heading', { name: 'Code' })).toBeVisible();
  await expect(page.getByText('Code workspaces are not enabled for this organization')).toHaveCount(
    0
  );

  // ── The switches, as set ──
  const settingsUrl = `/admin/settings`;
  await page.goto(settingsUrl);
  const charts = page.getByRole('switch', { name: 'Charts' });
  await expect(charts).toBeVisible();
  for (const name of ['Browser', 'Charts', 'Code workspaces', 'Code project services']) {
    await expect(page.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true');
  }
  await charts.scrollIntoViewIfNeeded();
  await shot(page, testInfo, '01-seeded');

  // ── Turn charts off, save; the API agrees ──
  try {
    await charts.click();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    const saved = await settings(page);
    expect(saved.sandboxChartsEnabled).toBe(false);
    expect(saved.sandboxWorkspacesEnabled).toBe(true);
    await shot(page, testInfo, '02-saved');

    // ── The API takes only booleans ──
    const refused = await page.request.put(`/api/admin/org-settings`, {
      data: { sandboxScriptsEnabled: 'yes' },
    });
    expect(refused.status()).toBe(400);

    // ── The service container ceilings: a setting too, in MB on the form ──
    const serviceMemory = page.getByRole('spinbutton', { name: 'sandboxServiceMemoryMb' });
    await expect(serviceMemory).toHaveValue('1024');
    await serviceMemory.fill('1536');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    const limits = await settings(page);
    expect(limits.sandboxServiceMemoryBytes).toBe(1536 * 1_048_576);
    expect(limits.sandboxServicePids).toBe(512);
    expect(limits.sandboxScriptMemoryBytes).toBe(2 * 1_073_741_824);
    await shot(page, testInfo, '03-service-memory');

    // ── Below what a container can run in is clamped to the floor, as every
    //    numeric setting is ──
    const tooSmall = await page.request.put(`/api/admin/org-settings`, {
      data: { sandboxServicePids: 1 },
    });
    expect(tooSmall.ok()).toBe(true);
    expect((await settings(page)).sandboxServicePids).toBe(16);
  } finally {
    // Back on, and back to the default ceilings, for everyone else in the run.
    const restored = await page.request.put(`/api/admin/org-settings`, {
      data: {
        sandboxChartsEnabled: true,
        sandboxServiceMemoryBytes: 1_073_741_824,
        sandboxServicePids: 512,
      },
    });
    expect(restored.ok()).toBe(true);
  }
  const restored = await settings(page);
  expect(restored.sandboxChartsEnabled).toBe(true);
  expect(restored.sandboxServiceMemoryBytes).toBe(1_073_741_824);
  expect(restored.sandboxServicePids).toBe(512);

  // ── Phone width: the switches still sit on their rows ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(settingsUrl);
  await expect(page.getByRole('switch', { name: 'Code workspaces' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await page.getByRole('switch', { name: 'Code workspaces' }).scrollIntoViewIfNeeded();
  await shot(page, testInfo, '04-mobile');
});
