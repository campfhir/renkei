/**
 * chat_rename's place in the thread: a rename the person asked for is an
 * ordinary tool call — its own fold, its result, and the new title in the
 * heading and the sidebar. Seeded straight into the tables (chat.spec.ts's
 * approach), so no model is called. The automatic first-prompt title runs
 * server-side and writes no rows, so nothing here can show it; it is
 * covered by the unit tests in lib/chat/titles.test.ts.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { test, expect } from './worker-env';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
import { keyFor } from './keys';


test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** Fixture ids differ per Playwright project, which run in parallel against one database. */
function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `88888888-8888-4888-8888-8888888888${digit}1`,
    turnId: `88888888-8888-4888-8888-8888888888${digit}2`,
    modelId: `88888888-8888-4888-8888-8888888888${digit}3`,
    title: `Quarterly budget review (${digit})`,
    modelLabel: `E2E title model ${digit}`,
  };
}

const TOOL_USE_ID = 'toolu_e2e_title_0001';

/** The same secretbox the app seals with (chat.spec.ts reproduces it for the same reason). */
function sealSecret(plaintext: string): string {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
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

async function seedChat(client: Client, ids: ReturnType<typeof idsFor>): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
  await client.query(
    `INSERT INTO llm_model_configs (id, label, provider, model, encrypted_secrets, enabled, is_default)
     VALUES ($1, $3, 'anthropic', 'e2e-model', $2, true, false)`,
    [ids.modelId, sealSecret(JSON.stringify({ apiKey: 'e2e' })), ids.modelLabel]
  );
  // The title the rename left behind: the tool wrote it, so the chat row carries it.
  await client.query(
    `INSERT INTO chats (id, owner_subject, title, llm_model_id, thinking_enabled, last_message_at, auto_title_asked)
     VALUES ($1, $2, $3, $4, true, NOW(), true)`,
    [ids.chatId, E2E_SUBJECT, ids.title, ids.modelId]
  );
  const chatKey = await keyFor(client, {
    kind: 'chat',
    resourceId: ids.chatId,
    ownerSubject: E2E_SUBJECT,
  });
  await client.query(
    `INSERT INTO chat_turns (id, chat_id, status, llm_model_id, iterations, input_tokens, output_tokens, finished_at)
     VALUES ($1, $2, 'completed', $3, 2, 300, 40, NOW())`,
    [ids.turnId, ids.chatId, ids.modelId]
  );
  const rows: { seq: number; role: string; kind: string; blocks: unknown[] }[] = [
    {
      seq: 0,
      role: 'user',
      kind: 'prompt',
      blocks: [{ type: 'text', text: 'Call this chat something about the budget review.' }],
    },
    {
      seq: 1,
      role: 'assistant',
      kind: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'chat_rename',
          input: { title: ids.title },
        },
      ],
    },
    {
      seq: 2,
      role: 'user',
      kind: 'tool_results',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: TOOL_USE_ID,
          content: `Renamed the chat to "${ids.title}".`,
          durationMs: 12,
        },
      ],
    },
    {
      seq: 3,
      role: 'assistant',
      kind: 'assistant',
      blocks: [{ type: 'text', text: `Done — this chat is now called ${ids.title}.` }],
    },
  ];
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    await client.query(
      `INSERT INTO chat_messages (chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, stop_reason, timing)
       VALUES ($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9, $10, $11)`,
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
        assistant ? (row.seq === 1 ? 'tool_use' : 'end_turn') : null,
        assistant && row.seq === 1 ? JSON.stringify({ durationMs: 900, firstTokenMs: 300 }) : null,
      ]
    );
  }
}

test('chat rename: the tool call shows as an ordinary call, the new title sticks', async ({
  page,
}, testInfo) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name);
  try {
    await seedChat(client, ids);

    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();
    await expect(page.getByText('Call this chat something about the budget review.')).toBeVisible();

    // The rename is a tool call in the thread like any other: a fold naming
    // it, inside the reply's work fold (as chat.spec.ts's tool call is).
    const work = page.locator('details.chat-fold', { hasText: /rename/i }).first();
    await expect(work).toBeVisible();
    await work.locator('> summary').click();
    const call = work.locator('details.chat-fold', { hasText: /rename/i }).first();
    await expect(call).toBeVisible();
    await call.locator('> summary').click();
    await expect(call.getByText(`Renamed the chat to "${ids.title}".`)).toBeVisible();
    await expect(page.getByText('Done — this chat is now called')).toBeVisible();
  } finally {
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
    await client.end();
  }
});
