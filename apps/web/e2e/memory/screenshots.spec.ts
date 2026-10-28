/**
 * Screenshot sweep of the agent surfaces — a dev aid for LOOKING at layouts
 * (light and dark via the two projects), not a pixel-diff gate. Each test
 * anchors on page content and then captures a full-page PNG under
 * test-results/memory/screens/<project>/.
 *
 * What the pages show is made the way the app makes it, once per worker,
 * for an operator of the sweep's own: a "rich" agent (a schedule and an
 * API trigger, tools) run on the stand-in model by the in-process engine —
 * it remembers a fact, stages a change, is accepted through the card's
 * route and finishes, so there is a run with an accepted batch, memory,
 * and model usage; an agent whose run fails; and a plain one that never
 * ran.
 *
 * What the old Postgres seed wrote and no route or in-process worker can:
 * a dead-lettered event (the events monitor's "Failed · 1"), a run parked
 * for the owner's sign-in, a memory summary the maintenance sweep
 * compacted, usage rows from before the model was recorded, voice usage,
 * and a Jira grant on the access table. Those pages are captured with what
 * they show for this person (their headings, their empty states), and a
 * Jira tool in the picker becomes Renkei's own card tool. "My usage"'s
 * voice card is not captured: it shows only with a voice service
 * configured (a vendor, org-wide) or voice usage on record.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import { MEMORY_BASE_URL } from './constants';
import { createPerson, signIn, type Person } from '../support/person';
import { addStubModel, toolStep, removeModel, stubScript } from '../support/stub-model';
import { createAgent, feedItems, runAgent } from '../support/agents';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');

interface Staged {
  person: Person;
  modelId: string;
  richId: string;
  richName: string;
  richRunId: string;
  plainId: string;
  failedId: string;
  failedRunId: string;
}

let api: APIRequestContext;
let staged: Staged;

const test = base.extend<{ sweep: Staged }>({
  sweep: async ({ page }, use) => {
    await signIn(page.context(), staged.person);
    await use(staged);
  },
});

async function runPage(agentId: string, runId: string): Promise<string> {
  return (await api.get(`/agents/${agentId}/runs/${runId}`)).text();
}

base.describe.configure({ timeout: 120_000 });

// eslint-disable-next-line no-empty-pattern
base.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(240_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const setup = await playwrightRequest.newContext({ baseURL: MEMORY_BASE_URL });
  const person = await createPerson(setup, {
    roles: ['renkei-user', 'renkei-operator'],
    displayName: 'Sweep Tester',
  });
  await setup.dispose();
  api = await playwrightRequest.newContext({
    baseURL: MEMORY_BASE_URL,
    extraHTTPHeaders: person.headers,
  });
  const modelId = await addStubModel(api, tag);

  const richName = `Triage yesterday into tickets ${tag}`;
  const richId = await createAgent(api, {
    name: richName,
    llmModelId: modelId,
    tools: ['card_list', 'card_create'],
    triggers: [
      {
        draft: {
          kind: 'schedule',
          recurrences: [{ every: 'weekday', at: '09:00' }],
          timezone: 'UTC',
        },
        enabled: true,
      },
      { draft: { kind: 'api', inputs: [] }, enabled: true },
    ],
    instructions: [
      '## Goal',
      '',
      'Turn yesterday’s unanswered requests into tickets.',
      '',
      stubScript([
        toolStep('remember', { note: 'Filed OPS-7 for the VPN outage on 10/19.' }),
        toolStep(
          'stage_actions',
          {
            summary: 'File a ticket for the VPN outage.',
            actions: [
              {
                tool: 'card_create',
                args: { title: 'OPS-7', summary: 'VPN outage, no reply yet.' },
                reason: 'Nobody has answered it.',
              },
            ],
          },
          'One request needs a ticket.'
        ),
      ]),
    ].join('\n'),
  });
  const richRunId = await runAgent(api, richId);
  // The batch waits on a person: accept it through the card's own route.
  const title = `${richName} — wants to make a change`;
  let cardId = '';
  await expect
    .poll(
      async () => {
        cardId = (await feedItems(api)).find((item) => item.title === title)?.id ?? '';
        return cardId;
      },
      { timeout: 60_000 }
    )
    .not.toBe('');
  const accepted = await api.post(`/api/actionable-items/${cardId}/approval`, {
    data: { decision: 'approve', comment: 'Go ahead.' },
  });
  expect(accepted.ok(), await accepted.text()).toBe(true);
  await expect
    .poll(async () => (await runPage(richId, richRunId)).includes('Succeeded'), {
      timeout: 60_000,
    })
    .toBe(true);

  const failedId = await createAgent(api, {
    name: `Daily activity digest ${tag}`,
    llmModelId: modelId,
    instructions: [
      '## Goal',
      '',
      'Summarise yesterday’s activity.',
      '',
      stubScript([
        toolStep('finish_run', {
          outcome: 'failed',
          summary: 'The activity feed could not be read.',
        }),
      ]),
    ].join('\n'),
  });
  const failedRunId = await runAgent(api, failedId);
  await expect
    .poll(async () => (await runPage(failedId, failedRunId)).includes('Failed'), {
      timeout: 60_000,
    })
    .toBe(true);

  const plainId = await createAgent(api, {
    name: `Plain agent ${tag}`,
    instructions: '## Goal\n\nSay hello.',
    enabled: false,
  });
  staged = { person, modelId, richId, richName, richRunId, plainId, failedId, failedRunId };
});

base.afterAll(async () => {
  if (staged) await removeModel(api, staged.modelId);
  await api?.dispose();
});

async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { fullPage?: boolean } = {}
): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    // fullPage's temporary viewport resize can remount client subtrees and
    // lose transient state (an opened <details>); shots of transient UI
    // pass fullPage: false and capture the viewport instead.
    fullPage: options.fullPage ?? true,
  });
}

test('admin — agent oversight totals', async ({ page, sweep: _sweep }, testInfo) => {
  await page.goto(`/admin/agents`);
  await expect(page.getByRole('heading', { name: 'Agent oversight' })).toBeVisible();
  // One period at a time: the toggle drives the org card AND every agent
  // card. Flip to a non-default bucket before the shot.
  await page.getByRole('button', { name: 'This quarter' }).click();
  await expect(page.getByText('All agents · this quarter')).toBeVisible();
  await expect(page.getByText('across all agents')).toBeVisible();
  await expect(page.getByText('Model usage')).toBeVisible();
  await shot(page, testInfo, 'admin-agent-oversight');
});

test('admin — agent oversight sorted by tokens', async ({ page, sweep }, testInfo) => {
  await page.goto(`/admin/agents`);
  await expect(page.getByRole('heading', { name: 'Agent oversight' })).toBeVisible();
  await page.getByRole('button', { name: 'This year' }).click();
  await page.getByLabel('Sort by').selectOption('tokensIn');
  // The sweep's spender is listed; the org card names the model it ran on.
  await expect(page.getByRole('link', { name: sweep.richName })).toBeVisible();
  await expect(page.getByText('stub-model', { exact: false }).first()).toBeVisible();
  await shot(page, testInfo, 'admin-agent-oversight-by-tokens');
});

test('admin — agent detail with usage by model', async ({ page, sweep }, testInfo) => {
  await page.goto(`/admin/agents/${sweep.richId}`);
  await expect(page.getByRole('heading', { name: sweep.richName })).toBeVisible();
  await expect(page.getByText('By model · this month')).toBeVisible();
  await shot(page, testInfo, 'admin-agent-detail');
});

test('admin — event monitor', async ({ page, sweep: _sweep }, testInfo) => {
  await page.goto(`/admin/events`);
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
  await shot(page, testInfo, 'admin-events');
});

test('admin — cleaner script reach', async ({ page, sweep: _sweep }, testInfo) => {
  await page.goto(`/admin/email-sanitizer`);
  await expect(page.getByRole('heading', { name: 'Cleaner scripts' })).toBeVisible();
  // The reach control is the point of the shot: a script says which content
  // kinds it may touch, and widening it past mail is a deliberate act.
  const calendar = page.getByRole('checkbox', { name: 'Calendar' });
  await expect(calendar).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Email' })).toBeChecked();
  await calendar.check();
  // Two kinds selected means the dry-run has to ask which one to run as.
  await expect(page.getByLabel('Content kind to test as')).toBeVisible();
  await shot(page, testInfo, 'admin-cleaner-script-reach');
});

test('agents list', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(sweep.richName)).toBeVisible();
  await shot(page, testInfo, 'agents-list');
});

test('agent overview', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}`);
  await expect(page.getByRole('heading', { name: sweep.richName })).toBeVisible();
  await shot(page, testInfo, 'agent-overview');
});

test('agent overview — memory section open', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}`);
  await expect(page.getByRole('heading', { name: sweep.richName })).toBeVisible();
  await page.locator('summary', { hasText: /^Memory$/ }).click();
  // What the run remembered.
  await expect(page.getByText('Filed OPS-7 for the VPN outage on 10/19.').first()).toBeVisible();
  await shot(page, testInfo, 'agent-overview-memory-open');
});

test('agent overview — usage open', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}`);
  await expect(page.getByRole('heading', { name: sweep.richName })).toBeVisible();
  await page.getByText('Usage', { exact: true }).click();
  await expect(page.getByText('Overall · this month')).toBeVisible();
  await page.getByRole('button', { name: 'All time' }).click();
  await expect(page.getByText('stub-model', { exact: false }).first()).toBeVisible();
  await shot(page, testInfo, 'agent-overview-usage-open', { fullPage: false });
});

test('agent overview — invocations open', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}`);
  await expect(page.getByRole('heading', { name: sweep.richName })).toBeVisible();
  await page.getByText('Invocations', { exact: true }).click();
  await expect(page.getByRole('term').filter({ hasText: 'All time' })).toBeVisible();
  await expect(page.getByText('per-day cap', { exact: false })).toBeVisible();
  await shot(page, testInfo, 'agent-overview-invocations-open');
});

test('runs list', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}/runs`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible();
  await shot(page, testInfo, 'runs-list');
});

test('failed run detail', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.failedId}/runs/${sweep.failedRunId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Failed runs carry a copy-to-clipboard of the full debug context, for
  // pasting into Claude Code or another dev tool.
  await expect(page.getByRole('button', { name: 'Copy for debugging' })).toBeVisible();
  await expect(page.getByText('The activity feed could not be read.').first()).toBeVisible();
  await shot(page, testInfo, 'run-detail-failed');
});

test('builder — new agent', async ({ page, sweep: _sweep }, testInfo) => {
  await page.goto(`/agents/new`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'builder-new');
});

test('builder — edit rich agent', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'builder-edit');
});

test('builder — tool picker filtered', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByLabel('Search tools').fill('card');
  await expect(page.getByText('card_create', { exact: true }).first()).toBeVisible();
  await shot(page, testInfo, 'builder-tool-picker');
});

test('builder — schedule editor open (wide panel)', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Every weekday/ }).click();
  await expect(page.getByText('Blackout dates', { exact: false })).toBeVisible();
  await shot(page, testInfo, 'builder-schedule-editor');
});

test('builder — edit plain agent', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.plainId}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'builder-edit-plain');
});

test('run timeline with a staged batch', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}/runs/${sweep.richRunId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('staged-batch')).toBeVisible();
  await expect(page.getByText('Accepted and carried out.')).toBeVisible();
  await shot(page, testInfo, 'run-timeline-batch');
});

test('admin — cleaner script editor with types', async ({ page, sweep: _sweep }, testInfo) => {
  await page.goto(`/admin/email-sanitizer`);
  await expect(page.getByRole('heading', { name: 'Cleaner scripts' })).toBeVisible();

  // Monaco is client-only and lazily imported, so it arrives after hydration.
  await page.locator('.monaco-editor').first().waitFor();
  await page.waitForTimeout(2_000);
  await page.locator('.view-lines').first().click();

  // insertText rather than type(): key events race with auto-closing
  // brackets and completion, which corrupts the input and produces errors
  // that belong to the test rather than to the code under test.
  const write = async (code: string) => {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(code);
    await page.waitForTimeout(3_500);
  };
  const errors = () => page.locator('.squiggly-error').count();

  // The whole point of the editor is that these three differ. If the
  // ambient CleanerEmail declarations failed to load, correct code would
  // report errors too and all three counts would be equal — which is
  // exactly the silent failure this asserts against.
  await write('function clean(email: CleanerEmail): string {\n  return email.text.trim();');
  expect(await errors()).toBe(0);

  await write('function clean(email: CleanerEmail): string {\n  return email.nope;');
  expect(await errors()).toBe(1);

  await write(
    'function clean(email: CleanerEmail): string {\n  const n: number = email.subject;\n  return email.text;'
  );
  expect(await errors()).toBe(1);

  // Per-kind types: a calendar script reaches the invite fields...
  await write(
    "function clean(event: CleanerEvent): string {\n  return event.attendees.join(', ');"
  );
  expect(await errors()).toBe(0);

  // ...and a message script does not, which is the point of narrowing —
  // `attendees` on an email is always an empty array, so a script reading
  // it would silently do nothing.
  await write(
    "function clean(email: CleanerMessage): string {\n  return email.attendees.join(', ');"
  );
  expect(await errors()).toBe(1);

  // The discriminated union narrows on `kind`, so one script can serve
  // several kinds and still reach what each really has.
  await write(
    "function clean(item: CleanerItem): string {\n  if (item.kind !== 'evt') return item.text;\n  return item.attendees.join(', ');"
  );
  expect(await errors()).toBe(0);

  // Completion comes from our own type, not from word-matching the buffer.
  await write('function clean(email: CleanerEmail): string {\n  return email.att');
  await page.keyboard.press('Control+Space');
  const suggestions = page.locator('.suggest-widget');
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByText('attendees', { exact: true })).toBeVisible();

  await shot(page, testInfo, 'admin-cleaner-script-editor');
});

test('connectors — grid', async ({ page, sweep: _sweep }, testInfo) => {
  await page.goto(`/connectors`);
  await expect(page.getByRole('heading', { name: 'Connectors', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'MCP endpoint' })).toBeVisible();
  await shot(page, testInfo, 'connectors-grid');
});

test('tools — headline cards', async ({ page, sweep: _sweep }, testInfo) => {
  await page.goto(`/usage`);
  // The sweep's person is an operator, so all three cards render.
  await expect(page.getByRole('heading', { name: 'Most used across the org' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Most used by you' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Failing most' })).toBeVisible();
  await shot(page, testInfo, 'tools-top-cards');
});

test('my usage — surface breakdown and efficiency', async ({ page, sweep }, testInfo) => {
  await page.goto(`/utilization`);
  await expect(page.getByRole('heading', { name: 'My usage' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tokens by surface' })).toBeVisible();
  // The sweep's runs are this person's own, so their agents rank here.
  await expect(page.getByRole('heading', { name: 'Most efficient agents' })).toBeVisible();
  await expect(page.getByRole('link', { name: sweep.richName }).first()).toBeVisible();
  await shot(page, testInfo, 'my-usage-surface-and-efficiency');
});

test.describe('admin — organization usage', () => {
  test('voice card and boards', async ({ page, sweep: _sweep }, testInfo) => {
    await page.goto(`/admin/usage`);
    await expect(page.getByRole('heading', { name: 'Organization usage' })).toBeVisible();
    const listeners = page.getByRole('heading', { name: 'Top listeners' });
    await expect(listeners).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Top speakers' })).toBeVisible();
    await listeners.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'admin-organization-usage-voice', { fullPage: false });
  });

  test('overview', async ({ page, sweep: _sweep }, testInfo) => {
    await page.goto(`/admin/usage`);
    await expect(page.getByRole('heading', { name: 'Organization usage' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tokens by surface' })).toBeVisible();
    // Agent spend is real (the sweep's runs, and every other spec's on the
    // same server): the board ranks whoever spent most.
    await expect(page.getByRole('heading', { name: 'Top agents' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Most efficient agents' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Top tools' })).toBeVisible();

    await page.getByRole('button', { name: '90 days' }).click();
    await expect(page.getByText('Over the last 90 days')).toBeVisible();
    await shot(page, testInfo, 'admin-organization-usage');
  });

  test('top users toggle', async ({ page, sweep: _sweep }, testInfo) => {
    await page.goto(`/admin/usage`);
    await expect(page.getByRole('heading', { name: 'Organization usage' })).toBeVisible();
    const chatsOnly = page.getByRole('button', { name: 'Chats only' });
    const withAgents = page.getByRole('button', { name: '+ agents' });
    await expect(chatsOnly).toHaveAttribute('aria-pressed', 'true');
    await withAgents.click();
    await expect(withAgents).toHaveAttribute('aria-pressed', 'true');
    await expect(chatsOnly).toHaveAttribute('aria-pressed', 'false');
    await shot(page, testInfo, 'admin-organization-usage-top-users', { fullPage: false });
  });

  test('tokens by model', async ({ page, sweep: _sweep }) => {
    await page.goto(`/admin/usage`);
    await expect(page.getByRole('heading', { name: 'Tokens by model' })).toBeVisible();
    // The sweep's runs spent on the stand-in model.
    await expect(page.getByText('stub-model', { exact: false }).first()).toBeVisible();
  });

  test('today, by the hour', async ({ page, sweep: _sweep }, testInfo) => {
    await page.goto(`/admin/usage?period=today`);
    await expect(page.getByRole('button', { name: 'Today' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByText('Today, by hour')).toBeVisible();
    await page.getByRole('button', { name: 'Yesterday' }).click();
    await expect(page.getByText('Yesterday, by hour')).toBeVisible();
    await shot(page, testInfo, 'admin-organization-usage-yesterday');
  });

  test('scoped to one person', async ({ page, sweep }, testInfo) => {
    // Reached by link, the way Sites points here: the picker lands on the
    // person and the whole page is theirs — identity card, active days in
    // place of active users.
    const subject = sweep.person.subject;
    await page.goto(`/admin/usage?user=${encodeURIComponent(subject)}&period=1m`);
    await expect(page.getByRole('heading', { name: 'Organization usage' })).toBeVisible();
    await expect(page.getByRole('combobox')).toHaveValue(subject);
    await expect(page.getByRole('heading', { name: sweep.person.displayName })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Groups (IdP)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connectors on Access' })).toBeVisible();
    await expect(page.getByRole('figure', { name: 'Active days' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Activity by day' })).toBeVisible();
    await shot(page, testInfo, 'admin-organization-usage-person');

    // A quarter lays the days out as tiny month calendars.
    await page.getByRole('button', { name: '90 days' }).click();
    await expect(page.getByText('Over the last 90 days')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Activity by day' })).toBeVisible();
    await shot(page, testInfo, 'admin-organization-usage-person-quarter');

    // A single day counts hours instead.
    await page.getByRole('button', { name: 'Yesterday' }).click();
    await expect(page.getByRole('figure', { name: 'Active hours, yesterday' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Activity', exact: true })).toBeVisible();
    await shot(page, testInfo, 'admin-organization-usage-person-yesterday');

    // Back to everyone through the picker.
    await page.getByRole('combobox').selectOption('');
    await expect(page.getByText('Active users', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/period=yesterday/);
    await expect(page).not.toHaveURL(/user=/);
  });
});

test('admin — access table', async ({ page, sweep: _sweep }, testInfo) => {
  await page.goto(`/admin/access`);
  await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();
  await shot(page, testInfo, 'admin-access');
});

test('about — changelog', async ({ page, sweep: _sweep }, testInfo) => {
  await page.goto(`/about`);
  // The heading uses a typographic apostrophe, so match on the stable words.
  await expect(page.getByRole('heading', { name: /changed/ })).toBeVisible();
  await shot(page, testInfo, 'about-changelog');
});

test('builder — trigger editor with header remove', async ({ page, sweep }, testInfo) => {
  await page.goto(`/agents/${sweep.richId}/edit`);
  // Trigger cards are named by their own summary text, so anchor on the
  // "gives:" line every one of them carries and let the click bubble.
  await page.getByText('gives:').first().click();
  await expect(page.getByRole('button', { name: 'Remove trigger' })).toBeVisible();
  await shot(page, testInfo, 'builder-trigger-editor', { fullPage: false });
});
