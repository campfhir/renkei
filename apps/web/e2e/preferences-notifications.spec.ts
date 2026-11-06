/**
 * Notification preferences save card by card, in a browser: a change
 * brings up Save on its own card and no other, pressing it sends one PUT
 * to /api/preferences with that card's change, "Saved." shows there, and
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

  const put = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith('/api/preferences')
  );
  await popups.getByRole('button', { name: 'Save' }).click();
  const sent: { notifications: { toastCorner: string } } = (await put).postDataJSON();
  expect(sent.notifications.toastCorner).toBe('bottom-left');
  await expect(popups.getByRole('status')).toHaveText('Saved.');

  await page.reload();
  await expect(card('Pop-ups').getByRole('radio', { name: 'Bottom left' })).toBeChecked();
  await expect(card('Pop-ups').getByRole('button', { name: 'Save' })).toHaveCount(0);
});
