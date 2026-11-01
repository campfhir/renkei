/**
 * The escape hatch: an operator switches the guided tours off for the
 * whole organization (Organization → Settings → Guided tours) and the
 * pages the server renders say so — a `?tour=` link draws nothing, the
 * Tutorials door leaves the account menu, the Tutorials page says why,
 * and the settings page shows the switch off.
 *
 * That with the switch off nothing starts — unasked, by a link or by
 * Start — is a rule of the engine's step machine, tested in node
 * (components/coach-marks/provider.model.test.ts: `decideStart` and
 * `planStartTour` with `enabled: false`), so this file no longer waits
 * out the auto-start delay to see that nothing came.
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
import { createPerson, signIn } from './support/person';
import { holdExclusive } from './support/org-lock';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: false,
  });
}

/**
 * Flip the switch. Each server bundle reads org settings through a cache
 * of its own, a minute long in production; the suite runs with it at zero
 * (playwright.config.ts), so the next render already says so.
 */
async function setTours(page: Page, on: boolean): Promise<void> {
  const written = await page.request.put('/api/admin/org-settings', {
    data: { coachMarksEnabled: on },
  });
  expect(written.ok(), await written.text()).toBe(true);
}

test('with the org switch off, no tour runs and the Tutorials door is closed', async ({
  page,
  request,
}, testInfo) => {
  // An operator (the settings page is theirs) with the tours left on.
  const person = await createPerson(request, {
    roles: ['renkei-user', 'renkei-operator'],
    coachMarks: true,
  });
  await signIn(page.context(), person);
  const release = await holdExclusive('tours');
  try {
    await setTours(page, false);

    // A link that asks for the welcome tour by name. With the switch on it
    // would start the moment the page hydrated (no delay for a request);
    // by the time the account menu answers a press the engine has had its
    // say, and the switch said no.
    await page.goto(`/?tour=welcome`);
    await expect(page.getByRole('heading', { level: 1, name: 'Actionable items' })).toBeVisible();
    await page.getByRole('button', { name: 'Account menu' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Preferences' })).toBeVisible();
    await expect(page.getByTestId('coach-mark')).toHaveCount(0);
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
