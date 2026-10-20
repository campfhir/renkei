/**
 * The generic act-preview card (lib/mcp-tools/generic-preview.ts): the
 * preview every act tool without a hand-written one gets, rendered by the
 * directory-action template as a titled list of the call's arguments —
 * no person block, no group lists.
 *
 * Seeded straight into the tables like directory-action-preview.spec.ts
 * (the real widget route, the real built bundle, the real chat thread);
 * only the confirm button's `tools/call` is mocked at the browser edge,
 * since for real it would reach Confluence.
 *
 * What it proves beyond that spec's coverage of the shared mechanics:
 *  - a card with only `fields` renders them as rows, long values included,
 *    and shows no empty identity block;
 *  - the confirm button runs the tool's `_confirm` twin with exactly the
 *    arguments the model supplied;
 *  - Cancel runs nothing.
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
const COLD = { timeout: 30_000 };
const STUB_MODEL_BASE_URL = 'http://127.0.0.1:8092/anthropic';

function widgetUri(generatedFile: string, name: string): string {
  const source = readFileSync(
    path.join(import.meta.dirname, '..', 'lib', 'mcp-widgets', 'generated', generatedFile),
    'utf8'
  );
  const match = source.match(/_HASH: string = "([0-9a-f]+)"/);
  if (!match) throw new Error(`No hash constant found in ${generatedFile}`);
  return `ui://widget/${name}.${match[1]}.html`;
}
const DIRECTORY_ACTION_PREVIEW_URI = widgetUri(
  'directory-action-preview.ts',
  'directory-action-preview'
);

function idsFor(project: string, variant: '1' | '2' | '3') {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}1`,
    turnId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}2`,
    modelId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}3`,
    toolUseId: `toolu_genericact_${variant}${digit}`,
    title: `Generic act preview (${variant}${digit})`,
    modelLabel: `Generic preview model ${variant}${digit}`,
  };
}
type Ids = ReturnType<typeof idsFor>;

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

const DELETE_PAGE_INPUT = { pageId: '98765', draft: false };

function structuredContent(previewId: string) {
  return {
    kind: 'directory_action',
    previewId,
    action: 'Delete',
    tone: 'caution',
    title: 'Delete a page',
    subtitle: 'Confluence',
    fields: [
      { label: 'Page id', value: '98765' },
      { label: 'Draft', value: 'false' },
      { label: 'Reason', value: 'Superseded by the 2026 handbook. '.repeat(12).trim() },
    ],
    confirmTool: 'confluence_delete_page_confirm',
    confirmLabel: 'Delete',
    confirmArgs: DELETE_PAGE_INPUT,
  };
}

async function seedChat(client: Client, ids: Ids, previewId: string): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
  await client.query(
    `INSERT INTO llm_model_configs (id, label, provider, model, base_url, encrypted_secrets, enabled, is_default)\n     VALUES ($1, $2, 'anthropic', 'e2e-model', $3, $4, true, false)`,
    [
      ids.modelId,
      ids.modelLabel,
      STUB_MODEL_BASE_URL,
      sealSecret(JSON.stringify({ apiKey: 'e2e' })),
    ]
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
      blocks: [{ type: 'text', text: 'Delete the old handbook page.' }],
    },
    {
      seq: 2,
      role: 'assistant',
      kind: 'assistant',
      blocks: [
        { type: 'text', text: 'Here’s a preview — nothing changes until you confirm.' },
        {
          type: 'tool_use',
          id: ids.toolUseId,
          name: 'confluence_delete_page_preview',
          input: DELETE_PAGE_INPUT,
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
            'Delete a page is awaiting the user’s decision on the preview card. ' +
            'Do not run it another way and do not repeat its contents in your reply.',
          uiResourceUri: DIRECTORY_ACTION_PREVIEW_URI,
          structuredContent: structuredContent(previewId),
        },
      ],
    },
  ];
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    await client.query(
      `INSERT INTO chat_messages (chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model)\n       VALUES ($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9)`,
      [
        ids.chatId,
        ids.turnId,
        row.seq,
        row.role,
        row.kind,
        chatKey.seal(JSON.stringify(row.blocks)),
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

function noteLine(page: Page, text: string) {
  return page.locator('p[title]', { hasText: text });
}

/**
 * The host iframe (widget-card.tsx) sizes itself from `size-changed`
 * messages the card posts after it renders, with its own 120ms CSS
 * transition on top — a check inside the iframe's own document (anything
 * through `frameLocator`) can be satisfied well before that outer element
 * has grown or shrunk to match, which raced a full-page screenshot ahead
 * of the host's resize and clipped a still-growing card. Poll the host
 * element itself so a shot only happens once it has actually caught up.
 */
function cardHeight(page: Page): Promise<number> {
  return page
    .locator('iframe[title="Preview card"]')
    .boundingBox()
    .then((box) => box?.height ?? 0);
}
async function waitForCardHeightAtLeast(page: Page, minHeight: number): Promise<void> {
  await expect.poll(() => cardHeight(page), COLD).toBeGreaterThanOrEqual(minHeight);
}
async function waitForCardHeightBelow(page: Page, maxHeight: number): Promise<void> {
  await expect.poll(() => cardHeight(page), COLD).toBeLessThan(maxHeight);
}

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

test('a generic act card lists the arguments, confirms through its twin, and never shows an identity block', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '1');
  try {
    await seedChat(client, ids, randomUUID());

    const confirmCall: { value: { name: unknown; arguments: unknown } | null } = { value: null };
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmCall.value = route.request().postDataJSON();
      await route.fulfill({
        json: {
          result: {
            content: [{ type: 'text', text: 'Deleted page 98765.' }],
            isError: false,
            meta: {},
          },
        },
      });
    });

    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText('Delete a page', COLD);
    await expect(frame.getByText('Review — nothing changes until you confirm.')).toBeVisible();
    // One row per argument, labelled for a person.
    await expect(frame.locator('.field-label')).toHaveText(['Page id', 'Draft', 'Reason']);
    await expect(frame.locator('.field-value').first()).toHaveText('98765');
    // A card about a page has no one's account to show.
    await expect(frame.locator('.person-name')).toHaveCount(0);

    const confirmButton = frame.getByRole('button', { name: 'Delete', exact: true });
    await expect(confirmButton).toBeVisible();
    await waitForCardHeightAtLeast(page, 200);
    await shot(page, testInfo, 'generic-act-preview.png');

    await confirmButton.click();
    await expect(frame.locator('.done-headline')).toHaveText('Deleted page 98765.');
    await waitForCardHeightBelow(page, 150);
    await shot(page, testInfo, 'generic-act-preview-done.png');

    // The twin, with the model's own arguments.
    expect(confirmCall.value?.name).toBe('confluence_delete_page_confirm');
    expect(confirmCall.value?.arguments).toEqual(DELETE_PAGE_INPUT);

    await expect(
      noteLine(page, 'The user confirmed "Delete a page" on the preview card')
    ).toBeVisible(COLD);
    await expect(page.getByText('Stub model: I saw')).toBeVisible(COLD);
    await expect
      .poll(() => decisionTurn(client, ids.chatId), COLD)
      .toEqual({ status: 'completed', noteTurnId: expect.any(String) });
  } finally {
    await client.end();
  }
});

test('cancelling a generic act card runs nothing', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '2');
  try {
    await seedChat(client, ids, randomUUID());
    let confirmed = false;
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmed = true;
      await route.abort();
    });
    await page.goto(`/chat/${ids.chatId}`);
    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText('Delete a page', COLD);
    await frame.getByRole('button', { name: 'Cancel' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Cancelled');
    await expect(
      noteLine(page, 'The user cancelled "Delete a page" from the preview card')
    ).toBeVisible(COLD);
    expect(confirmed).toBe(false);
  } finally {
    await client.end();
  }
});

test('the generic card still renders at phone width', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '3');
  try {
    await seedChat(client, ids, randomUUID());
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText('Delete a page', COLD);
    await expect(frame.getByRole('button', { name: 'Delete', exact: true })).toBeVisible(COLD);
    await waitForCardHeightAtLeast(page, 200);
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    await shot(page, testInfo, 'generic-act-preview-mobile.png');
  } finally {
    await client.end();
  }
});
