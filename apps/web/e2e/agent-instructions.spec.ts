/**
 * Agents as instructions, end to end in a browser:
 *
 *  1. The builder: describe an agent, let drafting (mocked at the browser
 *     edge — drafting is the agents worker's draft sweep, which the memory
 *     server does not run) write the instructions and pick a tool, add a
 *     second tool by hand, save through the real route, and land on the
 *     overview showing the saved instructions and tools; then the edit page
 *     at phone width.
 *  2. A run that staged a batch of changes, produced for real: the agent
 *     is run, the in-process engine drives the stand-in model through a
 *     scripted read and a stage_actions call (e2e/llm-stub.mjs), and the
 *     run page shows the turn and the batch waiting for a go-ahead; the
 *     home feed's card lists the proposed actions with their reasons —
 *     accepting it claims the card through the real decision route.
 *  3. A question card, raised the same way through ask_person: each
 *     question with its evidence, answered or skipped.
 *
 * The tools are the ones a person has with no connector of their own
 * (Renkei's agents and cards tools): a Jira tool needs a Jira grant, which
 * only an OAuth sign-in to Atlassian makes.
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

const tagOf = (testInfo: TestInfo) => `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `agent-instructions-${name}.png`),
    fullPage: true,
  });
}

const DRAFTED_INSTRUCTIONS = [
  '## Goal',
  '',
  'Each morning, find the agents nobody has run lately and list them.',
  '',
  '## Approach',
  '',
  '1. List the agents with agent_list.',
  '2. Keep the ones with no recent run.',
  '',
  '## Done when',
  '',
  'Every idle agent is listed — or there were none.',
].join('\n');

test('builder: draft, pick tools, save, and read it back', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(180_000);
  const tag = tagOf(testInfo);
  const name = `Idle agents digest ${tag}`;

  // Drafting runs in the agents worker against a real model; at the browser
  // edge it is a start call, a poll, and a consume.
  const draftId = randomUUID();
  let draftRequest: Record<string, unknown> | null = null;
  await page.route('**/api/agents/draft', async (route) => {
    if (route.request().method() === 'POST') {
      draftRequest = route.request().postDataJSON();
      await route.fulfill({ status: 202, json: { draftId, status: 'queued' } });
    } else {
      await route.fulfill({ json: { draft: null } });
    }
  });
  await page.route(`**/api/agents/draft/${draftId}`, (route) =>
    route.fulfill({
      json: {
        draft: {
          status: 'succeeded',
          result: {
            name,
            instructions: DRAFTED_INSTRUCTIONS,
            tools: ['agent_list'],
            questions: ['Which agents should it look at?'],
            canAskQuestions: true,
            notes: ['Left out “slack_post”: it is not one of your tools.'],
          },
        },
      },
    })
  );
  await page.route(`**/api/agents/draft/${draftId}/consume`, (route) =>
    route.fulfill({ json: { ok: true } })
  );

  await page.goto(`/agents/new`);
  await expect(page.getByRole('heading', { name: 'New agent' })).toBeVisible();
  // A new agent starts from the section skeleton, and Save waits for content.
  await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(/## Goal/);
  await expect(page.getByRole('button', { name: 'Save' }).first()).toBeDisabled();
  await expect(page.getByLabel('Run limits').filter({ visible: true })).toContainText('tool calls');
  await shot(page, testInfo, '01-new');

  await page
    .getByLabel('Describe the agent')
    .fill('Every morning, list the agents nobody has run lately.');
  await page.getByRole('button', { name: 'Draft it for me' }).click();
  await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(
    DRAFTED_INSTRUCTIONS
  );
  await expect(page.getByLabel('Name it')).toHaveValue(name);
  await expect(page.getByText('Which agents should it look at?')).toBeVisible();
  await expect(page.getByText('Left out “slack_post”', { exact: false })).toBeVisible();
  expect(draftRequest).toMatchObject({ current: null, suggestTriggers: true });
  // The drafted instructions ask the owner something, so the draft turns the option on.
  await expect(page.getByLabel('Can ask me questions')).toBeChecked();

  // The drafted tool is selected; add a second by hand from the picker.
  const tools = page.getByRole('region', { name: 'Tools' });
  await expect(tools.getByTestId('tool-count')).toHaveText(/^1 of at most/);
  await page.getByLabel('Search tools').fill('agent_get');
  const getAgent = tools
    .getByRole('listitem')
    .filter({ has: page.getByRole('checkbox', { name: 'The exact definition, as JSON' }) });
  await getAgent.getByRole('checkbox').check();
  await expect(tools.getByTestId('tool-count')).toHaveText(/^2 of at most/);
  await expect(getAgent).toContainText('reads');
  await shot(page, testInfo, '02-drafted');

  await page.getByRole('button', { name: 'Save' }).first().click();
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
  const agentId = page.url().split('/').pop() ?? '';
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const instructions = page.getByRole('region', { name: 'Instructions' });
  await expect(instructions.getByRole('heading', { name: 'Done when' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tools' }).locator('li')).toHaveCount(2);

  // What was saved, as the agent's own route reads it back.
  const saved = await page.request.get(`/api/agents/${agentId}`);
  expect(saved.ok()).toBe(true);
  const { agent } = await saved.json();
  expect(agent.instructions).toBe(DRAFTED_INSTRUCTIONS);
  expect(agent.tools).toEqual(['agent_list', 'agent_get']);
  expect(agent.autoAcceptActions).toBe(false);
  expect(agent.canAskQuestions).toBe(true);
  await shot(page, testInfo, '03-saved-overview');

  // Phone width: the edit page stacks, nothing scrolls sideways.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/agents/${agentId}/edit`);
  await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(
    DRAFTED_INSTRUCTIONS
  );
  await page.getByLabel('Accept proposed actions automatically').check();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, testInfo, '04-edit-mobile');
});

test('a staged batch: the run page and the card, accepted', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  const tag = tagOf(testInfo);
  const modelId = await addStubModel(page.request, tag);
  try {
    // What the run reads: an agent whose description runs well past the
    // 2,000-character preview, ending in a line only the full result carries.
    const notesBody = `${'OPS-7 VPN outage, no reply yet. '.repeat(190)}\nLast line: OPS-8 duplicate of OPS-7.`;
    const notesId = await createAgent(page.request, {
      name: `Ticket notes ${tag}`,
      instructions: `## Goal\n\n${notesBody}`,
      enabled: false,
    });
    const greeter = `Ticket greeter ${tag}`;
    const actions = [
      {
        tool: 'card_create',
        args: { title: 'OPS-7', summary: 'Picked up — looking now.' },
        reason: 'OPS-7 has no reply yet.',
      },
      {
        tool: 'card_create',
        args: { title: 'OPS-8', summary: 'Duplicate of OPS-7.' },
        reason: 'OPS-8 repeats OPS-7.',
      },
    ];
    const agentId = await createAgent(page.request, {
      name: greeter,
      llmModelId: modelId,
      tools: ['agent_get', 'card_create'],
      instructions: [
        '## Goal',
        '',
        'Reply on new OPS tickets.',
        '',
        stubScript([
          toolStep('agent_get', { agentId: notesId }),
          toolStep(
            'stage_actions',
            { summary: 'Reply on two new OPS tickets.', actions },
            'Two new tickets need a reply; proposing both comments.'
          ),
        ]),
      ].join('\n'),
    });

    await page.goto(`/agents/${agentId}`);
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.getByRole('link', { name: 'Run started — open it' }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/runs/[0-9a-f-]+$`), {
      timeout: 30_000,
    });
    const runUrl = page.url();

    // The run parks on the batch; the page shows it once it has.
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId('staged-batch').first()).toContainText('Proposed 2 changes', {
        timeout: 2_000,
      });
    }).toPass({ timeout: 45_000 });
    await expect(page.getByRole('heading', { name: 'Run' })).toBeVisible();
    await expect(page.getByTestId('turn-heading').first()).toHaveText('Turn 1');
    await expect(
      page.getByText('Two new tickets need a reply; proposing both comments.').first()
    ).toBeVisible();
    // The tool result is the whole of what the agent read, not the preview.
    const showAll = page.getByText(/^Show all \([\d,]+ characters\)$/).first();
    await expect(showAll).toBeVisible();
    await showAll.click();
    await expect(page.getByText('Last line: OPS-8 duplicate of OPS-7.').first()).toBeVisible();
    await expect(page.getByText('Waiting for your go-ahead.').first()).toBeVisible();
    await expect(page.getByTestId('run-times')).toContainText('active time');
    await shot(page, testInfo, '05-run-waiting');

    const title = `${greeter} — wants to make 2 changes`;
    await page.goto(`/`);
    const card = page.getByRole('article', { name: title });
    const proposed = card.getByRole('list', { name: 'Proposed actions' });
    await expect(proposed.getByRole('listitem')).toHaveCount(2);
    await expect(proposed).toContainText('OPS-7 has no reply yet.');
    await proposed.getByRole('listitem').first().getByText('Details', { exact: true }).click();
    await expect(proposed).toContainText('Picked up — looking now.');
    await shot(page, testInfo, '06-card');

    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(proposed).toBeVisible();
    await shot(page, testInfo, '07-card-mobile');

    await card.getByRole('textbox', { name: 'Comment' }).fill('Go ahead.');
    await card.getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByText(title)).toHaveCount(0);
    const decided = (await feedItems(page.request)).find((item) => item.title === title);
    expect(decided?.status).not.toBe('suggested');

    // Accepted, the executor carries the batch out and the run finishes.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(async () => {
      await page.goto(runUrl);
      await expect(page.getByText('Finished — the goal was met.')).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 45_000 });
    // What the batch did: the two cards, on the person's feed.
    await expect
      .poll(async () => (await feedItems(page.request)).map((item) => item.title))
      .toEqual(expect.arrayContaining(['OPS-7', 'OPS-8']));
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('a question card asks a batch: each question with its evidence, answered or skipped', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  const tag = tagOf(testInfo);
  const modelId = await addStubModel(page.request, tag);
  try {
    const agentName = `Portfolio Updater ${tag}`;
    const ask = toolStep('ask_person', {
      intro: 'ATLAS Lab Harvest went live on Azure 10/17–10/19; two things need a home.',
      questions: [
        {
          question: 'Should the ATLAS go-live status go on CIO-5, CIO-25 or CIO-26?',
          context: 'John Vo: "a great first day post go-live"; 837 lab orders on 10/19.',
          answer: { type: 'choice', options: ['CIO-5', 'CIO-25', 'CIO-26'] },
        },
        {
          question: 'Does the xCures SFTP / IP-allowlist work need a CIO-39 update?',
          context: 'SYS-2597, Kelvin, 10/19.',
          answer: { type: 'choice', options: ['Yes', 'No'] },
        },
      ],
    });
    const agentId = await createAgent(page.request, {
      name: agentName,
      llmModelId: modelId,
      canAskQuestions: true,
      // Every run asks, so a second run raises the card afresh.
      instructions: `## Goal\n\nKeep CIO issues current.\n\n${stubScript([ask])}`,
    });
    await runAgent(page.request, agentId);

    const title = `${agentName} — has a question`;
    const card = page.getByRole('article', { name: title });
    await expect(async () => {
      await page.goto('/');
      await expect(card).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    // Each question is numbered, a full sentence, with its own evidence beside it.
    await expect(card.getByText('1.', { exact: true })).toBeVisible();
    await expect(card.getByText('837 lab orders on 10/19.', { exact: false })).toBeVisible();
    await expect(card.getByText('SYS-2597, Kelvin, 10/19.')).toBeVisible();
    await expect(card.getByText('Leave any question blank to skip it.')).toBeVisible();
    await shot(page, testInfo, '08-question-batch');

    // "Something else" opens a box for an answer the options do not cover.
    await card.getByRole('radio', { name: 'CIO-25' }).check();
    await expect(card.getByRole('textbox', { name: 'Something else — your answer' })).toHaveCount(
      0
    );
    await card.getByRole('radio', { name: 'Something else' }).first().check();
    const own = card.getByRole('textbox', { name: 'Something else — your answer' });
    await expect(own).toBeVisible();
    await card.getByRole('button', { name: 'Send the answers' }).click();
    await expect(card.getByText('Say what it is.')).toBeVisible();
    await own.fill('A new CIO-41 issue for the Azure cutover');
    await card
      .getByRole('textbox', { name: 'Anything else I should know?' })
      .fill('Kelvin owns the SFTP piece.');
    await card.getByRole('button', { name: 'Send the answers' }).click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });

    // Answered, skipped (absent), and the free note — as the feed's route reads it.
    const answered = (await feedItems(page.request)).find((item) => item.title === title);
    expect(answered?.status).toBe('answered');
    expect(answered?.result).toMatchObject({
      answers: {
        q1: 'Something else: A new CIO-41 issue for the Azure cutover',
        anything_else: 'Kelvin owns the SFTP piece.',
      },
    });
    expect(answered?.result).not.toHaveProperty('answers.q2');

    // The same card at phone width, freshly raised by the next run.
    await expect(async () => {
      const again = await page.request.post(`/api/agents/${agentId}/invoke`, { data: {} });
      expect(again.status()).toBe(202);
    }).toPass({ timeout: 45_000 });
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(async () => {
      await page.goto('/');
      await expect(card.getByRole('radio', { name: 'CIO-26' })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await card.getByRole('radio', { name: 'Something else' }).first().check();
    await expect(card.getByRole('textbox', { name: 'Something else — your answer' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, '09-question-batch-mobile');
  } finally {
    await removeModel(page.request, modelId);
  }
});
