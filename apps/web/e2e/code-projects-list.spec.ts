/**
 * The Code page's project list in a browser: a README-derived description
 * appearing on the next visit for a project made without one, search
 * narrowing the list, and paging through more than one page. The rules
 * (what matches, how pages clamp) are code-index.model.test.ts's; the
 * summary's are lib/code/readme-summary.test.ts's.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { createPerson, signIn } from './support/person';
import { pointerReaches, settled } from './support/settle';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';

const SHOTS = process.env.E2E_SHOTS;

test('the Code page searches, pages, and describes projects from their README', async ({
  page,
  browser,
  request,
}, testInfo) => {
  await prepareCodeHost(page.request);
  await connectBitbucket(page);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const names: string[] = [];
  let firstId = '';
  for (let i = 1; i <= 13; i += 1) {
    const name = `Project ${String(i).padStart(2, '0')} ${tag}`;
    names.push(name);
    const id = await createCodeProject(page.request, {
      name,
      repository: `acme/billing-${tag}-${i}`,
      branch: 'main',
      ...(i === 1 ? { description: 'Typed by hand: the invoicing front end.' } : {}),
    });
    if (i === 1) firstId = id;
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
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-list.png`, caret: 'initial' });

  // Paging: ten a page, the pager riding the bottom edge of the frame.
  const frame = main.getByRole('group', { name: 'Code projects', exact: true });
  const rows = frame.locator('tbody tr:not([aria-hidden])');
  await expect(rows).toHaveCount(10);
  await expect(frame.getByText('Projects 1–10 of 13')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1b-pager.png`, caret: 'initial' });
  // Chrome sends a press by what it last drew; wait until the link hears the pointer.
  const next = frame.getByRole('link', { name: 'Next →' });
  await settled(page);
  await pointerReaches(page, next);
  await next.click();
  await expect(page).toHaveURL(/\/code\?page=2$/);
  await expect(rows).toHaveCount(3);
  await expect(frame.getByText('Projects 11–13 of 13')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-page-two.png`, caret: 'initial' });

  // Search by the hand-typed description: in the URL, back on page one.
  const search = main.getByRole('searchbox', { name: 'Search code projects' });
  await search.fill('invoicing');
  await expect(page).toHaveURL(/\/code\?q=invoicing$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByText(names[0]!)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-search.png`, caret: 'initial' });

  // Nothing matching says so.
  await search.fill('zzzz-nothing');
  await expect(frame.getByText('No projects match your search.')).toBeVisible();

  // Phone width: cards, not a table, the pager still at the bottom.
  await search.fill('');
  await expect(rows).toHaveCount(10);
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = frame.getByRole('list', { name: 'Code projects', exact: true }).locator('li:not([aria-hidden])');
  await expect(cards).toHaveCount(10);
  await expect(frame.locator('table')).toBeHidden();
  await frame.getByRole('navigation', { name: 'Code projects pages' }).scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-phone.png`, caret: 'initial' });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBe(true);

  // Shared: another person sees it under "Shared with me", with its
  // owner's name, and nothing of their own under "Mine".
  const viewer = await createPerson(request, { displayName: 'Shared Viewer' });
  const granted = await page.request.post(`/api/chat/projects/${firstId}/grants`, {
    data: { granteeSubject: viewer.subject, role: 'viewer' },
  });
  expect(granted.ok(), await granted.text()).toBe(true);
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await signIn(context, viewer);
  const viewerPage = await context.newPage();
  try {
    await viewerPage.goto('/code');
    const sharedFrame = viewerPage
      .getByRole('main')
      .getByRole('group', { name: 'Shared code projects', exact: true });
    const sharedRows = sharedFrame.locator('tbody tr:not([aria-hidden])');
    await expect(sharedRows).toHaveCount(1);
    await expect(sharedRows.getByText(names[0]!)).toBeVisible();
    // The owner's own name, not a stand-in.
    await expect(sharedRows.locator('td').nth(2)).not.toHaveText(/^(Someone|)$/);
    await expect(sharedFrame.getByRole('columnheader', { name: 'Owner' })).toBeVisible();
    const ownFrame = viewerPage
      .getByRole('main')
      .getByRole('group', { name: 'Code projects', exact: true });
    await expect(ownFrame.getByText('You have no code projects yet.')).toBeVisible();
    if (SHOTS) await viewerPage.screenshot({ path: `${SHOTS}/5-shared.png`, caret: 'initial' });
  } finally {
    await context.close();
  }
});
