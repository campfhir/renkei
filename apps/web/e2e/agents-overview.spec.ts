/**
 * The agents page's "In flight" overview, end to end on the in-memory app:
 * an agent whose run is parked on a question shows above the cards as
 * waiting on you, an agent that never ran shows idle, and the waiting
 * row's link opens that agent's runs — now a table — filtered to the
 * waiting run. Then the same page at phone width, without sideways scroll.
 *
 * What each row says (stuck, needs you, ages, order) is
 * agents-overview.model.test.ts's; paging the runs table is
 * runs-page.model.test.ts's. This walks the one path a model cannot: real
 * runs counted by the store, drawn by the server, opened by a click.
 *
 * Agents are the fresh person's own, so the overview holds only this
 * spec's two; their names carry the tag because names are unique org-wide.
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

    // Phone width: the overview still reads, and nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/agents');
    await expect(askingRow).toContainText('1 waiting');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  } finally {
    await removeModel(page.request, modelId);
  }
});
