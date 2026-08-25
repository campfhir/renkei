/**
 * Screenshot sweep of the agent surfaces — a dev aid for LOOKING at layouts
 * (light/dark/mobile via the three projects), not a pixel-diff gate. Each
 * test anchors on page content (never the <title>, which is still the
 * create-next-app default) and then captures a full-page PNG under
 * test-results/screens/<project>/.
 */

import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import {
  E2E_SLUG,
  AGENT_RICH_ID,
  AGENT_PLAIN_ID,
  AGENT_DEEP_ID,
  RUN_STEP_FAILED_ID,
  RUN_ITERATIONS_ID,
  DEEP_LOOP_NAME,
  DEEP_BRANCH_NAME,
} from './seed';

async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { fullPage?: boolean } = {}
): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
    // fullPage's temporary viewport resize can remount client subtrees and
    // lose transient state (an opened <details>); shots of transient UI
    // pass fullPage: false and capture the viewport instead.
    fullPage: options.fullPage ?? true,
  });
}

test('admin — agent oversight totals', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/admin/agents`);
  await expect(page.getByRole('heading', { name: 'Agent oversight' })).toBeVisible();
  // One period at a time: the toggle drives the org total AND the per-agent
  // Runs and Failures columns. Flip to a non-default bucket before the shot.
  await page.getByRole('button', { name: 'This quarter' }).click();
  await expect(page.getByRole('columnheader', { name: 'Runs (this quarter)' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Failures (this quarter)' })).toBeVisible();
  await expect(page.getByText('across all agents')).toBeVisible();
  await shot(page, testInfo, 'admin-agent-oversight');
});

test('admin — event monitor', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/admin/events`);
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
  // One seeded row per renderable status, failed (dead-lettered) included.
  await expect(page.getByText('Failed · 1')).toBeVisible();
  await shot(page, testInfo, 'admin-events');
});

test('admin — cleaner script reach', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/admin/email-sanitizer`);
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

test('agents list', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Triage yesterday into tickets')).toBeVisible();
  await shot(page, testInfo, 'agents-list');
});

test('agent overview', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}`);
  await expect(page.getByRole('heading', { name: 'Triage yesterday into tickets' })).toBeVisible();
  await shot(page, testInfo, 'agent-overview');
});

test('agent overview — memory section open', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}`);
  await expect(page.getByRole('heading', { name: 'Triage yesterday into tickets' })).toBeVisible();
  const isMobile = testInfo.project.name === 'mobile';
  if (isMobile) {
    // On phones the section is a button that opens a modal.
    await page.getByRole('button', { name: 'Memory' }).click();
    await expect(page.getByRole('dialog', { name: 'Memory' })).toBeVisible();
  } else {
    await page.getByText('Memory', { exact: true }).click();
  }
  await expect(page.getByText('Summary (compacted', { exact: false })).toBeVisible();
  await shot(page, testInfo, 'agent-overview-memory-open');
});

test('agent overview — invocations open', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}`);
  await expect(page.getByRole('heading', { name: 'Triage yesterday into tickets' })).toBeVisible();
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Invocations' }).click();
    await expect(page.getByRole('dialog', { name: 'Invocations' })).toBeVisible();
  } else {
    await page.getByText('Invocations', { exact: true }).click();
  }
  await expect(page.getByText('All time')).toBeVisible();
  // Seeded counters: 3 today +4 this week (2d ago) +6 this month (12d) …
  await expect(page.getByText('per-day cap', { exact: false })).toBeVisible();
  await shot(page, testInfo, 'agent-overview-invocations-open');
});

test('runs list', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/runs`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'runs-list');
});

test('failed run detail', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/runs/${RUN_STEP_FAILED_ID}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Failed runs carry a copy-to-clipboard of the full debug context, for
  // pasting into Claude Code or another dev tool.
  await expect(page.getByRole('button', { name: 'Copy for debugging' })).toBeVisible();
  await shot(page, testInfo, 'run-detail-failed');
});

test('builder — new agent', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/new`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'builder-new');
});

test('builder — edit rich agent', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'builder-edit');
});

test('builder — step editor open', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /File follow-up tickets/ }).click();
  // Desktop: docked sidebar; mobile: modal — either way the step name field
  // appears in the editing surface.
  await expect(page.getByLabel('Step name')).toBeVisible();
  const failureSummary = page.locator('summary', { hasText: 'If something goes wrong' });
  await expect(failureSummary).toBeVisible();
  // Expanded for the screenshot — the disclosure is collapsed by default.
  await failureSummary.click();
  await failureSummary.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'builder-step-editor', { fullPage: false });
});

test('builder — branch editor open', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Edit branch: Anything actionable/ }).click();
  await expect(page.getByLabel('Branch name')).toBeVisible();
  await expect(page.getByLabel('Name of path 1')).toBeVisible();
  await expect(page.getByText('If this decision fails, take a failure route')).toBeVisible();
  await shot(page, testInfo, 'builder-branch-editor');
});

test('builder — schedule editor open (wide panel)', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Every weekday/ }).click();
  await expect(page.getByText('Blackout dates', { exact: false })).toBeVisible();
  await shot(page, testInfo, 'builder-schedule-editor');
});

test('builder — edit plain agent', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_PLAIN_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, testInfo, 'builder-edit-plain');
});

/* ------------------------- v3 deep agent shots ---------------------- */

test('builder — edit deep agent (loop container)', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_DEEP_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The loop container is expanded by default at depth 1 — its body and
  // the decorative back-edge are on screen.
  await expect(page.getByRole('button', { name: `Edit loop: ${DEEP_LOOP_NAME}` })).toBeVisible();
  await expect(page.getByText(/repeats up to 10×/)).toBeVisible();
  await shot(page, testInfo, 'builder-edit-deep');
});

test('builder — loop editor open', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_DEEP_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: `Edit loop: ${DEEP_LOOP_NAME}` }).click();
  await expect(page.getByLabel('The list to go through')).toBeVisible();
  await expect(page.getByText('Collect results into a list')).toBeVisible();
  await shot(page, testInfo, 'builder-loop-editor');
});

test('builder — three-way router expanded', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_DEEP_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The branch sits at display depth 2 (inside the loop), so it folds by
  // default — expand it for the shot of the vertical route rows.
  await page.getByRole('button', { name: `Expand branch: ${DEEP_BRANCH_NAME}` }).click();
  await expect(page.getByText('Route 1: Critical')).toBeVisible();
  await expect(page.getByText('Otherwise: Not worth acting on')).toBeVisible();
  await expect(page.getByText('If this decision fails: If triage fails')).toBeVisible();
  await shot(page, testInfo, 'builder-router-3way');
});

test('builder — drill into the loop', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_DEEP_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: `Open loop: ${DEEP_LOOP_NAME}` }).click();
  await expect(page.getByRole('navigation', { name: 'Flow breadcrumb' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Whole flow' })).toBeVisible();
  await shot(page, testInfo, 'builder-drill-in');
});

test('builder — move-to menu', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_DEEP_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Edit step 1: Collect the queue/ }).click();
  if (testInfo.project.name === 'mobile') {
    // On phones the selected node's controls ride in the editor modal's
    // footer as a Move to… select.
    await expect(page.getByLabel('Move to another list')).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'Move step to another list' }).click();
    await expect(page.getByRole('button', { name: `Loop "${DEEP_LOOP_NAME}"` })).toBeVisible();
  }
  await shot(page, testInfo, 'builder-move-to-menu', { fullPage: false });
});

test('run timeline with iterations', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_DEEP_ID}/runs/${RUN_ITERATIONS_ID}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Looped steps group their rounds under amber iteration sub-headers.
  await expect(page.getByText('Iteration 1').first()).toBeVisible();
  await expect(page.getByText('Iteration 2').first()).toBeVisible();
  await shot(page, testInfo, 'run-timeline-iterations');
});

test('admin — cleaner script editor with types', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/admin/email-sanitizer`);
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

test('connectors — grid', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/connectors`);
  await expect(page.getByRole('heading', { name: 'Connectors', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'MCP endpoint' })).toBeVisible();
  await shot(page, testInfo, 'connectors-grid');
});

test('tools — headline cards', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/usage`);
  // The seeded session is an operator, so all three cards render.
  await expect(page.getByRole('heading', { name: 'Most used across the org' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Most used by you' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Failing most' })).toBeVisible();
  await shot(page, testInfo, 'tools-top-cards');
});

test('about — changelog', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/about`);
  // The heading uses a typographic apostrophe, so match on the stable words.
  await expect(page.getByRole('heading', { name: /changed/ })).toBeVisible();
  await shot(page, testInfo, 'about-changelog');
});

test('builder — trigger editor with header remove', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
  // Trigger cards are named by their own summary text, so anchor on the
  // "gives:" line every one of them carries and let the click bubble.
  await page.getByText('gives:').first().click();
  await expect(page.getByRole('button', { name: 'Remove trigger' })).toBeVisible();
  await shot(page, testInfo, 'builder-trigger-editor', { fullPage: false });
});
