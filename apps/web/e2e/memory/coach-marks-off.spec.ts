/**
 * The escape hatch: an operator switches the guided tours off for the
 * whole organization (Organization → Settings → Guided tours) and every
 * tour goes away at once — nothing starts unasked, a `?tour=` link does
 * nothing, the Tutorials door leaves the account menu, and the Tutorials
 * page says why.
 *
 * The person has the tours left on for themselves, so it is the org
 * switch that keeps them away. The switch is organization-wide: the test
 * holds the suite's exclusive lock on it (e2e/support/org-lock.ts) — the
 * tour specs hold it shared — flips it through the settings route, and
 * puts it back on afterwards.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { createPerson, signIn } from '../support/person';
import { holdExclusive } from '../support/org-lock';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: false,
  });
}

/**
 * Flip the switch, then wait until the pages say so: they read org
 * settings through a cache of their own (up to a minute), so the change
 * reaches them a little after the save does.
 */
async function setTours(page: Page, on: boolean): Promise<void> {
  // A busy server can drop a connection now and then: say it again until it lands.
  await expect(async () => {
    const written = await page.request.put('/api/admin/org-settings', {
      data: { coachMarksEnabled: on },
    });
    expect(written.ok(), await written.text()).toBe(true);
  }).toPass({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const tutorials = await page.request.get('/tutorials');
        return (await tutorials.text()).includes('data-testid="tutorials-off"');
      },
      { timeout: 90_000, intervals: [2_000] }
    )
    .toBe(!on);
}

test('with the org switch off, no tour runs and the Tutorials door is closed', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  // An operator (the settings page is theirs) with the tours left on.
  const person = await createPerson(request, {
    roles: ['renkei-user', 'renkei-operator'],
    coachMarks: true,
  });
  await signIn(page.context(), person);
  const release = await holdExclusive('tours');
  try {
    await setTours(page, false);

    // The welcome tour would greet a newcomer here; the switch says no.
    await page.goto(`/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Actionable items' })).toBeVisible();
    await page.waitForTimeout(1200);
    await expect(page.getByTestId('coach-mark')).toHaveCount(0);

    // Nor does a link that asks for one by name.
    await page.goto(`/?tour=welcome`);
    await expect(page.getByRole('heading', { level: 1, name: 'Actionable items' })).toBeVisible();
    await page.waitForTimeout(1200);
    await expect(page.getByTestId('coach-mark')).toHaveCount(0);

    const menu = page.getByRole('menu');
    // The page may still be settling (hydrating, dropping the query): open
    // the menu until it stays open.
    await expect(async () => {
      if ((await menu.count()) === 0) {
        await page.getByRole('button', { name: 'Account menu' }).click();
      }
      await expect(menu.getByRole('menuitem', { name: 'Preferences' })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 30_000 });
    await expect(menu.getByRole('menuitem', { name: 'Tutorials' })).toHaveCount(0);
    await shot(page, testInfo, 'coach-off-account-menu');
    await page.keyboard.press('Escape');

    // The page itself still answers, and says why there is nothing to start.
    await page.goto(`/tutorials`);
    await expect(page.getByTestId('tutorials-off')).toBeVisible();
    await expect(page.getByRole('button', { name: /Start|Replay/ })).toHaveCount(0);
    await shot(page, testInfo, 'coach-off-tutorials');

    // Where the switch lives.
    await page.goto(`/admin/settings`);
    const toggle = page.getByRole('switch', { name: 'Guided tours' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'coach-off-org-switch');
  } finally {
    try {
      await setTours(page, true);
    } finally {
      await release();
    }
  }
});
