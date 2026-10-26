/**
 * The chat's context meter: how many tokens the conversation uses against
 * the model's recorded context window, as a small ring. No model is called
 * — the chat is seeded with an assistant reply carrying `usage`, the way a
 * finished turn leaves it. Cases: a model with a window (the ring), a model
 * without one (nothing shown), a compaction since the reply (the ring
 * resets), and a phone-width pass.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { test, expect } from './worker-env';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
import { keyFor } from './keys';
import { shot } from './voice-fixtures';
import { isolateFile } from './worker-env';

// Each file starts from a database of its own: this runs before the file's other hooks.
test.beforeAll(isolateFile);


test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    limitedModelId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${digit}1`,
    openModelId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${digit}2`,
    limitedChatId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${digit}3`,
    openChatId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${digit}4`,
    limitedTurnId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${digit}5`,
    openTurnId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${digit}6`,
    foldedChatId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${digit}7`,
    foldedTurnId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${digit}8`,
    foldedModelId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${digit}9`,
    foldedTitle: `Context meter compacted (${digit})`,
    limitedTitle: `Context meter limited (${digit})`,
    openTitle: `Context meter open (${digit})`,
  };
}
type Ids = ReturnType<typeof idsFor>;

function sealSecret(plaintext: string): string {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

async function seedChat(
  client: Client,
  input: {
    modelId: string;
    chatId: string;
    turnId: string;
    title: string;
    contextWindow: number | null;
    /** A compaction ran after the reply: the summary is newer than the measured usage. */
    compactedAfter?: boolean;
  }
): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [input.chatId]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [input.modelId]);
  await client.query(
    `INSERT INTO llm_model_configs (id, label, provider, model, settings, encrypted_secrets, enabled, is_default)\n     VALUES ($1, $2, 'anthropic', 'e2e-model', $3::jsonb, $4, true, false)`,
    [
      input.modelId,
      `E2E meter model ${input.modelId.slice(-2)}`,
      JSON.stringify(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
      sealSecret(JSON.stringify({ apiKey: 'e2e' })),
    ]
  );
  await client.query(
    `INSERT INTO chats (id, owner_subject, title, llm_model_id, last_message_at)\n     VALUES ($1, $2, $3, $4, NOW())`,
    [input.chatId, E2E_SUBJECT, input.title, input.modelId]
  );
  await client.query(
    `INSERT INTO chat_turns (id, chat_id, status, kind, llm_model_id, finished_at)\n     VALUES ($1, $2, 'completed', 'reply', $3, NOW())`,
    [input.turnId, input.chatId, input.modelId]
  );
  const chatKey = await keyFor(client, {
    kind: 'chat',
    resourceId: input.chatId,
    ownerSubject: E2E_SUBJECT,
  });
  const rows = [
    { seq: 1, role: 'user', kind: 'prompt', text: 'Hello there.', usage: null },
    {
      seq: 2,
      role: 'assistant',
      kind: 'assistant',
      text: 'Hi!',
      usage: { inputTokens: 40_000, outputTokens: 2_000, cacheReadInputTokens: 30_000 },
    },
  ];
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    await client.query(
      `INSERT INTO chat_messages (chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, usage)\n       VALUES ($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9, $10::jsonb)`,
      [
        input.chatId,
        input.turnId,
        row.seq,
        row.role,
        row.kind,
        chatKey.seal(JSON.stringify([{ type: 'text', text: row.text }])),
        assistant ? input.modelId : null,
        assistant ? 'anthropic' : null,
        assistant ? 'e2e-model' : null,
        row.usage ? JSON.stringify(row.usage) : null,
      ]
    );
  }
  if (input.compactedAfter) {
    // The prompt and tool definitions the chat's last turn measured.
    await client.query('UPDATE chats SET request_overhead_tokens = 30000 WHERE id = $1', [
      input.chatId,
    ]);
    await client.query(
      `INSERT INTO chat_summaries (chat_id, content, through_seq, folded_count, created_by, created_at)\n       VALUES ($1, $2, 2, 2, 'user', NOW() + interval '1 minute')`,
      [input.chatId, chatKey.seal('A short summary of the earlier conversation.')]
    );
  }
}

async function cleanup(client: Client, ids: Ids): Promise<void> {
  for (const chatId of [ids.limitedChatId, ids.openChatId, ids.foldedChatId]) {
    await client.query('DELETE FROM chats WHERE id = $1', [chatId]);
  }
  for (const modelId of [ids.limitedModelId, ids.openModelId, ids.foldedModelId]) {
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [modelId]);
  }
}

test.describe('chat context meter', () => {
  test('shows used / limit with a bar when the model has a window, and the count alone when not', async ({ page }, testInfo) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const ids = idsFor(testInfo.project.name);
    try {
      await seedChat(client, {
        modelId: ids.limitedModelId,
        chatId: ids.limitedChatId,
        turnId: ids.limitedTurnId,
        title: ids.limitedTitle,
        contextWindow: 200_000,
      });
      await seedChat(client, {
        modelId: ids.openModelId,
        chatId: ids.openChatId,
        turnId: ids.openTurnId,
        title: ids.openTitle,
        contextWindow: null,
      });

      await seedChat(client, {
        modelId: ids.foldedModelId,
        chatId: ids.foldedChatId,
        turnId: ids.foldedTurnId,
        title: ids.foldedTitle,
        contextWindow: 200_000,
        compactedAfter: true,
      });

      await page.goto(`/chat/${ids.limitedChatId}`);
      await expect(page.getByRole('heading', { level: 1, name: ids.limitedTitle })).toBeVisible();
      const meter = page.getByTestId('context-meter');
      await expect(meter).toHaveAttribute('aria-valuenow', '21');
      await expect(meter).toHaveAttribute('title', 'Context: 42k of 200k tokens (21%)');
      await shot(page, testInfo, 'chat-context-meter-limited');

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(meter).toBeVisible();
      await shot(page, testInfo, 'chat-context-meter-limited-mobile');

      // No recorded window: nothing to measure against, so nothing shown.
      await page.goto(`/chat/${ids.openChatId}`);
      await expect(page.getByRole('heading', { level: 1, name: ids.openTitle })).toBeVisible();
      await expect(page.getByTestId('context-meter')).toHaveCount(0);

      // A compaction newer than the last reply: its usage no longer describes
      // the history, so the ring falls to the estimate: the chat's prompt and tools plus the summary.
      await page.goto(`/chat/${ids.foldedChatId}`);
      await expect(page.getByRole('heading', { level: 1, name: ids.foldedTitle })).toBeVisible();
      const reset = page.getByTestId('context-meter');
      await expect(reset).toBeVisible();
      // 30k of prompt and tools plus a short summary: about 15% of 200k.
      const resetPercent = Number(await reset.getAttribute('aria-valuenow'));
      expect(resetPercent).toBeGreaterThanOrEqual(14);
      expect(resetPercent).toBeLessThanOrEqual(17);
      await shot(page, testInfo, 'chat-context-meter-after-compaction');
    } finally {
      await cleanup(client, ids);
      await client.end();
    }
  });
});
