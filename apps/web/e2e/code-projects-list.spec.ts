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

  // Paging: ten a page.
  const mine = main.locator('section', { has: page.getByRole('heading', { name: 'Mine' }) });
  await expect(mine.locator('li')).toHaveCount(10);
  await expect(mine.getByText('1–10 of 13')).toBeVisible();
  await mine.getByRole('navigation', { name: 'Mine pages' }).scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1b-pager.png` });
  await mine.getByRole('button', { name: 'Next' }).click();
  await expect(mine.locator('li')).toHaveCount(3);
  await expect(mine.getByText('11–13 of 13')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-page-two.png` });

  // Search by the hand-typed description, back on page one.
  await main.getByRole('searchbox', { name: 'Search code projects' }).fill('invoicing');
  await expect(mine.locator('li')).toHaveCount(1);
  await expect(mine.getByText(names[0]!)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-search.png` });

  // Nothing matching says so.
  await main.getByRole('searchbox', { name: 'Search code projects' }).fill('zzzz-nothing');
  await expect(main.getByText('No projects match your search.').first()).toBeVisible();

  // Phone width.
  await main.getByRole('searchbox', { name: 'Search code projects' }).fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(mine.locator('li')).toHaveCount(10);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-phone.png` });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBe(true);
});
