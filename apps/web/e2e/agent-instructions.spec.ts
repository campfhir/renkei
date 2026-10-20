/**
 * Agents as instructions, end to end in a browser:
 *
 *  1. The builder: describe an agent, let drafting (mocked at the browser
 *     edge — no model in e2e) write the instructions and pick a tool, add a
 *     second tool by hand, save through the real route, and land on the
 *     overview showing the saved instructions and tools; then the edit page
 *     at phone width.
 *  2. A run that staged a batch of changes: the run page shows the turn
 *     and the batch waiting for a go-ahead, and the home feed's card lists
 *     the proposed actions with their reasons — accepting it claims the
 *     card through the real decision route.
 *
 * Each Playwright project gets its own person, derived from the project
 * name (AGENTS.md: a spec that writes rows must not share e2e/seed.ts's
 * person). Runs on the pinned Chromium; "mobile" is a resized viewport.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';
import { deleteRowsOf } from './seed';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function fixtureFor(name: string) {
  return {
    name,
    sessionId: uuidFrom(`agent-instructions-e2e-session:${name}`),
    subject: `e2e-agent-instructions-${name}@example.com`,
  };
}
type Fixture = ReturnType<typeof fixtureFor>;

async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A clean person with a Jira grant, so the tool catalog offers Jira tools. */
async function seedPerson(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    await client.query(
      `DELETE FROM agent_jobs WHERE payload->>'runId' IN (SELECT id::text FROM agent_runs WHERE owner_subject = $1)`,
      [fixture.subject]
    );
    await deleteRowsOf(client, fixture.subject, [
      'agent_runs',
      'agents',
      'provider_grants',
      'sessions',
      'identities',
    ]);
    await client.query(`DELETE FROM actionable_items WHERE owner_subject = $1`, [fixture.subject]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, 'E2E Agent Author')`,
      [fixture.subject, fixture.subject]
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)\n       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)\n       ON CONFLICT (subject, key) DO UPDATE SET value = EXCLUDED.value`,
      [fixture.subject]
    );
    await client.query(
      `INSERT INTO provider_grants\n         (provider, provider_account_id, subject, client_id, display_name,\n          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes)\n       VALUES ('atlassian', $1, $2, 'e2e-client', 'E2E Jira',\n               'not-a-real-token', 'not-a-real-token', $3, $4)\n       ON CONFLICT DO NOTHING`,
      [
        `e2e-agent-instructions-${fixture.name}`,
        fixture.subject,
        new Date(Date.now() + 365 * 24 * 3_600_000),
        [
          'read:issue:jira',
          'write:issue:jira',
          'read:user:jira',
          'read:project:jira',
          'read:jql:jira',
          'read:field:jira',
          'read:comment:jira',
          'write:comment:jira',
        ],
      ]
    );
    await enrollForE2E(client, fixture.subject);
  });
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session`,
      value: fixture.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `agent-instructions-${name}.png`),
    fullPage: true,
  });
}

const DRAFTED_INSTRUCTIONS = [
  '## Goal',
  '',
  'Each morning, find yesterday’s Jira issues that nobody has answered and list them.',
  '',
  '## Approach',
  '',
  '1. Search issues updated yesterday with jira_search_issues.',
  '2. Keep the ones with no reply.',
  '',
  '## Done when',
  '',
  'Every unanswered issue is listed — or there were none.',
].join('\n');

test('builder: draft, pick tools, save, and read it back', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = fixtureFor(`builder-${testInfo.project.name}`);
  await seedPerson(fixture);
  await signIn(page, fixture);

  // Drafting runs in the agents worker against a real model; at the browser
  // edge it is a start call, a poll, and a consume.
  const draftId = uuidFrom(`agent-instructions-draft:${fixture.name}`);
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
            name: 'Unanswered issues digest',
            instructions: DRAFTED_INSTRUCTIONS,
            tools: ['jira_search_issues'],
            questions: ['Which projects should it look at?'],
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
  await expect(page.getByLabel('Run limits')).toContainText('tool calls');
  await shot(page, testInfo, '01-new');

  await page
    .getByLabel('Describe the agent')
    .fill('Every morning, list the Jira issues from yesterday that nobody answered.');
  await page.getByRole('button', { name: 'Draft it for me' }).click();
  await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(DRAFTED_INSTRUCTIONS);
  await expect(page.getByLabel('Name it')).toHaveValue('Unanswered issues digest');
  await expect(page.getByText('Which projects should it look at?')).toBeVisible();
  await expect(page.getByText('Left out “slack_post”', { exact: false })).toBeVisible();
  expect(draftRequest).toMatchObject({ current: null, suggestTriggers: true });
  // The drafted instructions ask the owner something, so the draft turns the option on.
  await expect(page.getByLabel('Can ask me questions')).toBeChecked();

  // The drafted tool is selected; add a second by hand from the picker.
  const tools = page.getByRole('region', { name: 'Tools' });
  await expect(tools.getByTestId('tool-count')).toHaveText(/^1 of at most/);
  await page.getByLabel('Search tools').fill('jira_get_issue');
  const getIssue = tools.locator('label', { hasText: 'jira_get_issue' }).first();
  await getIssue.getByRole('checkbox').check();
  await expect(tools.getByTestId('tool-count')).toHaveText(/^2 of at most/);
  await expect(getIssue).toContainText('reads');
  await shot(page, testInfo, '02-drafted');

  await page.getByRole('button', { name: 'Save' }).first().click();
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
  const agentId = page.url().split('/').pop() ?? '';
  await expect(page.getByRole('heading', { name: 'Unanswered issues digest' })).toBeVisible();
  const instructions = page.getByRole('region', { name: 'Instructions' });
  await expect(instructions.getByRole('heading', { name: 'Done when' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tools' }).locator('li')).toHaveCount(2);

  const saved = await withDb((client) =>
    client.query<{
      instructions: string;
      tools: string[];
      auto_accept_actions: boolean;
      can_ask_questions: boolean;
    }>(
      `SELECT instructions, tools, auto_accept_actions, can_ask_questions FROM agents WHERE id = $1`,
      [agentId]
    )
  );
  expect(saved.rows[0]?.instructions).toBe(DRAFTED_INSTRUCTIONS);
  expect(saved.rows[0]?.tools).toEqual(['jira_search_issues', 'jira_get_issue']);
  expect(saved.rows[0]?.auto_accept_actions).toBe(false);
  expect(saved.rows[0]?.can_ask_questions).toBe(true);
  await shot(page, testInfo, '03-saved-overview');

  // Phone width: the edit page stacks, nothing scrolls sideways.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/agents/${agentId}/edit`);
  await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(DRAFTED_INSTRUCTIONS);
  await page.getByLabel('Accept proposed actions automatically').check();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, testInfo, '04-edit-mobile');
});

test('a staged batch: the run page and the card, accepted', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = fixtureFor(`batch-${testInfo.project.name}`);
  await seedPerson(fixture);
  await signIn(page, fixture);

  const agentId = uuidFrom(`agent-instructions-agent:${fixture.name}`);
  const runId = uuidFrom(`agent-instructions-run:${fixture.name}`);
  const batchId = uuidFrom(`agent-instructions-batch:${fixture.name}`);
  const cardId = uuidFrom(`agent-instructions-card:${fixture.name}`);
  const definition = {
    instructions: '## Goal\n\nComment on new OPS tickets.',
    tools: ['jira_search_issues', 'jira_add_comment'],
  };
  const actions = [
    {
      tool: 'jira_add_comment',
      args: { issueKey: 'OPS-7', body: 'Picked up — looking now.' },
      reason: 'OPS-7 has no reply yet.',
    },
    {
      tool: 'jira_add_comment',
      args: { issueKey: 'OPS-8', body: 'Duplicate of OPS-7.' },
      reason: 'OPS-8 repeats OPS-7.',
    },
  ];
  // A search result well past the 2,000-character preview, ending in a
  // line only the full result carries.
  const longResult = `${'OPS-7 VPN outage, no reply yet. '.repeat(190)}\nLast line: OPS-8 duplicate of OPS-7.`;
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO agents (id, owner_subject, name, instructions, tools, enabled)\n       VALUES ($1, $2, 'Ticket greeter', $3, $4, false)`,
      [agentId, fixture.subject, definition.instructions, JSON.stringify(definition.tools)]
    );
    await client.query(
      `INSERT INTO agent_runs\n         (id, agent_id, owner_subject, trigger_kind, definition_snapshot, status,\n          started_at, waiting_until, active_ms)\n       VALUES ($1, $2, $3, 'manual', $4, 'waiting', NOW() - interval '2 minutes',\n               NOW() + interval '4 days', 12000)`,
      [runId, agentId, fixture.subject, JSON.stringify(definition)]
    );
    await client.query(
      `INSERT INTO agent_run_steps\n         (id, run_id, step_id, step_index, attempt, iteration, status, outcome,\n          tool_call_count, detail, started_at)\n       VALUES (gen_random_uuid(), $1, 'turn', 1, 1, 0, 'waiting', 'actions', 3, $2, NOW())`,
      [
        runId,
        JSON.stringify({
          opening: 'Your owner started this run by hand. Work toward your goal now.',
          llmSummary: 'Two new tickets need a reply; proposing both comments.',
          toolCalls: [
            { tool: 'jira_search_issues', argsPreview: '{"jql":"project = OPS"}', resultPreview: `${longResult.slice(0, 2000)}… [truncated]`, isError: false, durationMs: 420, toolUseId: 'tu_search' },
            { tool: 'stage_actions', argsPreview: '{}', resultPreview: 'Waiting for acceptance.', isError: false, durationMs: 0, staged: 2 },
          ],
          // The whole result, fenced as the model read it: the timeline shows
          // this, not the 2,000-character preview above.
          results: [
            {
              type: 'tool_result',
              toolUseId: 'tu_search',
              content: `<untrusted source="tool:jira_search_issues">\n${longResult}\n</untrusted>`,
            },
          ],
          // A fold made on this turn: the run outgrew its model earlier.
          compaction: {
            summary: 'NOTES: OPS-7 and OPS-8 are new and unanswered; next, propose replies.',
            through: 3,
          },
          pause: { kind: 'actions', toolUseId: 'tu_1', batchId },
        }),
      ]
    );
    await client.query(
      `INSERT INTO agent_action_batches\n         (id, run_id, agent_id, owner_subject, turn, status, summary, actions, review_reason, waiting_until)\n       VALUES ($1, $2, $3, $4, 1, 'proposed', 'Reply on two new OPS tickets.', $5, 'owner',\n               NOW() + interval '4 days')`,
      [batchId, runId, agentId, fixture.subject, JSON.stringify(actions)]
    );
    await client.query(
      `INSERT INTO actionable_items\n         (id, source, status, kind, title, summary, evidence, suggested_action, owner_subject,\n          created_by, created_by_agent_id, run_id, step_id, iteration, attempt)\n       VALUES ($1, 'agents', 'suggested', 'approval', 'Ticket greeter — wants to make 2 changes',\n               'Reply on two new OPS tickets.', '[]'::jsonb, $2, $3, $3, $4, $5, 'turn', 0, 1)`,
      [cardId, JSON.stringify({ batchId, summary: 'Reply on two new OPS tickets.', actions }), fixture.subject, agentId, runId]
    );
  });

  await page.goto(`/agents/${agentId}/runs/${runId}`);
  await expect(page.getByRole('heading', { name: 'Run' })).toBeVisible();
  await expect(page.getByTestId('turn-heading').first()).toHaveText('Turn 1');
  await expect(page.getByText('Two new tickets need a reply; proposing both comments.')).toBeVisible();
  // The fold shows where it happened, its notes readable.
  const fold = page.getByTestId('turn-compaction');
  await expect(fold).toContainText("Turns 1–3 folded into notes to fit the model’s context");
  await expect(fold).toContainText('OPS-7 and OPS-8 are new and unanswered');
  // The tool result is the whole of what the agent read, not the preview.
  const showAll = page.getByText(`Show all (${longResult.length.toLocaleString()} characters)`);
  await expect(showAll).toBeVisible();
  await showAll.click();
  await expect(page.getByText('Last line: OPS-8 duplicate of OPS-7.')).toBeVisible();
  await expect(page.getByText('… [truncated]')).toHaveCount(0);
  await expect(page.getByTestId('staged-batch').first()).toContainText('Proposed 2 changes');
  await expect(page.getByText('Waiting for your go-ahead.').first()).toBeVisible();
  await expect(page.getByTestId('run-times')).toContainText('active time');
  await shot(page, testInfo, '05-run-waiting');

  await page.goto(`/`);
  // Scoped to this card: owner-less cards other specs seed show on every feed.
  const card = page.getByRole('article', { name: 'Ticket greeter — wants to make 2 changes' });
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
  await expect(page.getByText('Ticket greeter — wants to make 2 changes')).toHaveCount(0);
  const decided = await withDb((client) =>
    client.query<{ status: string; result: { comment?: string } }>(
      `SELECT status, result FROM actionable_items WHERE id = $1`,
      [cardId]
    )
  );
  expect(decided.rows[0]?.status).toBe('approved');
  expect(decided.rows[0]?.result.comment).toBe('Go ahead.');
  // The engine is not running here; take back the run it would have woken.
  await withDb((client) =>
    client.query(`DELETE FROM agent_jobs WHERE payload->>'runId' = $1`, [runId])
  );
});

test('a question card asks a batch: each question with its evidence, answered or skipped', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = fixtureFor(`question-${testInfo.project.name}`);
  await seedPerson(fixture);
  await signIn(page, fixture);

  const agentId = uuidFrom(`agent-instructions-qagent:${fixture.name}`);
  const runId = uuidFrom(`agent-instructions-qrun:${fixture.name}`);
  const cardId = uuidFrom(`agent-instructions-qcard:${fixture.name}`);
  const title = 'Portfolio Updater — has a question';
  // The form askedQuestionsOf (@renkei/agents) builds from an intro and three questions.
  const message = 'ATLAS Lab Harvest went live on Azure 10/17–10/19; two things need a home.';
  const form = [
    {
      kind: 'field',
      name: 'q1',
      label: 'Should the ATLAS go-live status go on CIO-5, CIO-25 or CIO-26?',
      type: 'choice',
      required: false,
      options: ['CIO-5', 'CIO-25', 'CIO-26', 'Something else'],
      context: 'John Vo: "a great first day post go-live"; 837 lab orders on 10/19.',
    },
    {
      kind: 'field',
      name: 'q2',
      label: 'Does the xCures SFTP / IP-allowlist work need a CIO-39 update?',
      type: 'choice',
      required: false,
      options: ['Yes', 'No'],
      context: 'SYS-2597, Kelvin, 10/19.',
    },
    {
      kind: 'field',
      name: 'anything_else',
      label: 'Anything else I should know?',
      type: 'longtext',
      required: false,
    },
  ];
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO agents (id, owner_subject, name, instructions, tools, enabled, can_ask_questions)\n       VALUES ($1, $2, 'Portfolio Updater', '## Goal\n\nKeep CIO issues current.', '[]'::jsonb, false, true)`,
      [agentId, fixture.subject]
    );
    await client.query(
      `INSERT INTO agent_runs\n         (id, agent_id, owner_subject, trigger_kind, definition_snapshot, status, started_at, waiting_until, active_ms)\n       VALUES ($1, $2, $3, 'manual', '{}'::jsonb, 'waiting', NOW() - interval '1 minute', NOW() + interval '4 days', 9000)`,
      [runId, agentId, fixture.subject]
    );
    await client.query(
      `INSERT INTO actionable_items\n         (id, source, status, kind, title, summary, evidence, suggested_action, owner_subject,\n          created_by, created_by_agent_id, run_id, step_id, iteration, attempt)\n       VALUES ($1, 'agents', 'suggested', 'question', $2, $3, '[]'::jsonb, $4, $5, $5, $6, $7, 'turn', 0, 1)`,
      [cardId, title, message, JSON.stringify({ message, form }), fixture.subject, agentId, runId]
    );
  });

  await page.goto('/');
  const card = page.getByRole('article', { name: title });
  await expect(card).toBeVisible({ timeout: 30_000 });
  // Each question is numbered, a full sentence, with its own evidence beside it.
  await expect(card.getByText('1.', { exact: true })).toBeVisible();
  await expect(card.getByText('837 lab orders on 10/19.', { exact: false })).toBeVisible();
  await expect(card.getByText('SYS-2597, Kelvin, 10/19.')).toBeVisible();
  await expect(card.getByText('Leave any question blank to skip it.')).toBeVisible();
  await shot(page, testInfo, '08-question-batch');

  await card.getByRole('radio', { name: 'CIO-25' }).check();
  await card.getByRole('textbox', { name: 'Anything else I should know?' }).fill('Kelvin owns the SFTP piece.');
  await card.getByRole('button', { name: 'Send the answers' }).click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });

  const stored = await withDb((client) =>
    client.query<{ status: string; result: { answers: Record<string, unknown> } }>(
      'SELECT status, result FROM actionable_items WHERE id = $1',
      [cardId]
    )
  );
  expect(stored.rows[0].status).toBe('answered');
  // Answered, skipped (absent), and the free note.
  expect(stored.rows[0].result.answers).toEqual({
    q1: 'CIO-25',
    anything_else: 'Kelvin owns the SFTP piece.',
  });

  // The same card at phone width, freshly raised.
  await withDb((client) =>
    client.query(
      `UPDATE actionable_items SET status = 'suggested', result = NULL, archived_at = NULL, archived_by = NULL, decided_at = NULL, decided_by = NULL WHERE id = $1`,
      [cardId]
    )
  );
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto('/');
  await expect(card.getByRole('radio', { name: 'CIO-26' })).toBeVisible({ timeout: 30_000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, '09-question-batch-mobile');
});
