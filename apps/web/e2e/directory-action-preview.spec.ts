/**
 * The ADManager Plus connector's own preview card (directory-action-preview.ts),
 * exercised the same way widget-card.spec.ts exercises Jira's issue-preview
 * card: seeded straight into the tables, rendered by the real
 * /api/tenant/.../chat/widgets route from the real built bundle, inside the
 * real chat thread.
 *
 * Two things this card needed to prove beyond widget-card.spec.ts's coverage
 * of the shared preview mechanics (which already covers confirm/cancel/
 * model-context/receipt-recall generically):
 *  - it renders its own person-identity/secret/group-pill shape, not the
 *    generic issue-preview fields list;
 *  - a group list with dozens or hundreds of entries (copying membership
 *    from a long-tenured account) stays inside a bounded, scrollable region
 *    instead of blowing the card past a reviewable height or silently
 *    dropping groups the confirm button is about to act on.
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
    chatId: `dddddddd-dddd-4ddd-8ddd-ddddddddd${variant}${digit}1`,
    turnId: `dddddddd-dddd-4ddd-8ddd-ddddddddd${variant}${digit}2`,
    modelId: `dddddddd-dddd-4ddd-8ddd-ddddddddd${variant}${digit}3`,
    toolUseId: `toolu_dirpreview_${variant}${digit}`,
    title: `AD directory action (${variant}${digit})`,
    modelLabel: `Directory preview model ${variant}${digit}`,
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
const seal = (plaintext: string) =>
  'renc1:' +
  secretbox(
    plaintext,
    process.env.CONTENT_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY || ''
  );
const sealSecret = (plaintext: string) =>
  secretbox(plaintext, process.env.TOKEN_ENCRYPTION_KEY ?? '');

/** 120 plausible AD group names — plenty to prove the pill list scrolls
 *  instead of either dropping entries or stretching the card unusably tall. */
const MANY_GROUPS = Array.from({ length: 120 }, (_, i) => `Dept-${String(i + 1).padStart(3, '0')}`);

const COPY_GROUPS_INPUT = {
  instanceId: 'i1',
  domainName: 'corp.example.com',
  samAccountName: 'jdoe',
  groupNames: MANY_GROUPS,
};

function structuredContent(previewId: string) {
  return {
    kind: 'directory_action',
    previewId,
    action: 'Copy group membership',
    tone: 'neutral',
    title: 'Copy groups from Sam Source to Jane Doe',
    subtitle: 'ADManager Plus prod · corp.example.com',
    person: { name: 'Jane Doe', detail: 'jdoe · corp.example.com' },
    secondaryPerson: { label: 'Copying groups from', name: 'Sam Source', detail: 'ssource' },
    groupLists: [{ label: 'Groups to add', groups: MANY_GROUPS, tone: 'add' }],
    confirmTool: 'admanager_add_user_to_groups_confirm',
    confirmLabel: 'Copy groups',
    confirmArgs: COPY_GROUPS_INPUT,
  };
}

async function seedChat(client: Client, ids: Ids, previewId: string): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
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
      blocks: [
        { type: 'text', text: 'Give Jane Doe the same groups as Sam Source.' },
      ],
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
          name: 'admanager_copy_group_membership_preview',
          input: { instanceId: 'i1', domainName: 'corp.example.com', targetSam: 'jdoe', sourceSam: 'ssource' },
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
            'The group copy is awaiting the user’s decision on the preview card. ' +
            'Do not write it another way and do not repeat its contents in your reply.',
          uiResourceUri: DIRECTORY_ACTION_PREVIEW_URI,
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

function noteLine(page: Page, text: string) {
  return page.locator('p[title]', { hasText: text });
}

/**
 * The host iframe (widget-card.tsx) sizes itself from `size-changed`
 * messages the card posts after it renders, with its own 120ms CSS
 * transition on top — a check inside the iframe's own document (anything
 * through `frameLocator`) can be satisfied well before that outer element
 * has grown to fit, which raced a full-page screenshot ahead of the
 * host's resize and clipped the card. Poll the host element itself so a
 * shot only happens once it has actually caught up.
 */
async function waitForCardHeight(page: Page, minHeight: number): Promise<void> {
  const hostFrame = page.locator('iframe[title="Preview card"]');
  await expect
    .poll(async () => (await hostFrame.boundingBox())?.height ?? 0, COLD)
    .toBeGreaterThanOrEqual(minHeight);
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

test('a long group list stays inside a bounded, scrollable pane, with every group still confirmed', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '1');
  const previewId = randomUUID();
  try {
    await seedChat(client, ids, previewId);

    const confirmCall: { value: { name: unknown; arguments: unknown } | null } = { value: null };
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmCall.value = route.request().postDataJSON();
      await route.fulfill({
        json: {
          result: {
            content: [{ type: 'text', text: 'Added Jane Doe to 120 groups.' }],
            isError: false,
            meta: {},
          },
        },
      });
    });

    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText(
      'Copy groups from Sam Source to Jane Doe',
      COLD
    );
    // The card shows who it's for and who it's copying from — not a
    // generic fields list.
    await expect(frame.locator('.person-name').first()).toHaveText('Jane Doe');
    await expect(frame.locator('.person-name', { hasText: 'Sam Source' })).toBeVisible();
    await expect(frame.getByText('Copying groups from')).toBeVisible();

    // The count is visible without scrolling...
    await expect(frame.getByText('Groups to add')).toBeVisible();
    await expect(frame.locator('.group-count')).toHaveText('(120)');

    // ...and every one of the 120 pills is actually in the DOM (nothing
    // silently dropped to keep the card short) even though only a handful
    // are in view at once.
    const chips = frame.locator('.chip-row .chip');
    await expect(chips).toHaveCount(120);
    await expect(chips.first()).toHaveText('Dept-001');
    await expect(chips.last()).toHaveText('Dept-120');

    // The list is bounded, not free to grow the card past a reviewable
    // height: the pill container's rendered height is capped well short
    // of what 120 wrapped pills would take unclipped.
    const listBox = await frame.locator('.chip-row').boundingBox();
    expect(listBox).not.toBeNull();
    expect(listBox!.height).toBeLessThan(150);

    const confirmButton = frame.getByRole('button', { name: 'Copy groups' });
    await expect(confirmButton).toBeVisible();
    await waitForCardHeight(page, 400);
    await shot(page, testInfo, 'directory-action-preview-groups.png');

    await confirmButton.click();
    await expect(frame.locator('.done-headline')).toHaveText('Added Jane Doe to 120 groups.');
    await shot(page, testInfo, 'directory-action-preview-done.png');

    // The confirm call still carries the full, unclipped list — the
    // scroll region is presentation only.
    expect(confirmCall.value).not.toBeNull();
    expect(confirmCall.value?.name).toBe('admanager_add_user_to_groups_confirm');
    expect(confirmCall.value?.arguments).toMatchObject({ groupNames: MANY_GROUPS });

    const note = noteLine(
      page,
      'The user confirmed "Copy groups from Sam Source to Jane Doe" on the preview card'
    );
    await expect(note).toBeVisible(COLD);
    const reply = page.getByText('Stub model: I saw');
    await expect(reply).toBeVisible(COLD);
    await expect
      .poll(() => decisionTurn(client, ids.chatId), COLD)
      .toEqual({ status: 'completed', noteTurnId: expect.any(String) });
  } finally {
    await client.end();
  }
});

test('the card still renders at phone width with a long group list', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '2');
  try {
    await seedChat(client, ids, randomUUID());
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText(
      'Copy groups from Sam Source to Jane Doe',
      COLD
    );
    await expect(frame.locator('.chip-row .chip')).toHaveCount(120);
    await expect(frame.getByRole('button', { name: 'Copy groups' })).toBeVisible(COLD);
    await waitForCardHeight(page, 400);
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    await shot(page, testInfo, 'directory-action-preview-mobile.png');
  } finally {
    await client.end();
  }
});
