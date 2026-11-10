/**
 * My usage renders on the real server: the same buckets Organization usage
 * charts (tokens by surface, the activity calendar, tokens by model, top
 * agents, top tools) for the signed-in person, one chat of theirs end to
 * end onto the model board, the chart's series switch, a longer window
 * re-read, and the phone-width fit.
 *
 * That the report is the session's alone — another person's millions of
 * tokens reach no figure, no name and no ranking, even for an operator —
 * is app/(app)/utilization/actions.test.ts on the memory store.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { createChat, send } from './support/chat';
import { addStubModel, removeModel, scripted } from './support/stub-model';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const COLD = { timeout: 30_000 };

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      name
    ),
    fullPage: true,
  });
}

test('my usage charts my own buckets', async ({ page, person: _person }, testInfo) => {
  const tag = `${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag, { label: `Usage model ${tag}` });
  try {
    // Mine: 4,000 tokens in and 1,000 out.
    const mine = await createChat(page.request, { llmModelId: modelId, title: 'My chat' });
    await send(
      page.request,
      mine,
      scripted('hello', [{ text: 'Hi.', usage: { input: 4000, output: 1000 } }]),
      modelId
    );

    await page.goto('/utilization');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'My usage' })).toBeVisible(COLD);

    // The org page's buckets, for me: the surface split, calendar, models, agents and tools.
    await expect(main.getByRole('heading', { name: 'Tokens by surface' })).toBeVisible();
    await expect(main.getByText('Active days')).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Tokens by model' })).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Top agents' })).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Top tools' })).toBeVisible();
    // My model is on the board.
    const models = main.locator('section, div').filter({
      has: page.getByRole('heading', { name: 'Tokens by model' }),
    });
    await expect(models.getByText(`stub-model · openai`).first()).toBeVisible();

    // The chart is the surface-stacked one, with a switch for each series.
    const chart = main.locator('figure').filter({
      has: page.getByRole('button', { name: 'Agent runs', exact: true }),
    });
    await expect(chart.getByText('Chat projects')).toBeVisible();
    await expect(chart.getByRole('button', { name: 'Tokens', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await chart.getByRole('button', { name: 'Tool calls', exact: true }).click();
    await expect(chart.getByRole('button', { name: 'Tool calls', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await chart.getByRole('button', { name: 'Tokens', exact: true }).click();

    // A longer window re-reads in the same scope.
    await main.getByRole('button', { name: '90 days' }).click();
    await expect(main.getByText('Over the last 90 days')).toBeVisible();
    await shot(page, testInfo, 'my-usage-buckets.png');

    // Phone width.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(main.getByRole('heading', { name: 'Top tools' })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);
    await shot(page, testInfo, 'my-usage-buckets-mobile.png');
  } finally {
    await removeModel(page.request, modelId);
  }
});
