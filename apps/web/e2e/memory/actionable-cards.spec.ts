/**
 * The card feed's proposed-batch block (cards.tsx's ProposedBatch and the
 * per-action ProposedCall it expands into).
 *
 * Started as a fix for one bug — an object-valued arg rendering as the
 * literal text "[object Object]" because the generic arg list ran every
 * value through bare `String()`. Grew from there into dedicated cards for
 * the two tool families common enough to be worth it: a Jira issue call
 * gets a project/type header, summary, description and its extra fields
 * as rows (IssueProposedCall); an Outlook send call gets To/Cc, subject and
 * body (EmailProposedCall); anything else falls back to a plain, JSON-safe
 * arg list.
 *
 * Every card is produced for real: an agent run on the in-process engine,
 * its model (the stand-in, e2e/llm-stub.mjs) scripted to stage one action;
 * the batch waits on the person, and the home feed shows it. A run can
 * stage only tools its owner has, so the Jira and Outlook cards' people
 * first connect Jira and Microsoft 365 through the real connect flows (the
 * in-memory app's fake OAuth, packages/provider-grants/src/fake-oauth.ts).
 *
 * Not reached here: an executed Jira card's new-tab link (ExecutionResult).
 * Only approving a staged issue writes it, and that creates the issue
 * server-side at api.atlassian.com, which has no stand-in (the everyday
 * Jira client takes no base URL). The feed is server-rendered, so there is
 * no GET to answer at the browser edge either.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from '../support/stub-model';
import { createAgent, runAgent, stubScript } from '../support/agents';
import { addConnectors, connectThrough, registerConnector } from '../support/connectors';

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

/**
 * An agent of the person's that stages one call and waits on them; answers
 * the card the home feed shows for it.
 */
async function stageOne(
  page: Page,
  input: { tag: string; modelId: string; tool: string; args: Record<string, unknown> }
) {
  const agentName = `Portfolio Updater ${input.tag}`;
  const agentId = await createAgent(page.request, {
    name: agentName,
    llmModelId: input.modelId,
    tools: [input.tool],
    instructions: [
      '## Goal',
      '',
      'Do the approved change.',
      '',
      stubScript([
        {
          tool: 'stage_actions',
          args: {
            summary: 'Wants to make a change.',
            actions: [
              {
                tool: input.tool,
                args: input.args,
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
  return card;
}

test('a Jira issue call renders as a structured issue card', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  // Jira set up for the org (left on: other specs connect through it) and
  // connected for this person.
  await registerConnector(page.request, 'atlassian', {
    clientId: 'e2e-jira-client',
    clientSecret: 'e2e-jira-secret',
  });
  await addConnectors(page.request, ['jira']);
  await connectThrough(page, '/api/mcp/authorize');
  const modelId = await addStubModel(page.request, tag);
  try {
    const card = await stageOne(page, {
      tag,
      modelId,
      tool: 'jira_create_issue',
      args: {
        projectKey: 'CIO',
        issueType: 'Project',
        summary: 'Salesforce Incentive-Program Tracking',
        description: 'Evidence: Scott + Dr. Jew/June meeting note.',
        fields: {
          'Anti-Kickback Review': 'Required',
          reviewers: ['scott', 'dr.jew'],
        },
      },
    });
    const action = card
      .getByRole('list', { name: 'Proposed actions' })
      .getByRole('listitem')
      .first();
    await expect(action).toContainText('The agent judged this change necessary.');
    await action.getByText('Details', { exact: true }).click();
    // Project/type header instead of raw "projectKey: CIO" / "issueType:
    // Project" rows — the same header shape the chat preview card shows.
    await expect(card.getByText('CIO · Project')).toBeVisible();
    await expect(card.getByText('Salesforce Incentive-Program Tracking')).toBeVisible();
    await expect(card.getByText('Evidence: Scott + Dr. Jew/June meeting note.')).toBeVisible();
    // The `fields` escape hatch used to collapse to one "[object Object]"
    // line; each of its entries is now its own labelled row.
    await expect(card.getByText('[object Object]')).toHaveCount(0);
    await expect(card.getByText('Anti-Kickback Review:')).toBeVisible();
    await expect(card.getByText('Required', { exact: true })).toBeVisible();
    await expect(card.getByText('reviewers:')).toBeVisible();
    await expect(card.getByText('scott, dr.jew')).toBeVisible();
    await shot(page, testInfo, 'actionable-cards-issue');

    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(card.getByText('CIO · Project')).toBeVisible();
    await expect(card.getByText('[object Object]')).toHaveCount(0);
    await shot(page, testInfo, 'actionable-cards-issue-mobile');
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('an Outlook send-mail call renders as a structured email card', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  // Microsoft 365 set up for the org (left on) and connected for this person.
  await registerConnector(
    page.request,
    'microsoft',
    {
      clientId: 'e2e-microsoft-client',
      clientSecret: 'e2e-microsoft-secret',
      directoryTenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    },
    ['directoryTenantId']
  );
  await addConnectors(page.request, ['microsoft']);
  await connectThrough(page, '/api/microsoft/authorize');
  const modelId = await addStubModel(page.request, tag);
  try {
    const card = await stageOne(page, {
      tag,
      modelId,
      tool: 'outlook_send_mail',
      args: {
        to: ['scott@example.com', 'dr.jew@example.com'],
        cc: ['rebecca@example.com'],
        subject: 'Weekly incentive-tracking digest',
        body: 'Salesforce remains the preferred long-term option.',
      },
    });
    const action = card
      .getByRole('list', { name: 'Proposed actions' })
      .getByRole('listitem')
      .first();
    await expect(action).toContainText('Send mail');
    await action.getByText('Details', { exact: true }).click();
    await expect(card.getByText('To:')).toBeVisible();
    await expect(card.getByText('scott@example.com, dr.jew@example.com')).toBeVisible();
    await expect(card.getByText('Cc:')).toBeVisible();
    await expect(card.getByText('rebecca@example.com')).toBeVisible();
    await expect(card.getByText('Weekly incentive-tracking digest')).toBeVisible();
    await expect(
      card.getByText('Salesforce remains the preferred long-term option.')
    ).toBeVisible();
    await shot(page, testInfo, 'actionable-cards-email');
  } finally {
    await removeModel(page.request, modelId);
  }
});
