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
  'To carry them over, the board script would be:',
  '',
  '```ts',
  "const carried = issues.filter((issue) => issue.status !== 'Done');",
  '```',
  '',
  '```yml',
  'sprint:',
  '  name: OPS Sprint 12',
  '  carry_over: true',
  '```',
  '',
  'Want me to **move them** into the next sprint?',
].join('\n');

/**
 * The person's own prompt, seeded with a fence and a backtick of its
 * own: the same Markdown renderer as the reply's, so this should read as
 * a code-block card and inline monospace rather than literal backticks.
 */
const FENCE_PROMPT = [
  'One more thing — does `status != Done` cover every closed state, or should it run as:',
  '',
  '```jql',
  'project = OPS AND sprint in closedSprints() AND status not in (Done, Cancelled)',
  '```',
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
      seq: 0,
      role: 'user',
      kind: 'prompt',
      blocks: [{ type: 'text', text: FENCE_PROMPT }],
    },
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
          // How long the call ran, as the runner stamps it on the block.
          durationMs: 800,
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
      `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, stop_reason, timing)
       VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10, $11, $12)`,
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
        // The model call behind the row that thought and called the tool:
        // 2.1s in all, 0.9s before its first block streamed.
        assistant && row.seq === 2 ? JSON.stringify({ durationMs: 2100, firstTokenMs: 900 }) : null,
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
    // The row names the chat's project underneath, and leads with the mark
    // of a chat in a chat project (a code project's chats get another).
    await expect(row.getByText('Sprint hygiene')).toBeVisible();
    await expect(row.locator('[data-kind="project"]')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Prompt libraries' })).toBeVisible();

    // The row's "⋯" menu opens dialogs from inside the menu — the sticky
    // column on a desktop, the fixed drawer on a phone. Each dialog must
    // still cover the whole viewport and take input: rendered in place it
    // sat under the page's own content on a desktop and was clipped to the
    // drawer on a phone.
    const openRowDialog = async (action: string, name: string) => {
      await row.hover();
      await row.locator('..').getByRole('button', { name: 'Chat actions' }).click();
      await page.getByRole('button', { name: action, exact: true }).click();
      const dialog = page.getByRole('dialog', { name });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    const coversViewport = async (dialog: ReturnType<typeof page.getByRole>) => {
      const viewport = page.viewportSize();
      const overlay = await dialog.boundingBox();
      expect(overlay?.x).toBe(0);
      expect(overlay?.y).toBe(0);
      expect(overlay?.width).toBe(viewport?.width);
      expect(overlay?.height).toBe(viewport?.height);
    };

    const renameDialog = await openRowDialog('Rename', 'Rename chat');
    await shot(page, testInfo, 'chat-rename-dialog.png');
    await coversViewport(renameDialog);
    const draft = renameDialog.getByRole('textbox');
    await expect(draft).toHaveValue(title);
    // fill() hit-tests the field: it fails if anything paints over it.
    await draft.fill(`${title} — draft`);
    await expect(draft).toHaveValue(`${title} — draft`);
    await renameDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(renameDialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    const deleteDialog = await openRowDialog('Delete', 'Delete chat');
    await shot(page, testInfo, 'chat-delete-dialog.png');
    await coversViewport(deleteDialog);
    await expect(deleteDialog.getByText(/deletes the chat/)).toBeVisible();
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(deleteDialog).toBeHidden();
    await expect(row).toBeVisible();
    const archivedRow = page
      .getByRole('navigation', { name: 'Chats' })
      .getByRole('link', { name: `${title} (archived)` });
    await expect(archivedRow).toBeHidden();
    // The search box finds a chat by what was said in it, not only by its
    // title: the phrase below sits in the reply's table and nowhere in the
    // title, and the row found that way shows the matching line.
    const search = page.getByRole('searchbox', { name: 'Find a chat' });
    await search.fill('rotate the zoom webhook');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('chat-search-snippet')).toContainText(
      'Rotate the Zoom webhook secret'
    );
    await search.fill('a phrase no chat has ever held');
    await expect(row).toBeHidden();
    await expect(
      page.getByRole('navigation', { name: 'Chats' }).getByText('No chats match.')
    ).toBeVisible();
    await search.fill('');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('chat-search-snippet')).toHaveCount(0);
    // The funnel in the search box picks the states shown: active, archived, or both.
    await page.getByRole('button', { name: 'Filter chats' }).click();
    const archivedOption = page.getByRole('menuitemcheckbox', { name: /Archived/ });
    await expect(archivedOption).toHaveAttribute('aria-checked', 'false');
    await archivedOption.click();
    await expect(archivedRow).toBeVisible();
    await expect(row).toBeVisible();
    if (!mobile) await shot(page, testInfo, 'chat-filter.png');
    await archivedOption.click();
    await expect(archivedRow).toBeHidden();
    await page.keyboard.press('Escape');
    if (mobile) await page.keyboard.press('Escape');

    // The prompt, then the reply's work — thinking and the tool call in one
    // collapsed line — and the Markdown answer.
    await expect(page.getByText('Which issues slipped out of the last OPS sprint?')).toBeVisible();
    const work = page.locator('details.chat-fold', { hasText: 'Thought · 1 tool call' });
    await expect(work).toBeVisible();
    // Where the time went, from the rows' own timing: the model call
    // apart from the tool it waited on.
    await expect(work.locator('> summary')).toContainText('2s model, 0.8s tools');
    await expect(work.getByText(/closed sprint is the one to search/)).toBeHidden();
    await work.locator('> summary').click();
    await expect(work.getByText(/closed sprint is the one to search/)).toBeVisible();

    const call = work.locator('details.chat-fold', { hasText: 'Called' });
    await expect(call).toBeVisible();
    await expect(call.locator('[data-call-duration]')).toHaveText('0.8s');
    await call.locator('> summary').click();
    await expect(call.getByText('Input')).toBeVisible();
    await expect(call.getByText('Result')).toBeVisible();
    await expect(call.getByText(/OPS-44/)).toBeVisible();
    // The call's JSON input, and a result that is JSON, are coloured as JSON.
    await expect(call.locator('.chat-pre .hljs-attr', { hasText: 'issues' })).toBeVisible();
    await expect(call.locator('.chat-pre .hljs-string', { hasText: 'OPS-44' })).toBeVisible();
    await shot(page, testInfo, 'chat-work-open.png');
    await work.locator('> summary').click();

    const markdown = page.locator('.chat-markdown').last();
    await expect(markdown.getByRole('table')).toBeVisible();
    await expect(markdown.locator('pre code').first()).toContainText('closedSprints()');
    await expect(markdown.locator('strong', { hasText: 'move them' })).toBeVisible();

    // Each fenced block is a card: the language named in its header, the
    // code coloured by that language's grammar — the fence's own word
    // (`yml`) resolved to the grammar and to a proper name (YAML) — and a
    // Copy button that is always there, not only under a pointer.
    const sqlBlock = markdown.locator('.chat-code', { hasText: 'closedSprints()' });
    await expect(sqlBlock.locator('.chat-code-lang')).toHaveText('SQL');
    await expect(sqlBlock.locator('.hljs-keyword', { hasText: 'ORDER' })).toBeVisible();
    const tsBlock = markdown.locator('.chat-code', { hasText: 'issues.filter' });
    await expect(tsBlock.locator('.chat-code-lang')).toHaveText('TypeScript');
    await expect(tsBlock.locator('.hljs-keyword', { hasText: 'const' })).toBeVisible();
    await expect(tsBlock.locator('.hljs-string', { hasText: "'Done'" })).toBeVisible();
    const yamlBlock = markdown.locator('.chat-code', { hasText: 'carry_over' });
    await expect(yamlBlock.locator('.chat-code-lang')).toHaveText('YAML');
    await expect(yamlBlock.locator('.hljs-attr', { hasText: 'sprint' }).first()).toBeVisible();
    await expect(yamlBlock.locator('.hljs-literal', { hasText: 'true' })).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const copy = tsBlock.getByRole('button', { name: 'Copy' });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(tsBlock.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "const carried = issues.filter((issue) => issue.status !== 'Done');\n"
    );
    await shot(page, testInfo, 'chat-code-blocks.png');

    // The person's own prompt goes through the identical renderer: their
    // fence is the same code-block card (on the blue bubble's own
    // colours) and their backtick is monospace, not a literal character.
    const userFence = page.locator('.chat-markdown-user').filter({ hasText: 'closedSprints()' });
    await expect(userFence.locator('code', { hasText: 'status != Done' })).toBeVisible();
    const userCode = userFence.locator('.chat-code');
    await expect(userCode.locator('.chat-code-lang')).toHaveText('JQL');
    // Off by default: no gutter class, and Copy hands back bare code —
    // read from the clipboard rather than the button's transient label,
    // which a stray re-render could flip back before this reads it.
    await expect(userCode).not.toHaveClass(/line-numbers/);
    await userCode.getByRole('button', { name: 'Copy' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('project = OPS AND sprint in closedSprints() AND status not in (Done, Cancelled)\n');

    // Line numbers are this person's Appearance preference (off by
    // default, as just shown) — on, every block gets a gutter, a pure
    // CSS counter rather than a character the markup carries, so Copy
    // above and here both still return bare code, numbers or not.
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'theme', '{"mode":"auto","codeLineNumbers":true}'::jsonb)
       ON CONFLICT (tenant_id, subject, key) DO UPDATE SET value = EXCLUDED.value`,
      [E2E_TENANT_ID, E2E_SUBJECT]
    );
    try {
      await page.reload();
      const numberedSql = markdown.locator('.chat-code.line-numbers', {
        hasText: 'closedSprints()',
      });
      await expect(numberedSql).toBeVisible();
      // The gutter's digits are `::before` generated content — not a DOM
      // text node, so nothing here can read the rendered "1" back out
      // the way Copy or a selection would; what a script CAN confirm is
      // that every line is wired to the counter that draws it.
      const codeLines = numberedSql.locator('.chat-code-line');
      await expect(codeLines).toHaveCount(1);
      await expect
        .poll(() => codeLines.first().evaluate((el) => getComputedStyle(el).counterIncrement))
        .toContain('chat-code-line');
      await numberedSql.getByRole('button', { name: 'Copy' }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(
          'project = OPS AND sprint in closedSprints() AND status != Done ORDER BY updated DESC\n'
        );
    } finally {
      await client.query(
        `UPDATE user_preferences SET value = '{"mode":"auto","codeLineNumbers":false}'::jsonb
         WHERE tenant_id = $1 AND subject = $2 AND key = 'theme'`,
        [E2E_TENANT_ID, E2E_SUBJECT]
      );
      await page.reload();
    }

    // At phone width the header, and Copy in it, are still there — no hover
    // to bring a button out — and the block scrolls rather than the page.
    if (!mobile) {
      const wide = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(tsBlock.locator('.chat-code-lang')).toHaveText('TypeScript');
      await expect(tsBlock.getByRole('button', { name: 'Copy' })).toBeVisible();
      await expect(tsBlock.locator('pre')).toBeVisible();
      expect(await tsBlock.locator('pre').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        true
      );
      await shot(page, testInfo, 'chat-code-blocks-phone.png');
      if (wide) await page.setViewportSize(wide);
    }

    // The owner renames the chat: in place with the title bar's pencil on a
    // wide screen, or — the pencil is dropped there — from the title bar's
    // own overflow menu on a phone.
    const renameViaTitleBar = async (next: string) => {
      if (mobile) {
        await page.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menuitem', { name: 'Rename' }).click();
        const dialog = page.getByRole('dialog', { name: 'Rename chat' });
        await dialog.getByRole('textbox').fill(next);
        await dialog.getByRole('button', { name: 'Rename' }).click();
        await expect(dialog).toBeHidden();
        return;
      }
      await page.getByRole('button', { name: 'Rename chat' }).click();
      const nameField = page.getByRole('textbox', { name: 'Chat name' });
      await nameField.fill(next);
      await nameField.press('Enter');
    };
    await renameViaTitleBar(`${title} — renamed`);
    await expect(page.getByRole('heading', { level: 1, name: `${title} — renamed` })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Chats' })
        .getByRole('link', { name: `${title} — renamed` })
    ).toBeVisible();
    await renameViaTitleBar(title);
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
    await expect(page.getByText('Copy to a network share')).toBeVisible();
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
    // says what sending will do; Cancel empties it again. Resend asks
    // first. Scoped to this prompt's own group — a second prompt earlier
    // in the chat (the fenced one) carries the identical Edit/Resend
    // pair, always in the DOM even unhovered.
    const promptGroup = page.locator('div.group.items-end', {
      hasText: 'Which issues slipped out of the last OPS sprint?',
    });
    const bubble = promptGroup.getByText('Which issues slipped out of the last OPS sprint?');
    await bubble.hover();
    await promptGroup.getByRole('button', { name: 'Edit' }).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await expect(box).toHaveValue('Which issues slipped out of the last OPS sprint?');
    await expect(page.getByText(/Editing an earlier message/)).toBeVisible();
    await shot(page, testInfo, 'chat-edit.png');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(box).toHaveValue('');
    await bubble.hover();
    await promptGroup.getByRole('button', { name: 'Resend' }).click();
    await expect(page.getByRole('heading', { name: 'Resend this message?' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // On a phone every field is set at 16px or more, so focusing one never
    // zooms the page (iOS Safari zooms for anything smaller).
    if (mobile) {
      const fontSize = (selector: string) =>
        page
          .locator(selector)
          .first()
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(await fontSize('textarea[aria-label="Message"]')).toBeGreaterThanOrEqual(16);
      await page.getByRole('button', { name: 'Open menu' }).click();
      expect(await fontSize('input[aria-label="Find a chat"]')).toBeGreaterThanOrEqual(16);
      await page.keyboard.press('Escape');
    }

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
    // "+ New" creates the empty chat up front and lands on its own address,
    // so the first Send never has to move the page.
    await page.goto(`/${E2E_SLUG}/chat/new`);
    await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}/chat/[0-9a-f-]{36}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'New chat' })).toBeVisible();
    const newChatId = page.url().match(/\/chat\/([0-9a-f-]{36})$/)?.[1] ?? null;
    expect(newChatId).not.toBeNull();
    // Empty, it is not in the menu.
    await expect(page.locator(`a[href="/${E2E_SLUG}/chat/${newChatId}"]`)).toHaveCount(0);
  } finally {
    await client.query('DELETE FROM chats WHERE id = $1', [CHAT_ID]);
    // The empty chat "+ New" made above.
    await client.query(
      'DELETE FROM chats WHERE tenant_id = $1 AND owner_subject = $2 AND last_message_at IS NULL',
      [E2E_TENANT_ID, E2E_SUBJECT]
    );
    await client.query('DELETE FROM chats WHERE id = $1', [ids.archivedId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
    await client.end();
  }
});
