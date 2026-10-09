/**
 * A preview card settled by the model instead of by its own buttons
 * (chat_widget_resolve, lib/chat/widget-state-tools.ts): the person says
 * they already did the thing, the model marks the card decided, and the
 * card — open in the thread, its Create/Cancel buttons live until then —
 * flips to the receipt as the tool returns (the turn's `widget_decided`
 * event, widget-card.tsx's second tool-result notification), stays that
 * way on reload (chat-view.ts's `resolved`), and can no longer be
 * confirmed from the card.
 *
 * Seeded like widget-card.spec.ts: a finished reply whose one tool call is
 * a widget-bound preview, on a model whose base_url is the stub Anthropic
 * endpoint (sandbox-stub.mjs). The model's tool call is real — the stub
 * answers a `[[call …]]` prompt with that tool_use — and so is everything
 * after it: the permission card the runner parks on for a tool that acts,
 * the local tool's write to chat_widget_decisions, the event on the
 * stream. Nothing here reaches a vendor, so nothing is mocked.
 */

import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
import { keyFor } from './keys';

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

/** First hits compile routes in `next dev` (widget-card.spec.ts's allowance). */
const COLD = { timeout: 30_000 };

/**
 * Ids per Playwright project and per test: the projects share one
 * database, and each test drives a turn on its chat (AGENTS.md's "isolate
 * what you create"). The `d` block keeps clear of widget-card.spec.ts's.
 */
function idsFor(project: string, variant: '1' | '2') {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `dddddddd-dddd-4ddd-8ddd-ddddddddd${variant}${digit}1`,
    turnId: `dddddddd-dddd-4ddd-8ddd-ddddddddd${variant}${digit}2`,
    modelId: `dddddddd-dddd-4ddd-8ddd-ddddddddd${variant}${digit}3`,
    toolUseId: `toolu_resolve_${variant}${digit}`,
    title: `Rotate the webhook secret, by hand (${variant}${digit})`,
    modelLabel: `Resolve model ${variant}${digit}`,
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
  await client.query(
    `INSERT INTO llm_model_configs (id, label, provider, model, base_url, encrypted_secrets, enabled, is_default)\n     VALUES ($1, $2, 'anthropic', 'e2e-model', $3, $4, true, false)`,
    [ids.modelId, ids.modelLabel, STUB_MODEL_BASE_URL, sealSecret(JSON.stringify({ apiKey: 'e2e' }))]
  );
  await client.query(
    `INSERT INTO chats (id, owner_subject, title, llm_model_id, last_message_at)\n     VALUES ($1, $2, $3, $4, NOW())`,
    [ids.chatId, E2E_SUBJECT, ids.title, ids.modelId]
  );
  const chatKey = await keyFor(client, {
    kind: 'chat',
    resourceId: ids.chatId,
    ownerSubject: E2E_SUBJECT,
  });
  await client.query(
    `INSERT INTO chat_turns (id, chat_id, status, llm_model_id, iterations, finished_at)\n     VALUES ($1, $2, 'completed', $3, 2, NOW())`,
    [ids.turnId, ids.chatId, ids.modelId]
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
      `INSERT INTO chat_messages (chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model)\n       VALUES ($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9)`,
      [ids.chatId, ids.turnId, row.seq, row.role, row.kind, chatKey.seal(JSON.stringify(row.blocks)), assistant ? ids.modelId : null, assistant ? 'anthropic' : null, assistant ? 'e2e-model' : null]
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

/** The receipt the tool records, read back the way chat-view.ts reads it. */
async function decisionRow(
  client: Client,
  previewId: string
): Promise<{
  decision: string;
  state: { icon: string; headline: string; detail?: string };
} | null> {
  const { rows } = await client.query<{
    decision: string;
    state: { icon: string; headline: string; detail?: string };
  }>('SELECT decision, state FROM chat_widget_decisions WHERE state_key = $1', [`renkei-preview:${previewId}`]);
  return rows[0] ?? null;
}

async function resolveFromTheComposer(
  page: Page,
  testInfo: TestInfo,
  client: Client,
  ids: Ids,
  previewId: string,
  screens: { before: string; ask: string; after: string }
): Promise<void> {
  await page.goto(`/chat/${ids.chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

  // The card is live: its form, its Create button. Scoped to the main
  // column: for a moment after a reload the streamed server render can
  // hold a second, src-less copy of the iframe outside it, which a page-
  // wide locator counts as two cards.
  const frame = page.getByRole('main').frameLocator('iframe[title="Preview card"]');
  await expect(frame.locator('.card-title')).toHaveText('Create Jira issue', COLD);
  await expect(frame.getByRole('button', { name: 'Create' })).toBeVisible();
  await expect(frame.locator('.done-headline')).toHaveCount(0);
  await shot(page, testInfo, screens.before);

  // The person says they did it by hand; the (stub) model reaches for
  // chat_widget_resolve with the card's id — a tool that acts, so the
  // turn parks on the permission card first, like any other write.
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(
    `[[call chat_widget_resolve ${JSON.stringify({
      widget: previewId,
      outcome: 'done',
      headline: 'Created by hand in Jira',
      detail: 'OPS-123, filed from the Jira UI',
    })}]]`
  );
  await box.press('Enter');
  const ask = page.getByRole('group', { name: 'Permission needed' });
  await expect(ask).toBeVisible(COLD);
  await expect(page.getByText('chat_widget_resolve').first()).toBeVisible();
  await shot(page, testInfo, screens.ask);
  await ask.getByRole('button', { name: 'Allow once' }).click();

  // The tool ran: the card flips to the receipt in place — no reload, the
  // same iframe — and its buttons are gone.
  await expect(frame.locator('.done-headline')).toHaveText('Created by hand in Jira', COLD);
  await expect(frame.locator('.done-detail')).toHaveText('OPS-123, filed from the Jira UI');
  await expect(frame.getByRole('button', { name: 'Create' })).toHaveCount(0);
  await expect(frame.locator('.card-title')).toHaveCount(0);
  // And the model's turn carried on to its reply.
  await expect(page.getByText('Stub model: I saw')).toBeVisible(COLD);
  await shot(page, testInfo, screens.after);

  // The row is the one the card's own button would have written, so the
  // receipt is what every later load shows.
  expect(await decisionRow(client, previewId)).toEqual({
    decision: 'confirmed',
    state: {
      icon: 'sent',
      headline: 'Created by hand in Jira',
      detail: 'OPS-123, filed from the Jira UI',
    },
  });
  await page.reload();
  await expect(frame.locator('.done-headline')).toHaveText('Created by hand in Jira', COLD);
  await expect(frame.getByRole('button', { name: 'Create' })).toHaveCount(0);
}

test('the model marks a card decided on the person’s word, and the open card flips to the receipt', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '1');
  const previewId = randomUUID();
  try {
    await seedChat(client, ids, previewId);
    await resolveFromTheComposer(page, testInfo, client, ids, previewId, {
      before: 'widget-resolve-live.png',
      ask: 'widget-resolve-ask.png',
      after: 'widget-resolve-done.png',
    });

    // Once decided, the card's own confirm can no longer run — the same
    // guard as a second device (widget-tools.ts's confirmWidgetTool): a
    // direct call to the card's tools/call route answers already-decided
    // rather than creating the issue after all.
    const refused = await page.request.post(
      `/api/chat/chats/${ids.chatId}/widget/tool-call`,
      {
        data: {
          name: 'jira_create_issue_confirm',
          arguments: { previewId, ...TOOL_INPUT },
          stateKey: `renkei-preview:${previewId}`,
        },
      }
    );
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'already-decided' });
  } finally {
    await client.end();
  }
});

test('the same, at phone width', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  await page.setViewportSize(MOBILE_VIEWPORT);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '2');
  const previewId = randomUUID();
  try {
    await seedChat(client, ids, previewId);
    await resolveFromTheComposer(page, testInfo, client, ids, previewId, {
      before: 'widget-resolve-live-mobile.png',
      ask: 'widget-resolve-ask-mobile.png',
      after: 'widget-resolve-done-mobile.png',
    });
  } finally {
    await client.end();
  }
});
