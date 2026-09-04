/**
 * The chat thread rendered from stored rows: a completed turn with a user
 * prompt, a reply carrying thinking, a tool call and Markdown, and the
 * tool's result — seeded straight into the tables, sealed the way the app
 * seals them, so no model or MCP round-trip is needed. Asserts the sidebar
 * lists the chat, the thread shows every block kind, the folds hold the
 * tool input and result, and nothing spills horizontally (the mobile
 * project is where a wide code block or table would).
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

const CHAT_ID = '77777777-7777-4777-8777-777777777771';
const TURN_ID = '77777777-7777-4777-8777-777777777772';
const MODEL_ID = '77777777-7777-4777-8777-777777777773';
const CHAT_TITLE = 'Which sprint issues slipped?';
const TOOL_USE_ID = 'toolu_e2e_0001';

/**
 * `@renkei/crypto`'s content envelope, reproduced here because the spec
 * runs under Playwright's own TypeScript loader with no workspace-package
 * transpilation: `renc1:` + `v1.<iv>.<tag>.<ciphertext>` (aes-256-gcm,
 * base64 parts) under TOKEN_ENCRYPTION_KEY, which is what the app falls
 * back to when CONTENT_ENCRYPTION_KEY is unset.
 */
function secretbox(plaintext: string, encoded: string, name: string): string {
  const key = Buffer.from(encoded, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`${name} must decode to 32 bytes for the chat spec to seed rows.`);
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

/** `llm_model_configs.encrypted_secrets` is a bare secretbox under TOKEN_ENCRYPTION_KEY. */
function sealSecret(plaintext: string): string {
  return secretbox(plaintext, process.env.TOKEN_ENCRYPTION_KEY ?? '', 'TOKEN_ENCRYPTION_KEY');
}

const REPLY_MARKDOWN = [
  'Two issues slipped out of the sprint:',
  '',
  '| Key | Summary | Status |',
  '| --- | --- | --- |',
  '| OPS-41 | Rotate the Zoom webhook secret | In Progress |',
  '| OPS-44 | Backfill the fileshare index | To Do |',
  '',
  'Both are still assigned. The search I ran was:',
  '',
  '```sql',
  'project = OPS AND sprint in closedSprints() AND status != Done ORDER BY updated DESC',
  '```',
  '',
  'Want me to **move them** into the next sprint?',
].join('\n');

async function seedChat(client: Client): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [CHAT_ID]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [MODEL_ID]);
  await client.query(
    `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, enabled, is_default)
     VALUES ($1, $2, 'E2E model', 'anthropic', 'e2e-model', $3, true, true)`,
    [MODEL_ID, E2E_TENANT_ID, sealSecret(JSON.stringify({ apiKey: 'e2e' }))]
  );
  await client.query(
    `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, thinking_enabled, last_message_at)
     VALUES ($1, $2, $3, $4, $5, true, NOW())`,
    [CHAT_ID, E2E_TENANT_ID, E2E_SUBJECT, CHAT_TITLE, MODEL_ID]
  );
  await client.query(
    `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, input_tokens, output_tokens, finished_at)
     VALUES ($1, $2, $3, 'completed', $4, 2, 1200, 340, NOW())`,
    [TURN_ID, E2E_TENANT_ID, CHAT_ID, MODEL_ID]
  );
  const rows: { seq: number; role: string; kind: string; blocks: unknown[] }[] = [
    {
      seq: 1,
      role: 'user',
      kind: 'prompt',
      blocks: [{ type: 'text', text: 'Which issues slipped out of the last OPS sprint?' }],
    },
    {
      seq: 2,
      role: 'assistant',
      kind: 'assistant',
      blocks: [
        {
          type: 'thinking',
          thinking: 'The closed sprint is the one to search; anything not Done in it slipped.',
          signature: 'e2e-signature',
        },
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'jira_search_issues',
          input: { jql: 'project = OPS AND sprint in closedSprints() AND status != Done' },
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
          toolUseId: TOOL_USE_ID,
          content: JSON.stringify(
            { issues: [{ key: 'OPS-41', status: 'In Progress' }, { key: 'OPS-44', status: 'To Do' }] },
            null,
            2
          ),
        },
      ],
    },
    {
      seq: 4,
      role: 'assistant',
      kind: 'assistant',
      blocks: [{ type: 'text', text: REPLY_MARKDOWN }],
    },
  ];
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    await client.query(
      `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, stop_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10, $11)`,
      [
        E2E_TENANT_ID,
        CHAT_ID,
        TURN_ID,
        row.seq,
        row.role,
        row.kind,
        seal(JSON.stringify(row.blocks)),
        assistant ? MODEL_ID : null,
        assistant ? 'anthropic' : null,
        assistant ? 'e2e-model' : null,
        assistant ? (row.seq === 2 ? 'tool_use' : 'end_turn') : null,
      ]
    );
  }
}

test('chat thread: sidebar, blocks, folds, no overflow', async ({ page }, testInfo) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedChat(client);

    await page.goto(`/${E2E_SLUG}/chat/${CHAT_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: CHAT_TITLE })).toBeVisible();

    // The app menu's Chat section lists the chat: in the column beside the
    // page on a desktop, behind the hamburger on a phone.
    const mobile = testInfo.project.name === 'mobile';
    if (mobile) await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(
      page.getByRole('navigation', { name: 'Chats' }).getByRole('link', { name: CHAT_TITLE })
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Prompt libraries' })).toBeVisible();
    if (mobile) await page.keyboard.press('Escape');

    // The prompt, the thought, the tool call and the Markdown reply.
    await expect(page.getByText('Which issues slipped out of the last OPS sprint?')).toBeVisible();
    const thought = page.locator('details.chat-fold', { hasText: 'Thought process' });
    await expect(thought).toBeVisible();
    await thought.locator('summary').click();
    await expect(thought.getByText(/closed sprint is the one to search/)).toBeVisible();

    const call = page.locator('details.chat-fold', { hasText: 'Called' });
    await expect(call).toBeVisible();
    await call.locator('summary').click();
    await expect(call.getByText('Input')).toBeVisible();
    await expect(call.getByText('Result')).toBeVisible();
    await expect(call.getByText(/OPS-44/)).toBeVisible();

    const markdown = page.locator('.chat-markdown').last();
    await expect(markdown.getByRole('table')).toBeVisible();
    await expect(markdown.locator('pre code')).toContainText('closedSprints()');
    await expect(markdown.locator('strong', { hasText: 'move them' })).toBeVisible();

    // The owner gets a composer; nothing spills horizontally.
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    );
    expect(fits).toBe(true);

    await page.screenshot({
      path: path.join(
        import.meta.dirname,
        '..',
        'test-results',
        'screens',
        testInfo.project.name,
        'chat-thread.png'
      ),
      fullPage: true,
    });
  } finally {
    await client.query('DELETE FROM chats WHERE id = $1', [CHAT_ID]);
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [MODEL_ID]);
    await client.end();
  }
});
