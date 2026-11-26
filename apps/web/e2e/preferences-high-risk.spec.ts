/**
 * The high-risk lists, in a browser: a tool the organization locks shows
 * switched on and unchangeable on a person's Code projects list, a switch
 * the person flips is saved by Save and read back after a reload, and the
 * operators' card on Settings sends the whole locked list.
 *
 * The lists' rules (defaults per kind, a locked tool held on through
 * "all", Save on only when something changed, the departures Save sends)
 * are preferences/high-risk-form.model.test.ts's; the routes' are
 * app/api/preferences/high-risk/route.test.ts's and
 * app/api/admin/high-risk-tools/route.test.ts's; what the lists do to an
 * agent batch or an Auto-mode turn is the engine's and the runner's tests.
 */

import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

// Pinning the organization's locked list is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

/**
 * The organization's locked list is shared by every test on the server,
 * so every spec writes it the same: one code tool no other spec calls.
 */
const LOCKED = ['code_git_reset'];

async function pinLocked(request: APIRequestContext): Promise<void> {
  const response = await request.put('/api/admin/high-risk-tools', { data: { tools: LOCKED } });
  expect(response.ok(), await response.text()).toBe(true);
}

test('Code projects: a locked tool stays on, and a tool I mark is saved and read back', async ({
  page,
  person: _person,
}) => {
  await pinLocked(page.request);
  await page.goto('/preferences/code');
  const card = page.getByRole('region', { name: 'High risk in Auto mode' });
  await expect(card).toBeVisible();

  await card.getByLabel('Filter tools').fill('code_git_');
  const reset = card.getByRole('checkbox', { name: /\(code_git_reset\) — high risk/ });
  await expect(reset).toBeChecked();
  await expect(reset).toBeDisabled();
  const push = card.getByRole('checkbox', { name: /\(code_git_push\) — high risk/ });
  // The checkout's own work runs unasked by default.
  await expect(push).not.toBeChecked();

  await push.check();
  const saved = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith('/api/preferences/high-risk')
  );
  await card.getByRole('button', { name: 'Save' }).click();
  expect((await saved).postDataJSON()).toEqual({
    kind: 'code',
    marked: ['code_git_push'],
    unmarked: [],
  });
  await expect(card.getByText('Saved.')).toBeVisible();

  await page.reload();
  await card.getByLabel('Filter tools').fill('code_git_push');
  await expect(card.getByRole('checkbox', { name: /\(code_git_push\) — high risk/ })).toBeChecked();
});

test('Settings: the locked list shows what is locked, and Save sends the whole list', async ({
  page,
  person: _person,
}) => {
  await pinLocked(page.request);
  await page.goto('/admin/settings/safety');
  const card = page.getByRole('region', { name: 'Locked high-risk tools' });
  await expect(card).toBeVisible();
  await card.getByLabel('Filter tools').fill('code_git_');
  const reset = card.getByRole('checkbox', { name: /\(code_git_reset\) — locked/ });
  await expect(reset).toBeChecked();
  await expect(reset).toBeEnabled();

  // Answered at the edge: the list is everyone's, and other tests read it
  // while this one runs, so the press is checked without changing it.
  await page.route('**/api/admin/high-risk-tools', async (route) => {
    const body: { tools: string[] } = route.request().postDataJSON();
    await route.fulfill({ json: { tools: body.tools } });
  });
  await card.getByRole('checkbox', { name: /\(code_git_clean\) — locked/ }).check();
  const sent = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith('/api/admin/high-risk-tools')
  );
  await card.getByRole('button', { name: 'Save' }).click();
  expect((await sent).postDataJSON()).toEqual({ tools: ['code_git_clean', 'code_git_reset'] });
  await expect(card.getByText('Saved.')).toBeVisible();
});
