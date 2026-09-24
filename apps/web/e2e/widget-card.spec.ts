/**
 * A chat reply whose tool call is bound to an MCP Apps widget card
 * (`_meta.ui.resourceUri`, lib/mcp-tools/widgets.ts): the thread renders
 * the real widget bundle in a sandboxed iframe (widget-card.tsx) instead
 * of the raw JSON `structuredContent` a plain tool result would show.
 *
 * Seeded straight into the tables, sealed the way the app seals them, same
 * as chat.spec.ts and chat-permission.spec.ts. The widget HTML itself is
 * real (served by the real /api/tenant/.../chat/widgets route from the
 * real built bundle), and the `ui/update-model-context` a decision sends
 * is a real write to the real database that opens a real turn — the
 * model's reply to the decision is what a person waits for after the
 * card, so the turn actually runs here, against the stub Anthropic
 * endpoint in sandbox-stub.mjs (the seeded model's base_url points at
 * it). Only the confirm button's `tools/call` is mocked at the browser
 * edge, since for real it would reach Jira (AGENTS.md's "mock it with
 * page.route when it would hit a real vendor/provider").
 */

import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** The built widget bundle's own `ui://` URI — read off disk, not imported
 *  (e2e specs stay free of workspace-package transpilation; see seed.ts). */
function widgetUri(generatedFile: string, name: string): string {
  const source = readFileSync(
    path.join(import.meta.dirname, '..', 'lib', 'mcp-widgets', 'generated', generatedFile),
    'utf8'
  );
  const match = source.match(/_HASH: string = "([0-9a-f]+)"/);
  if (!match) throw new Error(`No hash constant found in ${generatedFile}`);
  return `ui://widget/${name}.${match[1]}.html`;
}
const ISSUE_PREVIEW_URI = widgetUri('issue-preview.ts', 'issue-preview');

/** The stub model's base URL (sandbox-stub.mjs's handleAnthropic). */
const STUB_MODEL_BASE_URL = 'http://127.0.0.1:8092/anthropic';

/**
 * The first hit on a route compiles it (`next dev` builds lazily), and the
 * widget's iframe, the model-context route and the turn's stream are each
 * a first hit in a fresh dev server — the 5s default is not enough for
 * the step that lands on one (code-active-chat.spec.ts's allowance).
 */
const COLD = { timeout: 30_000 };

/**
 * Ids per Playwright project and per test: the projects share one
 * database, and each test here drives a decision that opens a turn on
 * its chat, so two tests on one chat would race on the one running turn
 * a chat allows (AGENTS.md's "isolate what you create").
 */
function idsFor(project: string, variant: '1' | '2' | '3') {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `cccccccc-cccc-4ccc-8ccc-ccccccccc${variant}${digit}1`,
    turnId: `cccccccc-cccc-4ccc-8ccc-ccccccccc${variant}${digit}2`,
    modelId: `cccccccc-cccc-4ccc-8ccc-ccccccccc${variant}${digit}3`,
    toolUseId: `toolu_widget_${variant}${digit}`,
    title: `Rotate the webhook secret (${variant}${digit})`,
    modelLabel: `Widget model ${variant}${digit}`,
  };
}
type Ids = ReturnType<typeof idsFor>;

/** `@renkei/crypto`'s content envelope, reproduced (see chat.spec.ts's note). */
function secretbox(plaintext: string, encoded: string): string {
  const key = Buffer.from(encoded, 'base64');
  if (key.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}
const seal = (plaintext: string) =>
  'renc1:' +
  secretbox(
    plaintext,
    process.env.CONTENT_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY || ''
  );
const sealSecret = (plaintext: string) =>
  secretbox(plaintext, process.env.TOKEN_ENCRYPTION_KEY ?? '');

const TOOL_INPUT = {
  projectKey: 'OPS',
  issueType: 'Task',
  summary: 'Rotate the Zoom webhook secret',
  description: 'The current secret is six months old.',
};

function structuredContent(previewId: string) {
  return {
    kind: 'issue',
    previewId,
    title: 'Create Jira issue',
    subtitle: 'OPS · Task',
    confirmTool: 'jira_create_issue_confirm',
    confirmLabel: 'Create',
    confirmArgs: TOOL_INPUT,
    editable: { summaryKey: 'summary', descriptionKey: 'description' },
    fields: [
      { label: 'Project', value: 'OPS' },
      { label: 'Type', value: 'Task' },
    ],
  };
}

/** A completed reply whose only tool call is a widget-bound preview. */
async function seedChat(client: Client, ids: Ids, previewId: string): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
  // base_url points the app's Anthropic adapter at the stub, so the turn
  // a decision opens gets a reply without the network.
  await client.query(
    `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, base_url, encrypted_secrets, enabled, is_default)
     VALUES ($1, $2, $3, 'anthropic', 'e2e-model', $4, $5, true, false)`,
    [
      ids.modelId,
      E2E_TENANT_ID,
      ids.modelLabel,
      STUB_MODEL_BASE_URL,
      sealSecret(JSON.stringify({ apiKey: 'e2e' })),
    ]
  );
  await client.query(
    `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [ids.chatId, E2E_TENANT_ID, E2E_SUBJECT, ids.title, ids.modelId]
  );
  await client.query(
    `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, finished_at)
     VALUES ($1, $2, $3, 'completed', $4, 2, NOW())`,
    [ids.turnId, E2E_TENANT_ID, ids.chatId, ids.modelId]
  );
  const rows: { seq: number; role: string; kind: string; blocks: unknown[] }[] = [
    {
      seq: 1,
      role: 'user',
      kind: 'prompt',
      blocks: [{ type: 'text', text: 'File a task to rotate the Zoom webhook secret.' }],
    },
    {
      seq: 2,
      role: 'assistant',
      kind: 'assistant',
      blocks: [
        { type: 'text', text: 'Here’s a preview — nothing is created until you confirm.' },
        {
          type: 'tool_use',
          id: ids.toolUseId,
          name: 'jira_create_issue_preview',
          input: TOOL_INPUT,
        },
      ],
    },
    {
      seq: 3,
      role: 'user',
      kind: 'tool_results',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: ids.toolUseId,
          content:
            'The new Task in OPS is awaiting the user’s decision on the preview card. ' +
            'Do not write it another way and do not repeat its contents in your reply.',
          uiResourceUri: ISSUE_PREVIEW_URI,
          structuredContent: structuredContent(previewId),
        },
      ],
    },
  ];
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    await client.query(
      `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model)
       VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10)`,
      [
        E2E_TENANT_ID,
        ids.chatId,
        ids.turnId,
        row.seq,
        row.role,
        row.kind,
        seal(JSON.stringify(row.blocks)),
        assistant ? ids.modelId : null,
        assistant ? 'anthropic' : null,
        assistant ? 'e2e-model' : null,
      ]
    );
  }
}

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

/**
 * The note line the decision became (message-list.tsx's PersonNote): a
 * small `<p>` carrying the whole text as its title — which is what tells
 * it apart from the model's reply quoting the same sentence back.
 */
function noteLine(page: Page, text: string) {
  return page.locator('p[title]', { hasText: text });
}

/**
 * The turn a decision opened, once it has run its course: the note row
 * the decision became, on that turn, and the turn's status.
 */
async function decisionTurn(
  client: Client,
  chatId: string
): Promise<{ status: string; noteTurnId: string | null } | null> {
  const { rows } = await client.query<{ status: string; note_turn_id: string | null }>(
    `SELECT t.status, m.turn_id AS note_turn_id
       FROM chat_messages m
       LEFT JOIN chat_turns t ON t.id = m.turn_id
      WHERE m.chat_id = $1 AND m.kind = 'note'
      ORDER BY m.seq DESC LIMIT 1`,
    [chatId]
  );
  const row = rows[0];
  return row ? { status: row.status, noteTurnId: row.note_turn_id } : null;
}

test('a preview tool renders its card, and confirming it runs the real tool call and the model replies', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '1');
  const previewId = randomUUID();
  try {
    await seedChat(client, ids, previewId);

    // Mocked because a real confirm would reach Jira (AGENTS.md's rule).
    // Wrapped in an object rather than reassigned directly: TS cannot
    // narrow a bare `let` reassigned only inside this closure, so a
    // direct `confirmCall = ...` here leaves every later read typed
    // `never` once the outer scope asserts it non-null.
    const confirmCall: { value: { name: unknown; arguments: unknown } | null } = { value: null };
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmCall.value = route.request().postDataJSON();
      await route.fulfill({
        json: {
          result: {
            content: [
              {
                type: 'text',
                // A blank line before the link, matching the real confirm
                // tools' shape (jira/write.ts) — the card's headline is
                // only the first line, the link its own paragraph.
                text: 'Created issue OPS-99.\n\n[Open in Jira](https://example.atlassian.net/browse/OPS-99)',
              },
            ],
            isError: false,
            meta: {},
          },
        },
      });
    });

    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

    // The card, not a folded raw-JSON block: the widget iframe with its own
    // rendered title, subtitle and fields inside.
    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText('Create Jira issue', COLD);
    await expect(frame.locator('.card-subtitle').first()).toHaveText('OPS · Task');
    await expect(frame.getByText('Project')).toBeVisible();
    await expect(frame.locator('.field-value', { hasText: 'OPS' })).toBeVisible();
    const confirmButton = frame.getByRole('button', { name: 'Create' });
    await expect(confirmButton).toBeVisible();
    await shot(page, testInfo, 'widget-card-preview.png');

    // Click Create: the card's tools/call is proxied through the mocked
    // route (widget-card.tsx), and the receipt replaces the form.
    await confirmButton.click();
    await expect(frame.locator('.done-headline')).toHaveText('Created issue OPS-99.');
    const link = frame.getByRole('link', { name: 'Open in Jira' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://example.atlassian.net/browse/OPS-99');
    await shot(page, testInfo, 'widget-card-done.png');

    expect(confirmCall.value).not.toBeNull();
    expect(confirmCall.value?.name).toBe('jira_create_issue_confirm');
    expect(confirmCall.value?.arguments).toMatchObject({
      projectKey: 'OPS',
      summary: 'Rotate the Zoom webhook secret',
    });

    // ui/update-model-context is NOT mocked — a real note row that is
    // ALSO the user row of a new turn, so the model takes its turn on
    // the decision right away instead of waiting for the person to type
    // something. The thread shows the note as a small line (never a
    // bubble) and streams the reply under it; the stub model quotes what
    // it was handed, so the reply proves the decision reached it.
    const note = noteLine(page, 'The user confirmed "Create Jira issue" on the preview card');
    await expect(note).toBeVisible(COLD);
    const reply = page.getByText('Stub model: I saw');
    await expect(reply).toBeVisible(COLD);
    await expect(reply).toContainText('The user confirmed "Create Jira issue"');
    await expect(reply).toContainText('Created issue OPS-99');
    await shot(page, testInfo, 'widget-card-replied.png');

    // The rows behind it: the note carries the turn it opened, and that
    // turn ran to completion — the composer is the person's again.
    await expect
      .poll(() => decisionTurn(client, ids.chatId), COLD)
      .toEqual({ status: 'completed', noteTurnId: expect.any(String) });
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();

    // The card's "already decided" receipt is localStorage-backed
    // (ui.ts's rememberDone/recallDone), and this sandbox is deliberately
    // `allow-scripts` with no `allow-same-origin` (see widget-card.tsx's
    // note on why) — an opaque origin gets a fresh, unlinked storage
    // partition on every load, so a reload cannot recall it. ui.ts
    // documents exactly this as the accepted degradation: "the card
    // degrades to re-showing the form, never to re-sending." The stored
    // tool_result is unchanged, so the form reappears rather than the
    // receipt — never a re-send, since nothing here re-fires the call.
    await page.reload();
    await expect(frame.locator('.card-title')).toHaveText('Create Jira issue');
    await expect(frame.getByRole('button', { name: 'Create' })).toBeVisible();
    // The note and the reply are rows now, so they are still there.
    await expect(
      noteLine(page, 'The user confirmed "Create Jira issue" on the preview card')
    ).toBeVisible();
    await expect(page.getByText('Stub model: I saw')).toBeVisible();
  } finally {
    await client.end();
  }
});

test('cancelling the card is a decision too: the model replies to it', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '2');
  try {
    await seedChat(client, ids, randomUUID());
    // Cancel never calls a tool; a hit here would be a bug.
    const confirmCalls: unknown[] = [];
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmCalls.push(route.request().postDataJSON());
      await route.fulfill({ status: 500, json: { error: 'not expected' } });
    });

    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();
    const frame = page.frameLocator('iframe[title="Preview card"]');
    const cancelButton = frame.getByRole('button', { name: 'Cancel' });
    await expect(cancelButton).toBeVisible(COLD);

    await cancelButton.click();
    await expect(frame.locator('.done-headline')).toHaveText('Cancelled');
    expect(confirmCalls).toEqual([]);

    // The cancellation is what the model is told, and it answers that.
    const note = noteLine(page, 'The user cancelled "Create Jira issue" from the preview card');
    await expect(note).toBeVisible(COLD);
    const reply = page.getByText('Stub model: I saw');
    await expect(reply).toBeVisible(COLD);
    await expect(reply).toContainText('The user cancelled "Create Jira issue"');
    await expect
      .poll(() => decisionTurn(client, ids.chatId), COLD)
      .toEqual({ status: 'completed', noteTurnId: expect.any(String) });
    await shot(page, testInfo, 'widget-card-cancelled.png');
  } finally {
    await client.end();
  }
});

test('the card still renders at phone width', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '3');
  try {
    await seedChat(client, ids, randomUUID());
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText('Create Jira issue', COLD);
    // No horizontal scroll: the card's iframe wrapper is capped, not fixed-width.
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    await shot(page, testInfo, 'widget-card-mobile.png');
  } finally {
    await client.end();
  }
});
