/**
 * The file-share admin registry, end to end in a browser, with the SFTP
 * host-key pin (docs/fileshares-connector-design.md, "Host keys"): the
 * create form shows the fingerprint field for SFTP only and validates a
 * pasted fingerprint live; a pinned key is stored and read back on the
 * share's page as the key on file; clearing it returns the share to
 * trust-on-first-use, which the page says plainly. No fileshare worker
 * runs here, so the live handshake itself is the integration suite's
 * (packages/connector-fileshares sftp.integration.test.ts); this spec
 * drives the real admin routes against the dev database.
 *
 * Own tenant per project (AGENTS.md's rule for a spec that writes data):
 * projects run concurrently against the same Postgres, and the share name
 * is unique per tenant.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note); "mobile" is a resized viewport rather than
 * the `mobile` project's device descriptor, per AGENTS.md.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** A well-formed SHA256 host-key fingerprint, as `ssh-keygen -lf` prints one. */
const FINGERPRINT = 'SHA256:zgO0mL4RkHlb6yVSZS1Bz0Ys7gs0Ia0ZLyTRpFH9bXw';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** A deterministic (stable across reruns), valid-looking v4 UUID from a seed string. */
function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function fixtureFor(projectName: string): {
  sessionId: string;
  slug: string;
  subject: string;
} {
  return {
    sessionId: uuidFrom(`fileshares-e2e-session:${projectName}`),
    slug: `e2e-fileshares-${projectName}`,
    subject: `e2e-fileshares-${projectName}@example.com`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;

async function seedTenant(fixture: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM file_shares');
    await client.query('DELETE FROM user_encryption_keys WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM user_preferences WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM identities WHERE subject = $1', [fixture.subject]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at)\n       VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user', 'renkei-operator'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name)\n       VALUES ($1, $2, $3)`,
      [fixture.subject, fixture.subject, 'E2E Tester']
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)\n       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.subject]
    );
    // Enrolled already, so the first-sign-in "your encryption key is ready"
    // dialog does not sit over the form.
    await enrollForE2E(client, fixture.subject);
  } finally {
    await client.end();
  }
}

async function storedFingerprint(fixture: Fixture, name: string): Promise<string | null> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query<{ host_key_fingerprint: string | null }>(
      'SELECT host_key_fingerprint FROM file_shares WHERE name = $1',
      [name]
    );
    return result.rows[0]?.host_key_fingerprint ?? null;
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session`,
      value: fixture.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('admin: an SFTP share pins its host key, shows it on file, and can return to trust-on-first-use', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/admin/file-shares`);
  await expect(page.getByRole('heading', { name: 'File shares', exact: true })).toBeVisible();
  await expect(page.getByText('No shares registered yet.')).toBeVisible();

  await page.getByRole('button', { name: '+ New share' }).click();
  // SMB (the default) has no host key, so no field.
  await expect(page.getByLabel('Host key fingerprint (SHA256)')).toHaveCount(0);

  await page.getByLabel('Protocol').selectOption('sftp');
  await page.getByLabel('Name').fill('Reports SFTP');
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
  await expect(page.getByText('Reports SFTP')).toBeVisible();
  expect(await storedFingerprint(fixture, 'Reports SFTP')).toBe(FINGERPRINT);

  // The share's page reads the key on file back.
  await page.getByRole('link', { name: 'Manage' }).click();
  await expect(page.getByRole('heading', { name: 'Reports SFTP' })).toBeVisible();
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
  expect(await storedFingerprint(fixture, 'Reports SFTP')).toBeNull();

  // Phone width: the field and the status still fit.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(status).toBeVisible();
  await expect(page.getByLabel('Host key fingerprint (SHA256)')).toBeVisible();
  await shot(page, testInfo, 'file-shares-03-mobile');
});
