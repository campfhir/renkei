/**
 * Jira Administration, end to end in a browser: an operator registers the
 * fifth Atlassian app through the real admin form and save route, a person
 * finds its card on the connectors page, narrows its classic scopes in the
 * live picker, and the authorize route turns that into a consent redirect
 * carrying exactly those scopes — and refuses a scope the org held back.
 *
 * Nothing here reaches Atlassian: the authorize route is read with
 * redirects off (the Location header is the assertion).
 *
 * Not reachable here: the connected state, the real disconnect, and the
 * connected everyday-Jira card beside it (whose connected panel once took
 * the whole page down). Each is a grant the OAuth callback writes after a
 * code exchange with auth.atlassian.com, made server-side by the delegate
 * against a fixed token endpoint, which no route or `page.route` can stand
 * in for.
 *
 * The connector config is organization-wide (one row for the whole
 * server): the flow runs once, in desktop-light, with the dark theme as an
 * `emulateMedia` screenshot, and the config is put back as it was
 * afterwards (disabled again when the test made it — the admin route has
 * no delete).
 *
 * Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { addConnectors, connectorConfig, saveConnectorConfig } from '../support/connectors';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('jira administration: register the app, connect with narrowed classic scopes', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'The connector config is organization-wide: one writer, the dark theme as a screenshot.'
  );
  const before = await connectorConfig(page.request, 'atlassian-admin');
  try {
    // --- The operator registers the fifth Atlassian app. ---
    await page.goto(`/admin/connectors/atlassian-admin`);
    await expect(
      page.getByRole('heading', { name: 'Jira Administration', level: 1 })
    ).toBeVisible();
    const form = page.locator('[data-coach="admin-connector-form"]');
    await expect(form.getByText('Atlassian (Jira Administration)')).toBeVisible();
    // The classic-scope setup note is the one thing an operator must not miss.
    await expect(form.getByText(/Classic scopes/)).toBeVisible();
    await expect(form.getByText('Read access & space details')).toBeVisible();
    await expect(form.getByText('Site configuration')).toBeVisible();
    // Every box starts ticked; this org holds the newest back, so its people
    // cannot pick it (below) until an admin ticks it here.
    const newest = form.getByRole('checkbox', { name: /Space components, versions and screens/ });
    await expect(newest).toBeChecked();
    await newest.uncheck();

    await form.getByLabel('Client ID').fill('e2e-admin-client');
    await form.getByLabel('Client secret').fill('e2e-admin-secret');
    // On, whatever an earlier run left it at.
    await form.getByRole('checkbox', { name: 'Enabled', exact: true }).check();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByText('Saved')).toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, 'jira-admin-01-registered');

    // Saved for real: a reload shows the stored secret as stored, never its value.
    await page.reload();
    await expect(form.getByLabel('Client secret')).toHaveAttribute(
      'placeholder',
      'Stored — leave blank to keep'
    );
    const stored = await connectorConfig(page.request, 'atlassian-admin');
    expect(stored.enabled).toBe(true);
    expect(String(stored.scopes).split(' ').sort()).toEqual(
      ['manage:jira-configuration', 'offline_access', 'read:jira-user', 'read:jira-work'].sort()
    );

    // --- The person connects it from its card. ---
    await addConnectors(page.request, ['jira-admin']);
    await page.goto(`/connectors`);
    const panel = page.locator('[data-coach="card-jira-admin"]');
    await expect(panel.getByRole('heading', { name: 'Jira Administration' })).toBeVisible();
    await expect(panel.getByText('Not connected')).toBeVisible();

    // The live picker narrows the classic scopes before any round trip:
    // leaving out site configuration drops manage:jira-configuration from
    // the authorize link.
    await panel.getByText(/What Renkei may do/).click();
    // What the org held back is not even offered.
    await expect(
      panel.getByRole('checkbox', { name: /Space components, versions and screens/ })
    ).toHaveCount(0);
    const connect = panel.getByRole('link', { name: 'Connect Jira Administration' });
    await expect(connect).toHaveAttribute('href', /manage%3Ajira-configuration/);
    await panel.getByRole('checkbox', { name: /Site configuration/ }).uncheck();
    await expect(connect).not.toHaveAttribute('href', /manage%3Ajira-configuration/);
    await shot(page, testInfo, 'jira-admin-02-narrowed');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, testInfo, 'jira-admin-02-narrowed-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // The authorize route turns the narrowed choice into Atlassian's consent
    // redirect — read with redirects off, so nothing leaves this machine.
    const href = await connect.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/api/atlassian-admin/authorize`));
    const authorize = await page.request.get(href ?? '', { maxRedirects: 0 });
    expect([302, 307]).toContain(authorize.status());
    const consent = new URL(authorize.headers()['location'] ?? '');
    expect(consent.origin + consent.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(consent.searchParams.get('client_id')).toBe('e2e-admin-client');
    expect(consent.searchParams.get('scope')?.split(' ').sort()).toEqual(
      ['offline_access', 'read:jira-user', 'read:jira-work'].sort()
    );

    // A scope beyond the org's ceiling — the box it held back — is refused,
    // not silently dropped.
    const widened = await page.request.get(
      `/api/atlassian-admin/authorize?scopes=read:jira-work+manage:jira-project`,
      { maxRedirects: 0 }
    );
    expect(widened.status()).toBe(400);

    // Mobile: a resized Chromium viewport, not a device descriptor.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(panel.getByRole('heading', { name: 'Jira Administration' })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Connect Jira Administration' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'jira-admin-04-mobile');
  } finally {
    // As it was: the earlier registration, or none in use.
    const after = await connectorConfig(page.request, 'atlassian-admin');
    // Nothing to put back when the test stopped before it saved one.
    if (after.configured === true)
      await saveConnectorConfig(page.request, 'atlassian-admin', {
        clientId: before.configured === true ? before.clientId : after.clientId,
        enabled: before.configured === true && before.enabled === true,
        ...(typeof before.scopes === 'string' ? { scopes: before.scopes } : {}),
      });
  }
});
