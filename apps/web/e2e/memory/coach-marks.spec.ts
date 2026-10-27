/**
 * The coach marks, end to end: a newcomer lands on the home page and the
 * welcome tour starts on its own; each step is captured; Finish records
 * a completion and the tour stays away; Skip records a dismissal; the
 * Tutorials page behind the avatar shows every tour's state and replays
 * one; "Don't show tutorials" and the page's switch both stop tours
 * starting unasked; and the operator's report shows the rows.
 *
 * One person per project walks the whole file (the tests build on each
 * other's progress), signed in through the suite's sign-in route with
 * the tours left on — every other spec's person has them off — and read
 * back through the coach-mark and preference routes the engine itself
 * reports to. The tours switch is organization-wide, so the file holds
 * the suite's shared lock on it (coach-marks-off.spec.ts flips it).
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test as base, expect, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { MEMORY_BASE_URL } from './constants';
import { createPerson, signIn, type Person } from '../support/person';
import { holdShared, type Release } from '../support/org-lock';

base.describe.configure({ mode: 'serial', timeout: 120_000 });

const CARD = 'coach-mark';
const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  // The spotlight slides between steps (a 200ms transition): let it land.
  await page.waitForTimeout(350);
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    // The overlay is fixed to the viewport; a full-page resize would move it.
    fullPage: false,
  });
}

/** A moment longer than the engine's own half-second delay before a tour starts. */
async function expectNoTour(page: Page): Promise<void> {
  await page.waitForTimeout(1200);
  await expect(page.getByTestId(CARD)).toHaveCount(0);
}

// One person for the whole walk — the tests build on each other's
// progress — made once per project with the tours left on, and the
// suite's lock on the org-wide tours switch held throughout.
let api: APIRequestContext;
let person: Person;
let release: Release;

const test = base.extend<{ signedIn: Person }>({
  signedIn: async ({ page }, use) => {
    await signIn(page.context(), person);
    await use(person);
  },
});

// eslint-disable-next-line no-empty-pattern
base.beforeAll(async ({}, testInfo) => {
  release = await holdShared('tours');
  api = await playwrightRequest.newContext({ baseURL: MEMORY_BASE_URL });
  person = await createPerson(api, {
    roles: ['renkei-user', 'renkei-operator'],
    // Unique, so the report's row is this run's person and no earlier one's.
    displayName: `Coach Tester ${testInfo.project.name.replace('desktop-', '')} ${randomUUID().slice(0, 6)}`,
    coachMarks: true,
  });
});

base.afterAll(async () => {
  await api?.dispose();
  await release?.();
});

/** The person's row for one tour, as the coach-mark route reads it back. */
async function progressOf(tourId: string): Promise<Record<string, unknown> | null> {
  const response = await api.get('/api/coach-marks', { headers: person.headers });
  const body: unknown = await response.json();
  const rows =
    typeof body === 'object' && body !== null && 'progress' in body && Array.isArray(body.progress)
      ? body.progress
      : [];
  const row: unknown = rows.find(
    (entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'tourId' in entry && entry.tourId === tourId
  );
  return typeof row === 'object' && row !== null ? { ...row } : null;
}

async function autoStartPref(): Promise<unknown> {
  const response = await api.get('/api/preferences', { headers: person.headers });
  const body = await response.json();
  return body.coachMarks?.autoStart ?? null;
}

test('the welcome tour greets a newcomer on the home page and records a completion', async ({
  page,
  signedIn: _signedIn,
}, testInfo) => {
  await page.goto(`/`);
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'welcome');
  await expect(card).toHaveAttribute('data-coach-step', 'intro');
  await expect(card).toContainText('1 of 6');
  // An intro has no target: the card sits centred, nothing is spotlit.
  await expect(page.getByTestId('coach-mark-spotlight')).toHaveCount(0);
  await shot(page, testInfo, 'coach-welcome-1-intro');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'feed');
  await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  await shot(page, testInfo, 'coach-welcome-2-feed');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'workspace');
  // The menu is on screen and the light is on it — on a phone because the
  // drawer opens for the step (the hamburger says so), on a desktop because
  // the column stands there anyway.
  const hamburger = page.getByRole('button', { name: /Open menu|Hide menu/ });
  const mobile = testInfo.project.name === 'mobile';
  if (mobile) await expect(hamburger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  await shot(page, testInfo, 'coach-welcome-3-workspace');

  // Back goes back; the arrow keys work too.
  await card.getByRole('button', { name: 'Back' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'feed');
  await page.keyboard.press('ArrowRight');
  await expect(card).toHaveAttribute('data-coach-step', 'workspace');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'chat');
  await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  await shot(page, testInfo, 'coach-welcome-4-chat');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'account');
  await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  // The avatar is in the top bar, not the menu: the drawer the tour opened
  // has gone again.
  if (mobile) await expect(hamburger).toHaveAttribute('aria-expanded', 'false');
  await shot(page, testInfo, 'coach-welcome-5-account');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'done');
  await expect(card).toContainText('6 of 6');
  await shot(page, testInfo, 'coach-welcome-6-done');
  await card.getByRole('button', { name: 'Finish' }).click();
  await expect(card).toHaveCount(0);

  await expect
    .poll(() => progressOf('welcome'), { message: 'the completion is recorded' })
    .toMatchObject({
      status: 'completed',
      stepReached: 5,
      stepsTotal: 6,
      viewCount: 1,
      completedCount: 1,
      dismissedCount: 0,
    });

  // Finished means finished: it does not come back. The next home-page
  // tour (the keyboard shortcuts) takes its place; skip it to leave the
  // home page tour-free for what follows.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Actionable items' })).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'shortcuts');
  await card.getByRole('button', { name: 'Skip tour' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => progressOf('shortcuts')).toMatchObject({ status: 'dismissed' });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Actionable items' })).toBeVisible();
  await expectNoTour(page);
});

test('skipping a tour records the dismissal and where it happened', async ({
  page,
  signedIn: _signedIn,
}, testInfo) => {
  await page.goto(`/agents`);
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'agents');
  await expect(card).toHaveAttribute('data-coach-step', 'new');
  // A tour that started unasked offers the way to stop them all.
  await expect(card.getByRole('button', { name: "Don't show tutorials" })).toBeVisible();
  await shot(page, testInfo, 'coach-agents-1-new');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'import');
  await card.getByRole('button', { name: 'Skip tour' }).click();
  await expect(card).toHaveCount(0);

  await expect
    .poll(() => progressOf('agents'))
    .toMatchObject({
      status: 'dismissed',
      stepReached: 1,
      stepsTotal: 3,
      viewCount: 1,
      completedCount: 0,
      dismissedCount: 1,
    });

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
  await expectNoTour(page);
});

test('Escape skips as well', async ({ page, signedIn: _signedIn }) => {
  await page.goto(`/connectors`);
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'connectors');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => progressOf('connectors'))
    .toMatchObject({
      status: 'dismissed',
      dismissedCount: 1,
    });
});

test('the Tutorials page lists every tour with its state and replays one', async ({
  page,
  signedIn: _signedIn,
}, testInfo) => {
  await page.goto(`/agents`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.getByRole('menu');
  // The door: Tutorials sits with the person's own settings, behind the avatar.
  await expect(menu.getByRole('menuitem', { name: 'Tutorials' })).toBeVisible();
  await shot(page, testInfo, 'coach-account-menu');
  await menu.getByRole('menuitem', { name: 'Tutorials' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();

  await expect(page.getByTestId('tutorial-welcome')).toContainText('Completed');
  await expect(page.getByTestId('tutorial-agents')).toContainText('Skipped');
  await expect(page.getByTestId('tutorial-agents')).toContainText('at step 2 of 3');
  await expect(page.getByTestId('tutorial-connectors')).toContainText('Skipped');
  await expect(page.getByTestId('tutorial-chat')).toContainText('Not started');
  // This person is an operator, so the console's tour is offered too.
  await expect(page.getByTestId('tutorial-admin')).toContainText('Operators');
  await expect(page.getByRole('switch', { name: 'Show tours automatically' })).toBeChecked();
  await shot(page, testInfo, 'coach-tutorials');

  // Replay: back to the home page, tour running, no "don't show" offer —
  // they asked for this one.
  await page.getByTestId('tutorial-welcome').getByRole('button', { name: 'Replay' }).click();
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(card).toHaveAttribute('data-coach-tour', 'welcome');
  await expect(card.getByRole('button', { name: "Don't show tutorials" })).toHaveCount(0);
  await shot(page, testInfo, 'coach-replay');
  await card.getByRole('button', { name: 'Skip tour' }).click();
  await expect(card).toHaveCount(0);

  // The replay is a second pass: the first completion is still counted.
  await expect
    .poll(() => progressOf('welcome'))
    .toMatchObject({
      status: 'dismissed',
      viewCount: 2,
      completedCount: 1,
      dismissedCount: 1,
    });

  // Start, for a tour never taken: the chat's, which begins on a fresh thread.
  await page.goto(`/tutorials`);
  await page.getByTestId('tutorial-chat').getByRole('button', { name: 'Start' }).click();
  // A fresh thread is made on the way: the first visit compiles the chat.
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/chat/[0-9a-f-]{36}`));
  await expect(card).toHaveAttribute('data-coach-tour', 'chat');
  await expect(card).toHaveAttribute('data-coach-step', 'composer');
  await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  await shot(page, testInfo, 'coach-chat-1-composer');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'tools');
  await shot(page, testInfo, 'coach-chat-2-tools');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'model');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'send');
  await shot(page, testInfo, 'coach-chat-4-send');
  await card.getByRole('button', { name: 'Finish' }).click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => progressOf('chat'))
    .toMatchObject({
      status: 'completed',
      completedCount: 1,
    });
});

test('"Don\'t show tutorials" and the switch both stop tours starting unasked', async ({
  page,
  signedIn: _signedIn,
}, testInfo) => {
  // The operator console's tour has not been seen: it starts, and the
  // offer to stop them all is taken.
  await page.goto(`/admin`);
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'admin');
  await shot(page, testInfo, 'coach-admin-console');
  await card.getByRole('button', { name: "Don't show tutorials" }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => autoStartPref()).toBe(false);
  await expect.poll(() => progressOf('admin')).toMatchObject({ status: 'dismissed' });

  // The switch on the Tutorials page reads the change, and flips it back.
  await page.goto(`/tutorials`);
  const toggle = page.getByRole('switch', { name: 'Show tours automatically' });
  await expect(toggle).not.toBeChecked();
  await shot(page, testInfo, 'coach-tutorials-off');

  // Off: a tour never taken (the Preferences page's) stays away.
  await page.goto(`/preferences`);
  await expect(page.getByRole('heading', { level: 1, name: 'Preferences' })).toBeVisible();
  await expectNoTour(page);

  // On again: it comes.
  await page.goto(`/tutorials`);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => autoStartPref()).toBe(true);
  await page.goto(`/preferences`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'preferences');
  await card.getByRole('button', { name: 'Skip tour' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => progressOf('preferences')).toMatchObject({ status: 'dismissed' });
});

test('the operator report shows who viewed, finished and skipped', async ({
  page,
  signedIn: _signedIn,
}, testInfo) => {
  await page.goto(`/admin/tutorials`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
  // The report has a tour of its own, and this person has auto-start on
  // again: let it greet, skip it, and read the report once the skip is
  // recorded, so the numbers below count it.
  const card = page.getByTestId(CARD);
  await expect(card).toHaveAttribute('data-coach-tour', 'admin-tutorials', { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect.poll(() => progressOf('admin-tutorials')).toMatchObject({ status: 'dismissed' });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
  // The totals count everyone in the tenant — the other projects' people
  // included — so the assertion is on this person's own row.
  const row = page.getByTestId('tutorial-person').filter({ hasText: person.displayName });
  await expect(row).toHaveCount(1);
  // chat completed; welcome (replayed, then skipped), shortcuts, agents,
  // connectors (Escape), admin ("don't show"), preferences and this
  // report's own tour skipped.
  await expect(row.getByTestId('person-completed')).toHaveText('1');
  await expect(row.getByTestId('person-skipped')).toHaveText('7');
  await expect(row.getByTestId('person-in-progress')).toHaveText('0');
  await expect(row.getByText('Welcome to Renkei')).toBeVisible();
  await expect(page.getByTestId('tour-totals-welcome')).toBeVisible();
  await shot(page, testInfo, 'coach-admin-report');

  // Eight tours seen, four chips in the row: the rest are behind "+4",
  // which opens every tour as a table.
  const more = row.getByTestId('person-tours-more');
  await expect(more).toHaveText('+4');
  await more.click();
  const dialog = page.getByRole('dialog');
  // Rendered twice — a table for a desktop, a card list for a phone —
  // and one of the two is on screen.
  const rows = dialog.getByTestId('person-tour').filter({ visible: true });
  await expect(rows).toHaveCount(8);
  await expect(rows.filter({ hasText: 'Chat' })).toContainText('Completed');
  await shot(page, testInfo, 'coach-admin-report-person');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
