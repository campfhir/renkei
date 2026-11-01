/**
 * The file-share admin registry in a browser, with the SFTP host-key pin
 * (docs/fileshares-connector-design.md, "Host keys"): from the empty
 * state, an SFTP share with a pasted fingerprint is created through the
 * form — the one press through to the real create route — and its page
 * reads the key on file back, at desktop and phone width. No fileshare
 * worker runs here, so the live handshake itself is the integration
 * suite's (packages/connector-fileshares sftp.integration.test.ts).
 *
 * Where its rules went: the fingerprint field for SFTP only, the live
 * verdict on a pasted fingerprint and root path, the protocol switch and
 * what Create or Save sends are
 * app/(app)/admin/file-shares/share-config-fields.model.test.ts; the
 * host-key status (on file, or first use after clearing it) and a late
 * load not clobbering an edit are
 * app/(app)/admin/file-shares/[shareId]/share-config-form.model.test.ts;
 * that a fingerprint is stored normalized, cleared back to
 * trust-on-first-use, and a malformed one refused is
 * app/api/admin/file-shares/[shareId]/route.test.ts.
 *
 * File shares are organization-wide and every project shares the server:
 * the share's name carries the test's own tag, and the share is deleted
 * through its DELETE route afterwards. The empty state is the list route
 * answered empty at the browser edge, since the real list is everybody's.
 *
 * Pinned Chromium; "mobile" is a resized viewport.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** A well-formed SHA256 host-key fingerprint, as `ssh-keygen -lf` prints one. */
const FINGERPRINT = 'SHA256:zgO0mL4RkHlb6yVSZS1Bz0Ys7gs0Ia0ZLyTRpFH9bXw';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('admin: an SFTP share created with its host key pinned shows the key on file', async ({
  page,
  person: _person,
}, testInfo) => {
  const name = `Reports SFTP ${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 6)}`;
  try {
    await page.route('**/api/admin/file-shares', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { shares: [] } })
        : route.fallback()
    );
    await page.goto(`/admin/file-shares`);
    await expect(page.getByRole('heading', { name: 'File shares', exact: true })).toBeVisible();
    await expect(page.getByText('No shares registered yet.')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.unroute('**/api/admin/file-shares');

    await page.getByRole('button', { name: '+ New share' }).click();
    await page.getByLabel('Protocol').selectOption('sftp');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Host', { exact: true }).fill('files.corp.example');
    await page.getByLabel('Root path').fill('/srv/reports');
    // Pasted bare, as some tools print it; stored normalized.
    await page
      .getByLabel('Host key fingerprint (SHA256)')
      .fill(`${FINGERPRINT.slice('SHA256:'.length)}=`);
    await expect(page.getByText(`Pinned as ${FINGERPRINT}`)).toBeVisible();
    await shot(page, testInfo, 'file-shares-01-sftp-draft-pinned');

    await page.getByRole('button', { name: 'Create share' }).click();
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row).toBeVisible();

    // The share's page reads the key on file back.
    await row.getByRole('link', { name: 'Manage' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    const status = page.getByTestId('host-key-status');
    await expect(status).toContainText('SSH host key on file');
    await expect(status).toContainText(FINGERPRINT);
    await expect(page.getByLabel('Host key fingerprint (SHA256)')).toHaveValue(FINGERPRINT);
    await shot(page, testInfo, 'file-shares-02-key-on-file');

    // Phone width: the field and the status still fit.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(status).toBeVisible();
    await expect(page.getByLabel('Host key fingerprint (SHA256)')).toBeVisible();
    await shot(page, testInfo, 'file-shares-03-mobile');
  } finally {
    // Whatever this test created goes again, found by its own name.
    const listed: { shares: { id: string; name: string }[] } = await (
      await page.request.get('/api/admin/file-shares')
    ).json();
    for (const share of listed.shares.filter((share) => share.name === name)) {
      expect((await page.request.delete(`/api/admin/file-shares/${share.id}`)).ok()).toBe(true);
    }
  }
});
