/**
 * The file-share admin registry, end to end in a browser, with the SFTP
 * host-key pin (docs/fileshares-connector-design.md, "Host keys"): the
 * create form shows the fingerprint field for SFTP only and validates a
 * pasted fingerprint live; a pinned key is stored and read back on the
 * share's page as the key on file; clearing it returns the share to
 * trust-on-first-use, which the page says plainly. No fileshare worker
 * runs here, so the live handshake itself is the integration suite's
 * (packages/connector-fileshares sftp.integration.test.ts); this spec
 * drives the real admin routes.
 *
 * File shares are organization-wide and every project shares the server:
 * the share's name carries the test's own tag, what is stored is read
 * back through the share's own GET route, and the share is deleted
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

async function storedFingerprint(page: Page, shareId: string): Promise<unknown> {
  const response = await page.request.get(`/api/admin/file-shares/${shareId}`);
  expect(response.ok()).toBe(true);
  const body: { share: { hostKeyFingerprint?: string | null } } = await response.json();
  return body.share.hostKeyFingerprint ?? null;
}

test('admin: an SFTP share pins its host key, shows it on file, and can return to trust-on-first-use', async ({
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
    // SMB (the default) has no host key, so no field.
    await expect(page.getByLabel('Host key fingerprint (SHA256)')).toHaveCount(0);

    await page.getByLabel('Protocol').selectOption('sftp');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Host', { exact: true }).fill('files.corp.example');
    await page.getByLabel('Root path').fill('/srv/reports');
    const fingerprint = page.getByLabel('Host key fingerprint (SHA256)');
    await expect(fingerprint).toBeVisible();
    await expect(page.getByText('recorded here for you to confirm')).toBeVisible();

    // The live verdict uses the same normalization the server does.
    await fingerprint.fill('MD5:aa:bb:cc');
    await expect(page.getByText('Not a SHA256 fingerprint')).toBeVisible();
    await fingerprint.fill(`${FINGERPRINT.slice('SHA256:'.length)}=`);
    await expect(page.getByText(`Pinned as ${FINGERPRINT}`)).toBeVisible();
    await shot(page, testInfo, 'file-shares-01-sftp-draft-pinned');

    await page.getByRole('button', { name: 'Create share' }).click();
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row).toBeVisible();

    // The share's page reads the key on file back.
    await row.getByRole('link', { name: 'Manage' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    const shareId = new URL(page.url()).pathname.split('/').pop() ?? '';
    expect(shareId).toBeTruthy();
    expect(await storedFingerprint(page, shareId)).toBe(FINGERPRINT);
    const status = page.getByTestId('host-key-status');
    await expect(status).toContainText('SSH host key on file');
    await expect(status).toContainText(FINGERPRINT);
    await expect(page.getByLabel('Host key fingerprint (SHA256)')).toHaveValue(FINGERPRINT);
    await shot(page, testInfo, 'file-shares-02-key-on-file');

    // Clearing the pin returns the share to trust-on-first-use, and the page says so.
    // (Settle first: the dev server's double-invoked load effect must not
    // land after the fill and put the stored value back.)
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Host key fingerprint (SHA256)').fill('');
    await expect(page.getByLabel('Host key fingerprint (SHA256)')).toHaveValue('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await expect(status).toContainText('No SSH host key on file yet');
    expect(await storedFingerprint(page, shareId)).toBeNull();

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
