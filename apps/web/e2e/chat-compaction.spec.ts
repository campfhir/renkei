/**
 * Chat compaction's UI, against a real server and a real database — no
 * model is ever called, by construction: every seeded chat stays under
 * CHAT_COMPACT_MIN_FOLD + CHAT_COMPACT_KEEP_RECENT (compaction.ts), so
 * compactChat's early return fires before any LLM call, and a "compaction
 * already in flight" turn is seeded directly rather than started, since
 * nothing in this process is running it. That keeps every assertion here
 * deterministic and network-free, the same discipline chat.spec.ts and
 * code.spec.ts already follow.
 *
 * Four things get exercised:
 *  - the chat_compact tool call renders with the package icon (static rows,
 *    like chat.spec.ts's own tool-call fold);
 *  - a compaction turn already running (seeded, no live channel — the
 *    multi-replica/reconnect case) shows the live progress card through the
 *    stream route's snapshot-polling fallback, then settles once the row's
 *    status changes underneath it;
 *  - /compact and the prompt picker's quick action both start a REAL
 *    compaction turn through the actual route and SSE stream, settling to
 *    "nothing to fold" on a chat too small to need one;
 *  - a message sent while another turn is already running queues instead
 *    of being silently dropped, and Clear empties the queue again.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  // The mobile project's device descriptor asks for WebKit, which is not
  // installed here (code.spec.ts's own note); the pinned Chromium runs
  // every project.
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** Fixture ids differ per Playwright project — see chat.spec.ts's idsFor. */
function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    modelId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${digit}1`,
    iconChatId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${digit}2`,
    iconTurnId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${digit}3`,
    snapshotChatId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${digit}4`,
    snapshotTurnId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${digit}5`,
    liveChatId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${digit}6`,
    liveTurnId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${digit}7`,
    queueChatId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${digit}8`,
    queueTurnId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${digit}9`,
    iconTitle: `Compaction icon check (${digit})`,
    snapshotTitle: `Compaction snapshot check (${digit})`,
    liveTitle: `Compaction live check (${digit})`,
    queueTitle: `Compaction queue check (${digit})`,
  };
}
type Ids = ReturnType<typeof idsFor>;
const TOOL_USE_ID = 'toolu_e2e_compact_0001';
/** components/icons.tsx's `package` entry — asserted literally, not imported (see chat.spec.ts's header note on the TS loader). */
const PACKAGE_ICON_D = 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5L12 12l8-4.5M12 12v9M8 5.25l8 4.5';

/** `@renkei/crypto`'s content envelope, reproduced — see chat.spec.ts. */
function secretbox(plaintext: string, encoded: string, name: string): string {
  const key = Buffer.from(encoded, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`${name} must decode to 32 bytes for the chat-compaction spec to seed rows.`);
  }
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

function seal(plaintext: string): string {
  const encoded = process.env.CONTENT_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY || '';
  return 'renc1:' + secretbox(plaintext, encoded, 'TOKEN_ENCRYPTION_KEY');
}

function sealSecret(plaintext: string): string {
  return secretbox(plaintext, process.env.TOKEN_ENCRYPTION_KEY ?? '', 'TOKEN_ENCRYPTION_KEY');
}

async function seedModel(client: Client, ids: Ids): Promise<void> {
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
  await client.query(
    `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, enabled, is_default)
     VALUES ($1, $2, $3, 'anthropic', 'e2e-model', $4, true, false)`,
    [
      ids.modelId,
      E2E_TENANT_ID,
      `E2E compaction model ${ids.modelId.slice(-2)}`,
      sealSecret(JSON.stringify({ apiKey: 'e2e' })),
    ]
  );
}

async function insertMessage(
  client: Client,
  input: {
    chatId: string;
    turnId: string;
    seq: number;
    role: string;
    kind: string;
    blocks: unknown[];
    modelId?: string;
  }
): Promise<void> {
  const assistant = input.role === 'assistant';
  await client.query(
    `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model)
     VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10)`,
    [
      E2E_TENANT_ID,
      input.chatId,
      input.turnId,
      input.seq,
      input.role,
      input.kind,
      seal(JSON.stringify(input.blocks)),
      assistant ? (input.modelId ?? null) : null,
      assistant ? 'anthropic' : null,
      assistant ? 'e2e-model' : null,
    ]
  );
}

async function cleanup(client: Client, ids: Ids): Promise<void> {
  for (const chatId of [ids.iconChatId, ids.snapshotChatId, ids.liveChatId, ids.queueChatId]) {
    await client.query('DELETE FROM chats WHERE id = $1', [chatId]);
  }
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
}

test.describe('chat compaction', () => {
  test('a chat_compact tool call renders with the package icon', async ({ page }, testInfo) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const ids = idsFor(testInfo.project.name);
    try {
      await seedModel(client, ids);
      await client.query(
        `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [ids.iconChatId, E2E_TENANT_ID, E2E_SUBJECT, ids.iconTitle, ids.modelId]
      );
      await client.query(
        `INSERT INTO chat_turns (id, tenant_id, chat_id, status, kind, llm_model_id, finished_at)
         VALUES ($1, $2, $3, 'completed', 'reply', $4, NOW())`,
        [ids.iconTurnId, E2E_TENANT_ID, ids.iconChatId, ids.modelId]
      );
      await insertMessage(client, {
        chatId: ids.iconChatId,
        turnId: ids.iconTurnId,
        seq: 1,
        role: 'user',
        kind: 'prompt',
        blocks: [{ type: 'text', text: 'This is getting long — trim the older part.' }],
      });
      await insertMessage(client, {
        chatId: ids.iconChatId,
        turnId: ids.iconTurnId,
        seq: 2,
        role: 'assistant',
        kind: 'assistant',
        modelId: ids.modelId,
        blocks: [
          { type: 'text', text: "I'll compact the earlier part of this conversation." },
          { type: 'tool_use', id: TOOL_USE_ID, name: 'chat_compact', input: {} },
        ],
      });
      await insertMessage(client, {
        chatId: ids.iconChatId,
        turnId: ids.iconTurnId,
        seq: 3,
        role: 'user',
        kind: 'tool_results',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: TOOL_USE_ID,
            content:
              'Folded 12 earlier message(s) into a summary. They will be replaced by the summary starting next turn.',
          },
        ],
      });
      await insertMessage(client, {
        chatId: ids.iconChatId,
        turnId: ids.iconTurnId,
        seq: 4,
        role: 'assistant',
        kind: 'assistant',
        modelId: ids.modelId,
        blocks: [{ type: 'text', text: 'Done — the earlier back-and-forth is now a summary.' }],
      });

      await page.goto(`/${E2E_SLUG}/chat/${ids.iconChatId}`);
      await expect(page.getByRole('heading', { level: 1, name: ids.iconTitle })).toBeVisible();

      const work = page.locator('details.chat-fold', { hasText: '1 tool call' });
      await expect(work).toBeVisible();
      await work.locator('> summary').click();

      const call = work.locator('details.chat-fold', { hasText: 'Compact' });
      await expect(call).toBeVisible();
      await expect(call.locator('> summary')).toContainText('Called');
      await expect(call.locator('> summary svg path').first()).toHaveAttribute('d', PACKAGE_ICON_D);

      await call.locator('> summary').click();
      await expect(call.getByText(/Folded 12 earlier message/)).toBeVisible();
    } finally {
      await cleanup(client, ids);
      await client.end();
    }
  });

  test('a compaction turn already running shows live progress and settles', async ({
    page,
  }, testInfo) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const ids = idsFor(testInfo.project.name);
    try {
      await seedModel(client, ids);
      await client.query(
        `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [ids.snapshotChatId, E2E_TENANT_ID, E2E_SUBJECT, ids.snapshotTitle, ids.modelId]
      );
      // A compaction pass "already in flight" — seeded directly, as if
      // another process/replica started it, so the browser reaches it
      // only through the stream route's snapshot-polling fallback (no
      // in-process channel exists for a turn this test never started).
      await client.query(
        `INSERT INTO chat_turns (id, tenant_id, chat_id, status, kind, llm_model_id)
         VALUES ($1, $2, $3, 'running', 'compaction', $4)`,
        [ids.snapshotTurnId, E2E_TENANT_ID, ids.snapshotChatId, ids.modelId]
      );

      await page.goto(`/${E2E_SLUG}/chat/${ids.snapshotChatId}`);
      await expect(page.getByRole('heading', { level: 1, name: ids.snapshotTitle })).toBeVisible();
      await expect(page.getByText('Compacting the conversation…')).toBeVisible();
      // No progress has been reported yet (a fresh reconnect) — the bar is
      // indeterminate, not a stalled 0%.
      await expect(page.locator('.chat-compact-indeterminate')).toBeVisible();

      // The other process finishes it; the stream route's 1s poll picks it
      // up and the card settles without a page reload.
      await client.query(
        `UPDATE chat_turns SET status = 'completed', finished_at = NOW() WHERE id = $1`,
        [ids.snapshotTurnId]
      );
      await expect(
        page.getByText('Nothing to compact — the conversation is already tight.')
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await cleanup(client, ids);
      await client.end();
    }
  });

  test('/compact and the prompt picker each run a real compaction pass', async ({
    page,
  }, testInfo) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const ids = idsFor(testInfo.project.name);
    try {
      await seedModel(client, ids);
      await client.query(
        `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [ids.liveChatId, E2E_TENANT_ID, E2E_SUBJECT, ids.liveTitle, ids.modelId]
      );
      const turnId = ids.liveTurnId;
      await client.query(
        `INSERT INTO chat_turns (id, tenant_id, chat_id, status, kind, llm_model_id, finished_at)
         VALUES ($1, $2, $3, 'completed', 'reply', $4, NOW())`,
        [turnId, E2E_TENANT_ID, ids.liveChatId, ids.modelId]
      );
      // Well under CHAT_COMPACT_KEEP_RECENT (20) + CHAT_COMPACT_MIN_FOLD (6):
      // compactChat returns null before ever reaching the model.
      await insertMessage(client, {
        chatId: ids.liveChatId,
        turnId,
        seq: 1,
        role: 'user',
        kind: 'prompt',
        blocks: [{ type: 'text', text: 'Just saying hello.' }],
      });
      await insertMessage(client, {
        chatId: ids.liveChatId,
        turnId,
        seq: 2,
        role: 'assistant',
        kind: 'assistant',
        modelId: ids.modelId,
        blocks: [{ type: 'text', text: 'Hello! What can I help with?' }],
      });

      await page.goto(`/${E2E_SLUG}/chat/${ids.liveChatId}`);
      await expect(page.getByRole('heading', { level: 1, name: ids.liveTitle })).toBeVisible();

      // The literal slash command.
      const box = page.getByRole('textbox', { name: 'Message' });
      await box.fill('/compact');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(box).toHaveValue('');
      await expect(
        page.getByText('Nothing to compact — the conversation is already tight.')
      ).toBeVisible({ timeout: 10_000 });

      // The prompt picker's quick action — opened on an empty box, since
      // typing "/" there is the picker's own trigger.
      await expect(box).toHaveValue('');
      await box.press('/');
      const compactAction = page.getByRole('button', { name: /Compact this conversation/ });
      await expect(compactAction).toBeVisible();
      await expect(compactAction.locator('svg path').first()).toHaveAttribute('d', PACKAGE_ICON_D);
      await compactAction.click();
      // Proves a SECOND turn actually started and finished — the card's
      // settled text is already showing from the first pass, so asserting
      // on it alone would pass even if this click did nothing. Polling the
      // database (both the count AND every row's settled status, in the
      // SAME retried check) rather than a "Stop" button: on this tiny,
      // network-free chat the whole pass, insert-to-completed, can finish
      // faster than the UI can be caught mid-transition — and a row exists
      // (count reaches 2) a moment before its status leaves 'running'.
      await expect
        .poll(
          async () => {
            const rows = await client.query(
              `SELECT status FROM chat_turns WHERE chat_id = $1 AND kind = 'compaction'`,
              [ids.liveChatId]
            );
            return rows.rows.length >= 2 && rows.rows.every((row) => row.status === 'completed');
          },
          { timeout: 10_000 }
        )
        .toBe(true);

      // The card reflects the settled state either way.
      await expect(
        page.getByText('Nothing to compact — the conversation is already tight.')
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await cleanup(client, ids);
      await client.end();
    }
  });

  test('a message queues while another turn is already running, and Clear empties it', async ({
    page,
  }, testInfo) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const ids = idsFor(testInfo.project.name);
    try {
      await seedModel(client, ids);
      await client.query(
        `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [ids.queueChatId, E2E_TENANT_ID, E2E_SUBJECT, ids.queueTitle, ids.modelId]
      );
      // A reply "already in flight" from another process — the same
      // running-turn-with-no-channel shape the snapshot test uses, this
      // time to make Composer's `running` true from the first paint.
      await client.query(
        `INSERT INTO chat_turns (id, tenant_id, chat_id, status, kind, llm_model_id)
         VALUES ($1, $2, $3, 'running', 'reply', $4)`,
        [ids.queueTurnId, E2E_TENANT_ID, ids.queueChatId, ids.modelId]
      );

      await page.goto(`/${E2E_SLUG}/chat/${ids.queueChatId}`);
      await expect(page.getByRole('heading', { level: 1, name: ids.queueTitle })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

      const box = page.getByRole('textbox', { name: 'Message' });
      await box.fill('Left this for when it is free.');
      await page.getByRole('button', { name: 'Queue this message' }).click();
      await expect(box).toHaveValue('');
      await expect(page.getByText('1 message queued — sent once this finishes.')).toBeVisible();

      await page.getByRole('button', { name: 'Clear' }).click();
      await expect(page.getByText(/message queued/)).toBeHidden();
    } finally {
      await cleanup(client, ids);
      await client.end();
    }
  });
});
