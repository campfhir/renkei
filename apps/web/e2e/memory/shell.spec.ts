/**
 * The app shell on the in-memory data store: signed-in chrome (the
 * person's name from the identity spine, the unread badge from the
 * notification poll — a colleague shared an agent with them, through the
 * agent's own access route), moving between pages from the menu, the
 * theme a saved preference picks (PUT /api/preferences, as the
 * preferences form saves it), a signed-out visitor turned away, and the
 * same at phone width. No database anywhere — see
 * playwright.memory.config.ts.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { shareAgentsWith } from '../support/share-agents';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** The menu on screen: the column on a wide screen, the drawer once opened on a narrow one. */
function sideMenu(page: Page) {
  return page.getByRole('navigation', { name: 'Application' }).filter({ visible: true });
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('the shell carries the person and moves between pages from the menu', async ({
  page,
  request,
  person,
}, testInfo) => {
  const [{ headline }] = await shareAgentsWith(request, person, ['Weekly digest']);

  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'What’s changed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account menu' })).toHaveAttribute(
    'title',
    person.displayName
  );
  await expect(page.getByLabel('1 unread notification')).toBeVisible();
  await shot(page, testInfo, 'shell-01-about');

  // Notifications and About sit in the account menu; Home in the side menu.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: /^Notifications/ }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  // On the page itself — the same row may also be up as a toast.
  await expect(page.getByRole('main').getByText(headline)).toBeVisible();

  await sideMenu(page).getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'About' }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole('heading', { name: 'What’s changed' })).toBeVisible();
});

test('a saved theme preference sets the page theme', async ({ page, person: _person }) => {
  const saved = await page.request.put('/api/preferences', { data: { theme: { mode: 'dark' } } });
  expect(saved.ok()).toBe(true);
  await page.goto('/about');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('a visitor without a session is sent to sign in, and back here after', async ({ request }) => {
  const response = await request.get('/notifications', { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  const location = new URL(response.headers().location ?? '', 'http://127.0.0.1');
  expect(location.pathname).toBe('/api/auth/oidc/login');
  expect(location.searchParams.get('redirect')).toBe('/notifications');
});

test('at phone width the menu is a drawer that navigates', async ({
  page,
  person: _person,
}, testInfo) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'What’s changed' })).toBeVisible();
  await shot(page, testInfo, 'shell-02-about-mobile');

  await page.getByRole('button', { name: 'Open menu' }).click();
  await sideMenu(page).getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: /^Notifications/ }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await shot(page, testInfo, 'shell-03-notifications-mobile');
});
