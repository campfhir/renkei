/**
 * The Code page's project list in a browser: a README-derived description
 * appearing on the next visit for a project made without one, search
 * narrowing the list, and paging through more than one page. The rules
 * (what matches, how pages clamp) are code-index.model.test.ts's; the
 * summary's are lib/code/readme-summary.test.ts's.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';

const SHOTS = process.env.E2E_SHOTS;

test('the Code page searches, pages, and describes projects from their README', async ({
  page,
}, testInfo) => {
  await prepareCodeHost(page.request);
  await connectBitbucket(page);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const names: string[] = [];
  for (let i = 1; i <= 13; i += 1) {
    const name = `Project ${String(i).padStart(2, '0')} ${tag}`;
    names.push(name);
    await createCodeProject(page.request, {
      name,
      repository: `acme/billing-${tag}-${i}`,
      branch: 'main',
      ...(i === 1 ? { description: 'Typed by hand: the invoicing front end.' } : {}),
    });
  }
  const main = page.getByRole('main');

  // First visit starts the fill after the response; the next shows it.
  await page.goto('/code');
  await expect(main.getByRole('searchbox', { name: 'Search code projects' })).toBeVisible();
  await expect
    .poll(async () => {
      await page.reload();
      return main.getByText('Invoices, dunning and the nightly jobs.').count();
    })
    .toBeGreaterThan(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-list.png` });

  // Paging: ten a page, the pager riding the bottom edge of the frame.
  const frame = main.getByRole('group', { name: 'Code projects' });
  const rows = frame.locator('tbody tr:not([aria-hidden])');
  await expect(rows).toHaveCount(10);
  await expect(frame.getByText('Projects 1–10 of 13')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1b-pager.png` });
  await frame.getByRole('link', { name: 'Next →' }).click();
  await expect(page).toHaveURL(/\/code\?page=2$/);
  await expect(rows).toHaveCount(3);
  await expect(frame.getByText('Projects 11–13 of 13')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-page-two.png` });

  // Search by the hand-typed description: in the URL, back on page one.
  const search = main.getByRole('searchbox', { name: 'Search code projects' });
  await search.fill('invoicing');
  await expect(page).toHaveURL(/\/code\?q=invoicing$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByText(names[0]!)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-search.png` });

  // Nothing matching says so.
  await search.fill('zzzz-nothing');
  await expect(main.getByText('No projects match your search.')).toBeVisible();

  // Phone width: cards, not a table, the pager still at the bottom.
  await search.fill('');
  await expect(rows).toHaveCount(10);
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = frame.getByRole('list', { name: 'Code projects' }).locator('li:not([aria-hidden])');
  await expect(cards).toHaveCount(10);
  await expect(frame.locator('table')).toBeHidden();
  await frame.getByRole('navigation', { name: 'Code project pages' }).scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-phone.png` });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBe(true);
});
