/**
 * The card feed's proposed-batch block (cards.tsx's ProposedBatch and the
 * per-action ProposedCall it expands into).
 *
 * Started as a fix for one bug — an object-valued arg rendering as the
 * literal text "[object Object]" because the generic arg list ran every
 * value through bare `String()`. The card here is produced for real: an
 * agent run on the in-process engine, its model (the stand-in,
 * e2e/llm-stub.mjs) scripted to stage one card_create whose `evidence`
 * is an object holding an array and a nested object; the batch waits on
 * the person, and the home feed shows it.
 *
 * Not reached here: the dedicated Jira issue card (IssueProposedCall), the
 * Outlook email card (EmailProposedCall) and an executed Jira card's
 * new-tab link (ExecutionResult). Each is chosen by the staged tool's name
 * (jira_create_issue_confirm, outlook_send_mail) or written by the Jira
 * pipeline, and a run can stage only tools its owner has — a Jira or
 * Microsoft grant, which only an OAuth sign-in to the vendor creates. The
 * feed is server-rendered, so there is no GET to answer at the browser
 * edge either.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from '../support/stub-model';
import { createAgent, runAgent, stubScript } from '../support/agents';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
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
          {
            tool: 'stage_actions',
            args: {
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
            },
          },
        ]),
      ].join('\n'),
    });
    await runAgent(page.request, agentId);

    const card = page.getByRole('article', { name: `${agentName} — wants to make a change` });
    await expect(async () => {
      await page.goto('/');
      await expect(card).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });

    // Open the action's arguments, collapsed behind "Details" by default.
    const action = card
      .getByRole('list', { name: 'Proposed actions' })
      .getByRole('listitem')
      .first();
    await expect(action).toContainText('Create');
    await expect(action).toContainText('The agent judged this change necessary.');
    await action.getByText('Details', { exact: true }).click();

    await expect(card.getByText('[object Object]')).toHaveCount(0);
    await expect(card.getByText('title:')).toBeVisible();
    await expect(card.getByText('Deploy the channel')).toBeVisible();
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
