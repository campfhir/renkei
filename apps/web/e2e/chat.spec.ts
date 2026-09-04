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

/**
 * Fixture ids differ per Playwright project: the projects run in parallel
 * against one database, and a project cleaning up must not pull the chat
 * out from under another one mid-test.
 */
function idsFor(project: string): {
  chatId: string;
  projectId: string;
  archivedId: string;
  turnId: string;
  modelId: string;
  title: string;
  modelLabel: string;
} {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `77777777-7777-4777-8777-7777777777${digit}1`,
    projectId: `77777777-7777-4777-8777-7777777777${digit}4`,
    archivedId: `77777777-7777-4777-8777-7777777777${digit}5`,
    turnId: `77777777-7777-4777-8777-7777777777${digit}2`,
    modelId: `77777777-7777-4777-8777-7777777777${digit}3`,
    // The menu lists every project's chat; a shared title would match twice.
    title: `${CHAT_TITLE} (${digit})`,
    modelLabel: `E2E model ${digit}3`,
  };
}
type Ids = ReturnType<typeof idsFor>;
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

async function seedChat(
  client: Client,
  {
    chatId: CHAT_ID,
    projectId,
    archivedId,
    turnId: TURN_ID,
    modelId: MODEL_ID,
    title,
    modelLabel,
  }: Ids
): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [CHAT_ID]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [MODEL_ID]);
  await client.query(
    `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, enabled, is_default)
     VALUES ($1, $2, $4, 'anthropic', 'e2e-model', $3, true, false)`,
    // Labels and the default flag are unique per tenant, and the projects
    // seed side by side; the chat pins its model, so none need be default.
    [MODEL_ID, E2E_TENANT_ID, sealSecret(JSON.stringify({ apiKey: 'e2e' })), modelLabel]
  );
  await client.query('DELETE FROM chat_projects WHERE id = $1', [projectId]);
  await client.query(
    `INSERT INTO chat_projects (id, tenant_id, owner_subject, name)
     VALUES ($1, $2, $3, 'Sprint hygiene')`,
    [projectId, E2E_TENANT_ID, E2E_SUBJECT]
  );
  await client.query(
    `INSERT INTO chats (id, tenant_id, owner_subject, project_id, title, llm_model_id, thinking_enabled, last_message_at)
     VALUES ($1, $2, $3, $6, $4, $5, true, NOW())`,
    [CHAT_ID, E2E_TENANT_ID, E2E_SUBJECT, title, MODEL_ID, projectId]
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
            {
              issues: [
                { key: 'OPS-41', status: 'In Progress' },
                { key: 'OPS-44', status: 'To Do' },
              ],
            },
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
  // An archived chat of the same person: hidden until "Show archived".
  await client.query('DELETE FROM chats WHERE id = $1', [archivedId]);
  await client.query(
    `INSERT INTO chats (id, tenant_id, owner_subject, title, archived_at, last_message_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    [archivedId, E2E_TENANT_ID, E2E_SUBJECT, `${title} (archived)`]
  );
  // A file a tool produced, as the runner keeps it: metadata under origin
  // 'model' (the bytes would sit in the blob store, which the list never
  // reads).
  await client.query(
    `INSERT INTO chat_attachments (tenant_id, owner_subject, chat_id, blob_key, filename, content_type, size_bytes, extract_status, origin)
     VALUES ($1, $2, $3, $4, 'sprint-report.pdf', 'application/pdf', 48213, 'done', 'model')`,
    [E2E_TENANT_ID, E2E_SUBJECT, CHAT_ID, `chat/${E2E_TENANT_ID}/${TURN_ID}`]
  );
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

function shot(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  name: string
): Promise<Buffer> {
  return page.screenshot({
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

test('chat thread: sidebar, blocks, folds, no overflow', async ({ page }, testInfo) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name);
  const CHAT_ID = ids.chatId;
  const title = ids.title;
  try {
    await seedChat(client, ids);

    await page.goto(`/${E2E_SLUG}/chat/${CHAT_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    // The project the chat sits in reads as a subheading under the name.
    await expect(
      page.locator('header').getByRole('link', { name: 'Sprint hygiene' })
    ).toBeVisible();

    // The app menu's Chat section lists the chat: in the column beside the
    // page on a desktop, behind the hamburger on a phone.
    const mobile = testInfo.project.name === 'mobile';
    if (mobile) await page.getByRole('button', { name: 'Open menu' }).click();
    // The row's name runs on into its project line, and the archived twin's
    // into "(archived)": anchor the title and rule the twin out.
    const rowName = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?! \\(archived)`);
    const row = page
      .getByRole('navigation', { name: 'Chats' })
      .getByRole('link', { name: rowName });
    await expect(row).toBeVisible();
    // The row names the chat's project underneath.
    await expect(row.getByText('Sprint hygiene')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Prompt libraries' })).toBeVisible();
    const archivedRow = page
      .getByRole('navigation', { name: 'Chats' })
      .getByRole('link', { name: `${title} (archived)` });
    await expect(archivedRow).toBeHidden();
    await page.getByRole('checkbox', { name: /Show archived/ }).check();
    await expect(archivedRow).toBeVisible();
    await page.getByRole('checkbox', { name: /Show archived/ }).uncheck();
    if (mobile) await page.keyboard.press('Escape');

    // The prompt, then the reply's work — thinking and the tool call in one
    // collapsed line — and the Markdown answer.
    await expect(page.getByText('Which issues slipped out of the last OPS sprint?')).toBeVisible();
    const work = page.locator('details.chat-fold', { hasText: 'Thought · 1 tool call' });
    await expect(work).toBeVisible();
    await expect(work.getByText(/closed sprint is the one to search/)).toBeHidden();
    await work.locator('> summary').click();
    await expect(work.getByText(/closed sprint is the one to search/)).toBeVisible();

    const call = work.locator('details.chat-fold', { hasText: 'Called' });
    await expect(call).toBeVisible();
    await call.locator('> summary').click();
    await expect(call.getByText('Input')).toBeVisible();
    await expect(call.getByText('Result')).toBeVisible();
    await expect(call.getByText(/OPS-44/)).toBeVisible();
    await shot(page, testInfo, 'chat-work-open.png');
    await work.locator('> summary').click();

    const markdown = page.locator('.chat-markdown').last();
    await expect(markdown.getByRole('table')).toBeVisible();
    await expect(markdown.locator('pre code')).toContainText('closedSprints()');
    await expect(markdown.locator('strong', { hasText: 'move them' })).toBeVisible();

    // The owner renames the chat in place; the menu follows.
    await page.getByRole('button', { name: 'Rename chat' }).click();
    const nameField = page.getByRole('textbox', { name: 'Chat name' });
    await nameField.fill(`${title} — renamed`);
    await nameField.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: `${title} — renamed` })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Chats' })
        .getByRole('link', { name: `${title} — renamed` })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Rename chat' }).click();
    await page.getByRole('textbox', { name: 'Chat name' }).fill(title);
    await page.getByRole('textbox', { name: 'Chat name' }).press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    // Files the assistant produced sit behind Artifacts, each a download.
    await page.getByRole('button', { name: /Artifacts/ }).click();
    const artifact = page.getByRole('menuitem', { name: /sprint-report\.pdf/ });
    await expect(artifact).toBeVisible();
    await shot(page, testInfo, 'chat-artifacts.png');
    // Picking one opens the modal: save it here, or copy it to a share.
    await artifact.click();
    const download = page.getByRole('link', { name: 'Download' });
    await expect(download).toHaveAttribute('href', /\/chat\/attachments\/[0-9a-f-]{36}$/);
    await expect(page.getByText('A network share')).toBeVisible();
    await shot(page, testInfo, 'chat-artifact-modal.png');
    await page.keyboard.press('Escape');
    await expect(download).toBeHidden();

    // The owner gets a composer with the model menu, thinking switch inside.
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await page.getByRole('button', { name: 'Model' }).click();
    await expect(
      page.getByRole('menuitemradio', { name: new RegExp(`^${ids.modelLabel}`) })
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menuitemcheckbox', { name: /Extended thinking/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await shot(page, testInfo, 'chat-model-menu.png');
    await page.keyboard.press('Escape');

    // The owner can rewrite a prompt: Edit fills the box with its text and
    // says what sending will do; Cancel empties it again. Resend asks first.
    const bubble = page.getByText('Which issues slipped out of the last OPS sprint?');
    await bubble.hover();
    await page.getByRole('button', { name: 'Edit' }).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await expect(box).toHaveValue('Which issues slipped out of the last OPS sprint?');
    await expect(page.getByText(/Editing an earlier message/)).toBeVisible();
    await shot(page, testInfo, 'chat-edit.png');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(box).toHaveValue('');
    await bubble.hover();
    await page.getByRole('button', { name: 'Resend' }).click();
    await expect(page.getByRole('heading', { name: 'Resend this message?' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Nothing spills horizontally.
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    );
    expect(fits).toBe(true);

    await shot(page, testInfo, 'chat-thread.png');

    // "Chat" lands on the most recent chat; "+ New" on an empty one.
    // (Some chat — another project's fixture may be newer than this one's.)
    await page.goto(`/${E2E_SLUG}/chat`);
    await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}/chat/[0-9a-f-]{36}$`));
    await page.goto(`/${E2E_SLUG}/chat/new`);
    await expect(page.getByRole('heading', { level: 1, name: 'New chat' })).toBeVisible();
  } finally {
    await client.query('DELETE FROM chats WHERE id = $1', [CHAT_ID]);
    await client.query('DELETE FROM chats WHERE id = $1', [ids.archivedId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
    await client.end();
  }
});
