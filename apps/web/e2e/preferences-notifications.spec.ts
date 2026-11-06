/**
 * Notification preferences save card by card, in a browser: a change
 * brings up Save on its own card and no other, pressing it sends one PATCH
 * to /api/preferences carrying only that card's fields, "Saved." shows there, and
 * the change is still there after a reload. What each card sends and when
 * its Save shows is preferences-form.model.test.ts's.
 */

import { test, expect } from './fixtures';

test('a card saves its own change, and only its card offers Save', async ({
  page,
  person: _person,
}) => {
  await page.goto('/preferences');
  const card = (name: string) =>
    page
      .getByRole('region', { name: 'Notifications' })
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) });
  const popups = card('Pop-ups');
  const browser = card('Browser notifications');

  // Untouched, no card carries a Save.
  await expect(popups.getByRole('button', { name: 'Save' })).toHaveCount(0);

  await popups.getByRole('radio', { name: 'Bottom left' }).check();
  await expect(popups.getByRole('button', { name: 'Save' })).toBeEnabled();
  await expect(browser.getByRole('button', { name: 'Save' })).toHaveCount(0);

  const patch = page.waitForRequest(
    (request) => request.method() === 'PATCH' && request.url().endsWith('/api/preferences')
  );
  await popups.getByRole('button', { name: 'Save' }).click();
  const sent: { notifications: Record<string, unknown> } = (await patch).postDataJSON();
  expect(sent).toEqual({ notifications: { toastsEnabled: true, toastCorner: 'bottom-left' } });
  await expect(popups.getByRole('status')).toHaveText('Saved.');

  await page.reload();
  await expect(card('Pop-ups').getByRole('radio', { name: 'Bottom left' })).toBeChecked();
  await expect(card('Pop-ups').getByRole('button', { name: 'Save' })).toHaveCount(0);
});
