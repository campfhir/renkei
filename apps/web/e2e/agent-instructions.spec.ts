/**
 * Agents as instructions, end to end in a browser — what only a browser
 * shows: the pages render on the real server, fit a phone, and one press
 * per path reaches its route and is drawn.
 *
 *  1. The builder: name an agent, write its instructions, pick a tool,
 *     Save through the real route, land on the overview showing the saved
 *     instructions and tools; then the edit page at phone width.
 *  2. A run that staged a batch of changes, produced for real by the
 *     in-process engine driving the stand-in model (e2e/llm-stub.mjs): the
 *     run page shows the batch waiting; the home feed's card lists the
 *     proposed actions — Accept claims it through the real decision route,
 *     and the executor carries the batch out.
 *  3. A question card raised the same way through ask_person: it renders
 *     each question with its evidence, fits a phone, and "Send the answers"
 *     reaches the route.
 *
 * Where the rules went (no longer pressed through here):
 *  - The builder's rules — the skeleton a new agent starts from, when Save
 *    is on, what Save and "Draft it for me" send, what a finished draft
 *    fills in (instructions, tools, a name only when empty, questions only
 *    ever on, a schedule's zone), the tool count and its limit, a refused
 *    save's issues — are app/(app)/agents/builder/agent-builder.model.test.ts
 *    and tool-picker.model.test.ts. Drafting itself is the agents worker's
 *    draft sweep, which the memory server does not run.
 *  - What Save stores and reads back, and the 422/400/404 answers, are
 *    app/api/agents/route.test.ts.
 *  - The run timeline's wording (a batch's verdict, how a run finished,
 *    "Show all" on a long result) is app/(app)/agents/run-timeline.model.test.ts;
 *    that the result shown is the whole of what the agent read is
 *    lib/agents/tool-result.test.ts.
 *  - The question card's rules — numbering, the skip hint, "Something else"
 *    opening a box and "Say what it is." when it is empty, a skipped
 *    question sent absent, what a 422/502/409 leaves on the card — are
 *    app/(app)/question-actions.model.test.ts; what the answer route stores
 *    and refuses is app/api/actionable-items/[itemId]/question/route.test.ts.
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

const INSTRUCTIONS = [
  '## Goal',
  '',
  'Each morning, find the agents nobody has run lately and list them.',
  '',
  '## Done when',
  '',
  'Every idle agent is listed — or there were none.',
].join('\n');

test('builder: write, pick a tool, save, and read it back', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  const name = `Idle agents digest ${tagOf(testInfo)}`;

  await page.goto(`/agents/new`);
  await expect(page.getByRole('heading', { name: 'New agent' })).toBeVisible();
  const instructionsBox = page.getByRole('textbox', { name: 'Instructions' });
  await expect(instructionsBox).toHaveValue(/## Goal/);
  await expect(page.getByLabel('Run limits').filter({ visible: true })).toContainText('tool calls');
  await shot(page, testInfo, '01-new');

  await page.getByLabel('Name it').fill(name);
  await instructionsBox.fill(INSTRUCTIONS);
  const tools = page.getByRole('region', { name: 'Tools' });
  await page.getByLabel('Search tools').fill('agent_get');
  await tools
    .getByRole('listitem')
    .filter({ has: page.getByRole('checkbox', { name: 'The exact definition, as JSON' }) })
    .getByRole('checkbox')
    .check();
  await expect(tools.getByTestId('tool-count')).toHaveText(/^1 of at most/);
  await shot(page, testInfo, '02-written');

  // The one press through: Save → POST /api/agents → the overview draws what was stored.
  await page.getByRole('button', { name: 'Save' }).first().click();
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
  const agentId = page.url().split('/').pop() ?? '';
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const instructions = page.getByRole('region', { name: 'Instructions' });
  await expect(instructions.getByRole('heading', { name: 'Done when' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tools' }).locator('li')).toHaveCount(1);
  await shot(page, testInfo, '03-saved-overview');

  // Phone width: the edit page stacks, nothing scrolls sideways.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/agents/${agentId}/edit`);
  await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(INSTRUCTIONS);
  await page.getByLabel('Accept proposed actions automatically').check();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, testInfo, '04-edit-mobile');
});

/** Waits on the feed's own route — not page reloads — until the run has raised its card. */
async function cardRaised(page: Page, title: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await feedItems(page.request)).find(
          (item) => item.title === title && item.status === 'suggested'
        ) !== undefined,
      { timeout: 45_000 }
    )
    .toBe(true);
}

test('a staged batch: the run page and the card, accepted', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  const tag = tagOf(testInfo);
  const modelId = await addStubModel(page.request, tag);
  try {
    const notesId = await createAgent(page.request, {
      name: `Ticket notes ${tag}`,
      instructions: '## Goal\n\nOPS-7 VPN outage, no reply yet. OPS-8 duplicate of OPS-7.',
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
    const runId = await runAgent(page.request, agentId);

    // The run parks on the batch and raises its card.
    const title = `${greeter} — wants to make 2 changes`;
    await cardRaised(page, title);

    // The run page, rendered on the real server, shows the batch waiting.
    await page.goto(`/agents/${agentId}/runs/${runId}`);
    await expect(page.getByRole('heading', { name: 'Run' })).toBeVisible();
    await expect(page.getByTestId('turn-heading').first()).toHaveText('Turn 1');
    await expect(page.getByTestId('staged-batch').first()).toContainText('Proposed 2 changes');
    await expect(page.getByText('Waiting for your go-ahead.').first()).toBeVisible();
    await shot(page, testInfo, '05-run-waiting');

    await page.goto(`/`);
    const card = page.getByRole('article', { name: title });
    const proposed = card.getByRole('list', { name: 'Proposed actions' });
    await expect(proposed.getByRole('listitem')).toHaveCount(2);
    await expect(proposed).toContainText('OPS-7 has no reply yet.');
    await shot(page, testInfo, '06-card');

    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(proposed).toBeVisible();
    await shot(page, testInfo, '07-card-mobile');

    // The one press through: Accept → the decision route → the card leaves the feed.
    await card.getByRole('textbox', { name: 'Comment' }).fill('Go ahead.');
    await card.getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByText(title)).toHaveCount(0);
    const decided = (await feedItems(page.request)).find((item) => item.title === title);
    expect(decided?.status).not.toBe('suggested');

    // Accepted, the in-process executor carries the batch out: its two cards reach the feed.
    await expect
      .poll(async () => (await feedItems(page.request)).map((item) => item.title), {
        timeout: 45_000,
      })
      .toEqual(expect.arrayContaining(['OPS-7', 'OPS-8']));
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('a question card asks a batch: each question with its evidence, answered', async ({
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
      instructions: `## Goal\n\nKeep CIO issues current.\n\n${stubScript([ask])}`,
    });
    await runAgent(page.request, agentId);

    const title = `${agentName} — has a question`;
    await cardRaised(page, title);
    await page.goto('/');
    const card = page.getByRole('article', { name: title });
    // The form the run built renders: each question with its own evidence beside it.
    await expect(card.getByText('837 lab orders on 10/19.', { exact: false })).toBeVisible();
    await expect(card.getByText('SYS-2597, Kelvin, 10/19.')).toBeVisible();
    await shot(page, testInfo, '08-question-batch');

    // At phone width, with "Something else" open, nothing scrolls sideways.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await card.getByRole('radio', { name: 'Something else' }).first().check();
    const own = card.getByRole('textbox', { name: 'Something else — your answer' });
    await expect(own).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, '09-question-batch-mobile');

    // The one press through: Send the answers → the question route → the card leaves the feed.
    await own.fill('A new CIO-41 issue for the Azure cutover');
    await card.getByRole('button', { name: 'Send the answers' }).click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    const answered = (await feedItems(page.request)).find((item) => item.title === title);
    expect(answered?.status).toBe('answered');
    expect(answered?.result).toMatchObject({
      answers: { q1: 'Something else: A new CIO-41 issue for the Azure cutover' },
    });
  } finally {
    await removeModel(page.request, modelId);
  }
});
