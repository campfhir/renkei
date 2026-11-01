/**
 * The Bitbucket connector form's webhook instructions, as an administrator
 * reads them on the real server and at a phone's width: the copy names
 * the `X-Renkei-Webhook-Secret` header as the way to carry the shared
 * secret (lib/bitbucket-webhook.ts), with the URL form mentioned only as
 * the legacy fallback. Read-only — nothing is saved.
 *
 * The rules behind it — the instructions while no secret is stored, the
 * "stored" note once one is, the header matching the one the webhook
 * route reads, the secret sent only when typed — are
 * app/(app)/admin/connectors/forms/app-registration-form.model.test.ts.
 */

import { test, expect } from './fixtures';

// The connector forms are an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('the Bitbucket form tells admins to send the webhook secret as a header', async ({
  page,
  person: _person,
}) => {
  await page.goto(`/admin/connectors/atlassian-bitbucket`);
  const secretField = page.getByLabel(/Webhook secret/);
  await expect(secretField).toBeVisible();
  // The paragraph, not the <code> inside it: the header name is rendered as
  // code, the guidance around it as prose.
  const hint = page.getByText(/so prefer the header/);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('X-Renkei-Webhook-Secret');
  // The URL form is still described, as the fallback it now is.
  await expect(hint).toContainText('?secret=');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(hint).toBeVisible();
});
