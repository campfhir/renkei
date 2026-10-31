/**
 * My usage, end to end: the same buckets Organization usage charts (tokens
 * by surface, the activity calendar, tokens by model, top agents, top
 * tools) read for the signed-in person alone, and none of the org's
 * rankings of other people.
 *
 * Scope is the session's, decided server side: a second person spends
 * millions of tokens on the same server, and nothing of it reaches this
 * page — not in a figure, not as a name on a board. The person is an
 * operator on purpose: the one caller who can see everyone on
 * Organization usage still gets only themselves here.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { MEMORY_BASE_URL } from './constants';
import { createPerson } from './support/person';
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

test('my usage charts my own buckets and ranks nobody else', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
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

    // Somebody else's: nine million tokens out, in a chat of their own.
    const other = await createPerson(request, { displayName: `Heavy Spender ${tag}` });
    const theirs = await request.post(`${MEMORY_BASE_URL}/api/chat/chats`, {
      headers: other.headers,
      data: { llmModelId: modelId },
    });
    expect(theirs.status(), await theirs.text()).toBe(201);
    const { chatId } = await theirs.json();
    const asked = await request.post(`${MEMORY_BASE_URL}/api/chat/chats/${chatId}/turns`, {
      headers: other.headers,
      data: {
        text: scripted('spend', [{ text: 'Done.', usage: { input: 1, output: 9_000_000 } }]),
        llmModelId: modelId,
      },
    });
    expect(asked.status(), await asked.text()).toBe(202);
    // Let their reply land before looking, so its absence means something.
    await expect
      .poll(async () => {
        const view = await request.get(`${MEMORY_BASE_URL}/api/chat/chats/${chatId}`, {
          headers: other.headers,
        });
        return (await view.json()).chat.activeTurn;
      }, COLD)
      .toBeNull();

    await page.goto('/utilization');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'My usage' })).toBeVisible(COLD);

    // The org page's buckets, for me: the surface split, calendar, models, agents and tools.
    await expect(main.getByRole('heading', { name: 'Tokens by surface' })).toBeVisible();
    await expect(main.getByText('Active days')).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Tokens by model' })).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Top agents' })).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Top tools' })).toBeVisible();
    // My model is on the board with my tokens; nobody else's spend is in it.
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

    // Other people's spend is nowhere: not in the tiles, not as a name, not as a ranking.
    await expect(main).not.toContainText(/\b9(\.\d)?M\b/);
    await expect(main).not.toContainText('Heavy Spender');
    for (const heading of ['Top users', 'Top listeners', 'Top speakers', 'Top image creators']) {
      await expect(main.getByRole('heading', { name: heading })).toHaveCount(0);
    }
    await expect(main.getByLabel('Person')).toHaveCount(0);

    // A longer window re-reads in the same scope.
    await main.getByRole('button', { name: '90 days' }).click();
    await expect(main.getByText('Over the last 90 days')).toBeVisible();
    await expect(main).not.toContainText('Heavy Spender');
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
