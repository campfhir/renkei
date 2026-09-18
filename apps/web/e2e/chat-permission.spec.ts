/**
 * A chat parked behind a tool call: the turn row carries the ask
 * (`chat_turns.tool_permission`, migration 109) and the thread shows it
 * inline — the card with Allow once / Always allow / Deny, the fold's
 * "Waiting for permission" line — from the rows alone, no model or MCP
 * round-trip. Answering writes the decision onto the row (the runner would
 * read it back; none runs here) and puts "always" on the person's list,
 * which the Preferences page then shows with a way to take it back. The
 * notification the ask raised is a row like any other, opened from the
 * feed in the same tab.
 *
 * Seeds straight into the tables, sealed the way the app seals them, the
 * same way chat.spec.ts does.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
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

/** Ids per Playwright project: the projects share one database. */
function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `88888888-8888-4888-8888-8888888888${digit}1`,
    turnId: `88888888-8888-4888-8888-8888888888${digit}2`,
    modelId: `88888888-8888-4888-8888-8888888888${digit}3`,
    notificationId: `88888888-8888-4888-8888-8888888888${digit}4`,
    toolUseId: `toolu_perm_${digit}`,
    title: `File the slipped issues (${digit})`,
    modelLabel: `Permission model ${digit}`,
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

const TOOL_INPUT = {
  project: 'OPS',
  summary: 'Rotate the Zoom webhook secret',
  issueType: 'Task',
  description: 'Slipped out of sprint 42; carried over with the same owner.',
};

/** A chat whose running turn is parked behind jira_create_issue. */
async function seedParkedChat(client: Client, ids: Ids): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
  await client.query('DELETE FROM agent_notifications WHERE id = $1', [ids.notificationId]);
  await client.query(
    `DELETE FROM user_preferences WHERE tenant_id = $1 AND subject = $2 AND key = 'chatToolPermissions'`,
    [E2E_TENANT_ID, E2E_SUBJECT]
  );
  await client.query(
    `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, enabled, is_default)
     VALUES ($1, $2, $3, 'anthropic', 'e2e-model', $4, true, false)`,
    [ids.modelId, E2E_TENANT_ID, ids.modelLabel, sealSecret(JSON.stringify({ apiKey: 'e2e' }))]
  );
  await client.query(
    `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [ids.chatId, E2E_TENANT_ID, E2E_SUBJECT, ids.title, ids.modelId]
  );
  const ask = {
    toolUseId: ids.toolUseId,
    messageId: 'pending',
    name: 'jira_create_issue',
    requestedAt: new Date().toISOString(),
    decision: null,
    decidedAt: null,
  };
  await client.query(
    `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, stage, stage_at, tool_permission)
     VALUES ($1, $2, $3, 'running', $4, 2, 'permission:jira_create_issue', NOW(), $5::jsonb)`,
    [ids.turnId, E2E_TENANT_ID, ids.chatId, ids.modelId, JSON.stringify(ask)]
  );
  const rows: { seq: number; role: string; kind: string; status: string; blocks: unknown[] }[] = [
    {
      seq: 1,
      role: 'user',
      kind: 'prompt',
      status: 'complete',
      blocks: [{ type: 'text', text: 'File OPS-41 again as a fresh task in the OPS project.' }],
    },
    {
      seq: 2,
      role: 'assistant',
      kind: 'assistant',
      status: 'complete',
      blocks: [
        { type: 'text', text: 'On it — one task in OPS with the same owner.' },
        { type: 'tool_use', id: ids.toolUseId, name: 'jira_create_issue', input: TOOL_INPUT },
      ],
    },
  ];
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    const inserted = await client.query(
      `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, stop_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        E2E_TENANT_ID,
        ids.chatId,
        ids.turnId,
        row.seq,
        row.role,
        row.kind,
        row.status,
        seal(JSON.stringify(row.blocks)),
        assistant ? ids.modelId : null,
        assistant ? 'anthropic' : null,
        assistant ? 'e2e-model' : null,
        assistant ? 'tool_use' : null,
      ]
    );
    if (assistant) {
      // The ask names the row the tool_use block sits in.
      await client.query(
        `UPDATE chat_turns SET tool_permission = tool_permission || $2::jsonb WHERE id = $1`,
        [ids.turnId, JSON.stringify({ messageId: inserted.rows[0].id })]
      );
    }
  }
  // The notification the ask raised (lib/chat/permission-notification.ts).
  await client.query(
    `INSERT INTO agent_notifications (id, tenant_id, subject, kind, tool, headline, ref_id, ref_url)
     VALUES ($1, $2, $3, 'chat_permission', 'jira_create_issue', $4, $5, $6)`,
    [
      ids.notificationId,
      E2E_TENANT_ID,
      E2E_SUBJECT,
      `“${ids.title}” is waiting for your permission to create issue`,
      ids.toolUseId,
      `/${E2E_SLUG}/chat/${ids.chatId}`,
    ]
  );
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

async function permissionRow(client: Client, turnId: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query('SELECT tool_permission FROM chat_turns WHERE id = $1', [
    turnId,
  ]);
  return rows[0]?.tool_permission ?? {};
}

test('a parked turn shows the ask inline, and Always allow records the tool', async ({
  page,
}, testInfo) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name);
  try {
    await seedParkedChat(client, ids);

    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

    // The fold says what the turn is waiting on, and the card carries the
    // three answers plus what the call would send.
    await expect(page.getByText('Waiting for permission to call').first()).toBeVisible();
    const card = page.getByRole('group', { name: 'Permission needed' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Allow this?')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Allow once' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Always allow' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible();
    await card.getByText('What it will send').click();
    await expect(card.getByText('Rotate the Zoom webhook secret')).toBeVisible();
    // Stop is still there: a parked turn can be cancelled.
    await expect(page.getByRole('button', { name: /stop/i })).toBeVisible();
    await shot(page, testInfo, 'chat-permission-ask.png');

    // Always allow: the row gets the answer, the person's list gets the tool.
    await card.getByRole('button', { name: 'Always allow' }).click();
    await expect
      .poll(async () => (await permissionRow(client, ids.turnId)).decision, { timeout: 10_000 })
      .toBe('always');
    await expect
      .poll(
        async () => {
          const { rows } = await client.query(
            `SELECT value FROM user_preferences WHERE tenant_id = $1 AND subject = $2 AND key = 'chatToolPermissions'`,
            [E2E_TENANT_ID, E2E_SUBJECT]
          );
          return rows[0]?.value ?? null;
        },
        { timeout: 10_000 }
      )
      .toEqual({ alwaysAllow: ['jira_create_issue'] });
    // ...and the notification the ask raised is read.
    await expect
      .poll(async () => {
        const { rows } = await client.query(
          'SELECT read_at FROM agent_notifications WHERE id = $1',
          [ids.notificationId]
        );
        return rows[0]?.read_at !== null;
      })
      .toBe(true);

    // A second answer is refused: the turn is no longer waiting on it.
    const again = await page.request.post(
      `/api/tenant/${E2E_TENANT_ID}/chat/chats/${ids.chatId}/turns/${ids.turnId}/permission`,
      { data: { toolUseId: ids.toolUseId, decision: 'deny' } }
    );
    expect(again.status()).toBe(409);
    expect((await permissionRow(client, ids.turnId)).decision).toBe('always');

    // Preferences lists the tool with a way to ask again, and the
    // system-notification click preference sits with the other switches.
    await page.goto(`/${E2E_SLUG}/preferences`);
    const section = page.getByRole('region', { name: 'Tools chats may use without asking' });
    await expect(section.getByText('jira_create_issue')).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: /Open the notification.s own application/ })
    ).toBeChecked();
    await section.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'preferences-tool-permissions.png');
    await section.getByRole('button', { name: /Ask again before/ }).click();
    await expect(section.getByText('Nothing yet')).toBeVisible();
    await expect
      .poll(async () => {
        const { rows } = await client.query(
          `SELECT value FROM user_preferences WHERE tenant_id = $1 AND subject = $2 AND key = 'chatToolPermissions'`,
          [E2E_TENANT_ID, E2E_SUBJECT]
        );
        return rows[0]?.value ?? null;
      })
      .toEqual({ alwaysAllow: [] });
  } finally {
    await client.end();
  }
});

test('the permission notification opens the chat in the same tab', async ({ page }, testInfo) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name);
  try {
    await seedParkedChat(client, ids);
    await page.goto(`/${E2E_SLUG}/notifications`);
    const link = page.getByRole('link', { name: `“${ids.title}” is waiting for your permission` });
    await expect(link.first()).toBeVisible();
    await expect(link.first()).toHaveAttribute('href', `/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(link.first()).not.toHaveAttribute('target', '_blank');
    await shot(page, testInfo, 'notifications-chat-permission.png');

    // The banner's click path: the open route marks the row read and lands
    // in the chat (an in-app link, whatever the source-app preference says).
    const opened = await page.request.get(
      `/api/tenant/${E2E_TENANT_ID}/notifications/${ids.notificationId}/open`,
      { maxRedirects: 0 }
    );
    expect(opened.status()).toBe(302);
    expect(opened.headers()['location']).toContain(`/${E2E_SLUG}/chat/${ids.chatId}`);
    const { rows } = await client.query('SELECT read_at FROM agent_notifications WHERE id = $1', [
      ids.notificationId,
    ]);
    expect(rows[0].read_at).not.toBeNull();
  } finally {
    await client.end();
  }
});
