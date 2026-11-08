/**
 * The agents page's "In flight" overview, end to end on the in-memory app:
 * an agent whose run is parked on a question shows above the cards as
 * waiting on you, an agent that never ran shows idle, and the waiting
 * row's link opens that agent's runs — now a table — filtered to the
 * waiting run. Then the same page at phone width, where the overview is
 * cards instead of a table, without sideways scroll.
 * And the overview and the cards each paging ten at a time through the
 * URL, each pager keeping the other's place.
 *
 * What each row says (stuck, needs you, ages, order) is
 * agents-overview.model.test.ts's; paging is agents-page.model.test.ts's
 * and runs-page.model.test.ts's. This walks the one path a model cannot:
 * real runs counted by the store, drawn by the server, opened by a click.
 *
 * Agents are the fresh person's own, so the overview holds only this
 * spec's agents; their names carry the tag because names are unique org-wide.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { createAgent, runAgent } from './support/agents';
import { addStubModel, removeModel, stubScript, toolStep } from './support/stub-model';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('the agents page shows what each agent has in flight, and opens the runs behind it', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const asking = `Asks first ${tag}`;
    const idle = `Never run ${tag}`;
    const askingId = await createAgent(page.request, {
      name: asking,
      llmModelId: modelId,
      canAskQuestions: true,
      instructions: `## Goal\n\nCheck with the owner first.\n\n${stubScript([
        toolStep('ask_person', {
          questions: [
            {
              question: 'Go ahead with the sweep?',
              answer: { type: 'choice', options: ['Yes', 'No'] },
            },
          ],
        }),
      ])}`,
    });
    await createAgent(page.request, { name: idle, llmModelId: modelId, instructions: 'Idle.' });
    const runId = await runAgent(page.request, askingId);

    const overview = page.getByRole('region', { name: 'In flight' });
    const askingRow = overview.getByRole('row').filter({ hasText: asking });
    // The run reaches its question in the worker; reload until the page counts it.
    await expect(async () => {
      await page.goto('/agents');
      await expect(askingRow).toContainText('1 waiting', { timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await expect(askingRow).toContainText('Needs you');
    await expect(overview).toContainText('1 run in flight — 1 waiting on you.');
    const idleRow = overview.getByRole('row').filter({ hasText: idle });
    await expect(idleRow).toContainText('Nothing in flight');
    await expect(idleRow).toContainText('Idle');
    // Needing attention sorts first: the waiting agent's row above the idle one.
    await expect(overview.getByRole('row').nth(1)).toContainText(asking);

    // Above the cards, as asked: the overview comes before the agent list.
    const overviewBox = await overview.boundingBox();
    const cardBox = await page.getByRole('main').getByText(idle).last().boundingBox();
    expect(overviewBox && cardBox && overviewBox.y < cardBox.y).toBe(true);

    await askingRow.getByRole('link', { name: asking }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${askingId}/runs\\?status=waiting$`));
    const table = page.getByRole('main').getByRole('table');
    await expect(table.getByRole('columnheader', { name: 'Status' })).toBeVisible();
    const runRow = table.getByRole('row').nth(1);
    await expect(runRow).toContainText('Waiting');
    await runRow.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/agents/${askingId}/runs/${runId}$`));

    // Phone width: the overview turns from a table into cards, and nothing
    // scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/agents');
    await expect(overview.getByRole('table')).toBeHidden();
    const askingCard = overview
      .getByRole('list', { name: 'Agents in flight' })
      .getByRole('listitem')
      .filter({ hasText: asking });
    await expect(askingCard).toContainText('1 waiting');
    await expect(askingCard).toContainText('Needs you');
    await expect(askingCard.getByRole('link')).toHaveAttribute(
      'href',
      `/agents/${askingId}/runs?status=waiting`
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('the overview and the agent cards page ten at a time, each keeping the other’s place', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  // Eleven agents, never run: all idle, so the overview orders them by
  // name, and the eleventh starts a second page of each list.
  for (let n = 1; n <= 11; n += 1) {
    await createAgent(page.request, {
      name: `Paged ${String(n).padStart(2, '0')} ${tag}`,
      instructions: 'Idle.',
    });
  }

  await page.goto('/agents');
  const overview = page.getByRole('region', { name: 'In flight' });
  const overviewPages = page.getByRole('navigation', { name: 'In flight pages' });
  const cardList = page.locator('#agents-list');
  const cardPages = page.getByRole('navigation', { name: 'Agent pages' });

  // A header row plus ten.
  await expect(overview.getByRole('row')).toHaveCount(11);
  await expect(overviewPages).toContainText('Agents 1–10 of 11');
  await expect(cardList.getByRole('switch')).toHaveCount(10);
  await expect(cardPages).toContainText('Agents 1–10 of 11');

  // Where the pager sits on the page (not in the viewport: clicking Next on
  // a phone scrolls it into view first, and paging keeps that scroll).
  const pagerTop = () =>
    overviewPages.evaluate((nav) => nav.getBoundingClientRect().top + window.scrollY);
  const firstPageTop = await pagerTop();

  await overviewPages.getByRole('link', { name: 'Next →' }).click();
  await expect(page).toHaveURL(/\/agents\?inflight=2$/);
  await expect(overview.getByRole('row')).toHaveCount(2);
  // One agent on this page, yet the table keeps its height: the pager has
  // not moved (the blank rows padding it are hidden from assistive tech,
  // so the row count above is still header plus one).
  expect(await pagerTop()).toBe(firstPageTop);
  await expect(overview.getByRole('row').nth(1)).toContainText(`Paged 11 ${tag}`);
  await expect(overviewPages).toContainText('Agents 11–11 of 11');
  // The cards stayed on their first page.
  await expect(cardList.getByRole('switch')).toHaveCount(10);

  await cardPages.getByRole('link', { name: 'Next →' }).click();
  await expect(page).toHaveURL(/\/agents\?inflight=2&page=2#agents-list$/);
  await expect(cardList.getByRole('switch')).toHaveCount(1);
  // The cards keep their own order, newest first: the oldest is the one left over.
  await expect(cardList).toContainText(`Paged 01 ${tag}`);
  // And the overview kept its second page.
  await expect(overviewPages).toContainText('Agents 11–11 of 11');

  await cardPages.getByRole('link', { name: '← Previous' }).click();
  await expect(page).toHaveURL(/\/agents\?inflight=2#agents-list$/);
  await expect(cardList.getByRole('switch')).toHaveCount(10);

  // At phone width too, the overview's pager holds still between pages.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/agents');
  const cards = overview.getByRole('list', { name: 'Agents in flight' }).getByRole('listitem');
  await expect(overviewPages).toContainText('Agents 1–10 of 11');
  await expect(cards).toHaveCount(10);
  const phoneFirstTop = await pagerTop();
  await overviewPages.getByRole('link', { name: 'Next →' }).click();
  await expect(overviewPages).toContainText('Agents 11–11 of 11');
  // One card, its nine blank stand-ins hidden from assistive tech.
  await expect(cards).toHaveCount(1);
  expect(await pagerTop()).toBe(phoneFirstTop);
});
