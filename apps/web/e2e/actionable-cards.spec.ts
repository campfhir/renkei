/**
 * The home feed's proposed-batch block (cards.tsx's ProposedBatch), one
 * card end to end: an agent run on the in-process engine, its model (the
 * stand-in, e2e/llm-stub.mjs) scripted to stage one action, the batch
 * waiting on the person, and the server-rendered feed drawing it — with an
 * object-valued argument, at desktop and phone width.
 *
 * Its rules moved out of the browser: how each tool family's arguments
 * read — a Jira/JSM issue as a project/type header, summary, description
 * and field rows; an Outlook mail as To/Cc, subject and body; anything
 * else as a JSON-safe `key: value` list, never "[object Object]" — are
 * app/(app)/cards.model.test.ts, which also holds the decided-card lines.
 * The Jira and Outlook cards no longer connect a vendor and run an agent
 * here just to read their arguments back.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, toolStep, removeModel, stubScript } from './support/stub-model';
import { createAgent, feedItems, runAgent } from './support/agents';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

// Staging the stand-in model on the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('a call outside the dedicated cards falls back to a JSON-safe arg list', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const agentName = `Portfolio Updater ${tag}`;
    const agentId = await createAgent(page.request, {
      name: agentName,
      llmModelId: modelId,
      tools: ['card_create'],
      instructions: [
        '## Goal',
        '',
        'Flag the channel deployment.',
        '',
        stubScript([
          toolStep('stage_actions', {
            summary: 'Wants to make a change.',
            actions: [
              {
                tool: 'card_create',
                args: {
                  title: 'Deploy the channel',
                  summary: 'Both channels are ready.',
                  evidence: { channelIds: ['channel-a', 'channel-b'], options: { force: true } },
                },
                reason: 'The agent judged this change necessary.',
              },
            ],
          }),
        ]),
      ].join('\n'),
    });
    await runAgent(page.request, agentId);

    // The feed is server-rendered: wait for the card through the feed's own
    // route, then open the page once.
    const title = `${agentName} — wants to make a change`;
    await expect
      .poll(async () => (await feedItems(page.request)).map((item) => item.title), {
        timeout: 45_000,
      })
      .toContain(title);
    await page.goto('/');
    const card = page.getByRole('article', { name: title });
    await expect(card).toBeVisible();

    // Open the action's arguments, collapsed behind "Details" by default.
    const action = card
      .getByRole('list', { name: 'Proposed actions' })
      .getByRole('listitem')
      .first();
    await expect(action).toContainText('Create');
    await expect(action).toContainText('The agent judged this change necessary.');
    await action.getByText('Details', { exact: true }).click();

    await expect(card.getByText('[object Object]')).toHaveCount(0);
    await expect(card.getByText('evidence:')).toBeVisible();
    await expect(
      card.getByText('{"channelIds":["channel-a","channel-b"],"options":{"force":true}}')
    ).toBeVisible();
    await shot(page, testInfo, 'actionable-cards-generic');

    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(card.getByText('evidence:')).toBeVisible();
    await expect(card.getByText('[object Object]')).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(page, testInfo, 'actionable-cards-generic-mobile');
  } finally {
    await removeModel(page.request, modelId);
  }
});
