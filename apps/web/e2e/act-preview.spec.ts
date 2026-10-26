/**
 * The act-preview card (lib/mcp-widgets/src/act-preview.ts, act-render.ts):
 * the preview every act tool without a hand-written one draws in chat, one
 * layout per kind of act (act-card.ts).
 *
 * Seeded straight into the tables like directory-action-preview.spec.ts —
 * the real widget route, the real built bundle, the real chat thread; only
 * the confirm button's `tools/call` is mocked at the browser edge, since
 * for real it would reach Jira.
 *
 * Proves:
 *  - a comment card shows the comment where it will land, lets the person
 *    rewrite the words, and the confirm button sends THEIR words to the
 *    tool's `_confirm` twin with the rest of the arguments unchanged;
 *  - Cancel runs nothing;
 *  - every kind of card draws (a gallery of one card per layout, screenshot
 *    for review) and none overflows a phone-width viewport.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from './worker-env';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
import { keyFor } from './keys';
import { isolateFile } from './worker-env';

// Each file starts from a database of its own: this runs before the file's other hooks.
test.beforeAll(isolateFile);


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
const ACT_PREVIEW_URI = widgetUri('act-preview.ts', 'act-preview');

function idsFor(project: string, variant: '1' | '2' | '3' | '4') {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}1`,
    turnId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}2`,
    modelId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}3`,
    title: `Act preview (${variant}${digit})`,
    modelLabel: `Act preview model ${variant}${digit}`,
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

/** One seeded preview: the tool the model called and the card it answered with. */
interface SeededCard {
  tool: string;
  input: Record<string, unknown>;
  card: Record<string, unknown>;
}

let nextPreview = 0;
function card(
  tool: string,
  input: Record<string, unknown>,
  shell: Record<string, unknown>
): SeededCard {
  nextPreview += 1;
  return {
    tool,
    input,
    card: {
      kind: 'act',
      previewId: `e2e-act-${process.pid}-${nextPreview}-${Date.now()}`,
      tone: 'neutral',
      confirmTool: `${tool.replace(/_preview$/, '')}_confirm`,
      confirmArgs: input,
      ...shell,
    },
  };
}

const COMMENT_INPUT = { issueKey: 'PROJ-12', comment: 'Looks good to me — shipping Friday.' };
const commentCard = () =>
  card('jira_add_comment_preview', COMMENT_INPUT, {
    verb: 'Comment',
    icon: 'comment',
    title: 'Comment on PROJ-12',
    subtitle: 'Jira',
    confirmLabel: 'Post comment',
    editable: [{ key: 'comment', label: 'Comment', multiline: true }],
    body: {
      kind: 'comment',
      mode: 'add',
      on: { label: 'PROJ-12' },
      bodyKey: 'comment',
      body: COMMENT_INPUT.comment,
    },
  });

/** One card per layout, for the gallery. */
function gallery(): SeededCard[] {
  return [
    commentCard(),
    card(
      'jsm_add_request_comment_preview',
      { issueKey: 'HELP-9', comment: 'We have reset your access.', isInternal: false },
      {
        verb: 'Reply',
        icon: 'comment',
        title: 'Reply to the customer on HELP-9',
        subtitle: 'Jira Service Management',
        editable: [{ key: 'comment', label: 'Reply', multiline: true }],
        body: {
          kind: 'comment',
          mode: 'add',
          on: { label: 'HELP-9', title: 'Request' },
          bodyKey: 'comment',
          body: 'We have reset your access.',
          badges: ['Public reply', 'The customer is notified'],
        },
      }
    ),
    card(
      'bitbucket_add_pr_comment_preview',
      {
        workspace: 'acme',
        repoSlug: 'app',
        id: 4,
        comment: 'Why not a Map here?',
        path: 'src/a.ts',
        line: 18,
      },
      {
        verb: 'Comment',
        icon: 'comment',
        title: 'Comment on src/a.ts in #4',
        subtitle: 'Bitbucket · acme/app',
        editable: [{ key: 'comment', label: 'Comment', multiline: true }],
        body: {
          kind: 'comment',
          mode: 'add',
          on: { label: '#4', title: 'Pull request', context: 'acme/app' },
          bodyKey: 'comment',
          body: 'Why not a Map here?',
          badges: ['Inline'],
          anchor: { file: 'src/a.ts', line: 18 },
        },
      }
    ),
    card(
      'jira_transition_issue_preview',
      { issueKey: 'PROJ-12', transitionName: 'Done' },
      {
        verb: 'Move',
        icon: 'arrow',
        title: 'Move PROJ-12 to Done',
        subtitle: 'Jira',
        body: {
          kind: 'transition',
          subject: { label: 'PROJ-12' },
          field: 'Workflow transition',
          to: 'Done',
        },
      }
    ),
    card(
      'jira_log_work_preview',
      { issueKey: 'PROJ-12', timeSpent: '1h 30m', comment: 'Pairing on the migration.' },
      {
        verb: 'Log time',
        icon: 'clock',
        title: 'Log 1h 30m on PROJ-12',
        subtitle: 'Jira',
        editable: [{ key: 'comment', label: 'What you worked on', multiline: true }],
        body: {
          kind: 'worklog',
          mode: 'log',
          on: { label: 'PROJ-12' },
          duration: '1h 30m',
          bodyKey: 'comment',
          body: 'Pairing on the migration.',
        },
      }
    ),
    card(
      'jira_create_issue_link_preview',
      { linkType: 'Blocks', fromIssueKey: 'PROJ-12', toIssueKey: 'PROJ-30' },
      {
        verb: 'Link',
        icon: 'link',
        title: 'Link PROJ-12 to PROJ-30',
        subtitle: 'Jira',
        body: {
          kind: 'link',
          mode: 'create',
          from: { label: 'PROJ-12' },
          relation: 'Blocks',
          to: { label: 'PROJ-30' },
        },
      }
    ),
    card(
      'github_grant_repository_permission_preview',
      { owner: 'acme', repo: 'app', username: 'sam', permission: 'push' },
      {
        verb: 'Grant',
        tone: 'caution',
        icon: 'users',
        title: 'Give sam push access to acme/app',
        subtitle: 'GitHub',
        body: {
          kind: 'access',
          mode: 'grant',
          who: [{ name: 'sam', kind: 'user' }],
          level: 'push',
          on: { label: 'acme/app', title: 'Repository' },
        },
      }
    ),
    card(
      'confluence_update_page_preview',
      { pageId: '98765', markdown: '# Handbook\n\nThe 2026 edition.', title: 'Handbook 2026' },
      {
        verb: 'Edit',
        icon: 'doc',
        title: 'Edit page 98765 — “Handbook 2026”',
        subtitle: 'Confluence',
        editable: [
          { key: 'title', label: 'Title', multiline: false },
          { key: 'markdown', label: 'New content', multiline: true },
        ],
        body: {
          kind: 'document',
          mode: 'update',
          type: 'Page',
          titleKey: 'title',
          title: 'Handbook 2026',
          location: ['Page 98765'],
          bodyKey: 'markdown',
          body: '# Handbook\n\nThe 2026 edition.',
          bodyLabel: 'The page will read',
          versionNote: 'Refresh for 2026',
        },
      }
    ),
    card(
      'onedrive_move_document_preview',
      { path: 'Reports/Q3.xlsx', destinationPath: 'Archive/2026' },
      {
        verb: 'Move',
        icon: 'folder',
        title: 'Move Q3.xlsx',
        subtitle: 'OneDrive',
        body: {
          kind: 'fileop',
          mode: 'move',
          items: [{ name: 'Q3.xlsx', path: '/Reports', type: 'file' }],
          to: { path: 'Archive/2026' },
          note: 'Links people already have keep working.',
        },
      }
    ),
    card(
      'github_commit_files_preview',
      { owner: 'acme', repo: 'app', branch: 'feature', message: 'Rename the helper', files: [] },
      {
        verb: 'Commit',
        icon: 'commit',
        title: 'Commit 3 files to feature',
        subtitle: 'GitHub · acme/app',
        editable: [{ key: 'message', label: 'Commit message', multiline: false }],
        body: {
          kind: 'commit',
          repo: 'acme/app',
          branch: 'feature',
          messageKey: 'message',
          message: 'Rename the helper',
          files: [
            { path: 'src/a.ts', status: 'modify', lines: 42 },
            { path: 'src/b.ts', status: 'add', lines: 9 },
            { path: 'src/old.ts', status: 'delete' },
          ],
        },
      }
    ),
    card(
      'bitbucket_approve_pull_request_preview',
      { workspace: 'acme', repoSlug: 'app', id: 4 },
      {
        verb: 'Approve',
        tone: 'positive',
        icon: 'check',
        title: 'Approve pull request #4',
        subtitle: 'Bitbucket · acme/app',
        body: {
          kind: 'verdict',
          verdict: 'approve',
          pullRequest: { label: '#4', title: 'Pull request', context: 'acme/app' },
        },
      }
    ),
    card(
      'outlook_create_event_preview',
      { subject: 'Standup', start: '2026-10-21T09:00:00', end: '2026-10-21T09:15:00' },
      {
        verb: 'Create',
        icon: 'calendar',
        title: 'Create the event “Standup”',
        subtitle: 'Outlook',
        body: {
          kind: 'event',
          mode: 'create',
          subject: 'Standup',
          start: '2026-10-21T09:00:00',
          end: '2026-10-21T09:15:00',
          timezone: 'America/Chicago',
          where: 'Room 4',
          online: true,
          recurrence: 'every week on Monday',
          attendees: [{ name: 'ana@example.com' }, { name: 'lee@example.com', optional: true }],
        },
      }
    ),
    card(
      'jira_complete_sprint_preview',
      { boardId: '3', sprintId: '41' },
      {
        verb: 'Complete',
        tone: 'caution',
        icon: 'sprint',
        title: 'Complete sprint 41',
        subtitle: 'Jira',
        body: {
          kind: 'sprint',
          mode: 'complete',
          sprint: {
            id: '41',
            name: 'Sprint 41',
            board: '3',
            start: '2026-10-05',
            end: '2026-10-19',
            goal: 'Ship the importer',
          },
        },
      }
    ),
    card(
      'bitbucket_update_pull_request_preview',
      { workspace: 'acme', repoSlug: 'app', id: 4, title: 'Faster importer' },
      {
        verb: 'Update',
        icon: 'merge',
        title: 'Update pull request #4',
        subtitle: 'Bitbucket · acme/app',
        body: {
          kind: 'change',
          subject: { label: '#4', title: 'Pull request', context: 'acme/app' },
          rows: [
            { label: 'Title', value: 'Faster importer' },
            { label: 'Reviewers', value: 'ana, lee' },
            { label: 'Labels', add: ['perf'], remove: ['wip'] },
          ],
          notes: ['Only what is shown changes.'],
        },
      }
    ),
    card(
      'outlook_move_message_preview',
      { messageId: 'AAMk', destinationFolder: 'archive' },
      {
        verb: 'Move',
        icon: 'folder',
        title: 'Move a message to archive',
        subtitle: 'Outlook',
        body: { kind: 'mailbox', mode: 'move', messages: '1 message', to: 'archive' },
      }
    ),
    card(
      'bitbucket_delete_branch_preview',
      { workspace: 'acme', repoSlug: 'app', name: 'old-feature' },
      {
        verb: 'Delete',
        tone: 'danger',
        icon: 'branch',
        title: 'Delete the branch old-feature',
        subtitle: 'Bitbucket · acme/app',
        body: { kind: 'branch', mode: 'delete', repo: 'acme/app', name: 'old-feature' },
      }
    ),
  ];
}

async function seedChat(client: Client, ids: Ids, cards: SeededCard[]): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
  await client.query(
    `INSERT INTO llm_model_configs (id, label, provider, model, base_url, encrypted_secrets, enabled, is_default)
     VALUES ($1, $2, 'anthropic', 'e2e-model', $3, $4, true, false)`,
    [
      ids.modelId,
      ids.modelLabel,
      STUB_MODEL_BASE_URL,
      sealSecret(JSON.stringify({ apiKey: 'e2e' })),
    ]
  );
  await client.query(
    `INSERT INTO chats (id, owner_subject, title, llm_model_id, last_message_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [ids.chatId, E2E_SUBJECT, ids.title, ids.modelId]
  );
  const chatKey = await keyFor(client, {
    kind: 'chat',
    resourceId: ids.chatId,
    ownerSubject: E2E_SUBJECT,
  });
  await client.query(
    `INSERT INTO chat_turns (id, chat_id, status, llm_model_id, iterations, finished_at)
     VALUES ($1, $2, 'completed', $3, 2, NOW())`,
    [ids.turnId, ids.chatId, ids.modelId]
  );
  const toolUseId = (index: number) => `toolu_act_${ids.chatId.slice(-5)}_${index}`;
  const rows: { seq: number; role: string; kind: string; blocks: unknown[] }[] = [
    { seq: 1, role: 'user', kind: 'prompt', blocks: [{ type: 'text', text: 'Do these for me.' }] },
    {
      seq: 2,
      role: 'assistant',
      kind: 'assistant',
      blocks: [
        { type: 'text', text: 'Here are previews — nothing changes until you confirm.' },
        ...cards.map((seeded, index) => ({
          type: 'tool_use',
          id: toolUseId(index),
          name: seeded.tool,
          input: seeded.input,
        })),
      ],
    },
    {
      seq: 3,
      role: 'user',
      kind: 'tool_results',
      blocks: cards.map((seeded, index) => ({
        type: 'tool_result',
        toolUseId: toolUseId(index),
        content: 'Awaiting the user’s decision on the preview card.',
        uiResourceUri: ACT_PREVIEW_URI,
        structuredContent: seeded.card,
      })),
    },
  ];
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    await client.query(
      `INSERT INTO chat_messages (chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model)
       VALUES ($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9)`,
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

test('a comment card shows the comment, takes the person’s rewrite, and confirms THEIR words', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '1');
  try {
    await seedChat(client, ids, [commentCard()]);
    const confirmCall: { value: { name: unknown; arguments: unknown } | null } = { value: null };
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmCall.value = route.request().postDataJSON();
      await route.fulfill({
        json: {
          result: {
            content: [{ type: 'text', text: 'Commented on PROJ-12.' }],
            isError: false,
            meta: {},
          },
        },
      });
    });

    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText('Comment on PROJ-12', COLD);
    await expect(frame.locator('.a-verb')).toHaveText('Comment');
    await expect(frame.locator('.a-ref-label')).toHaveText('PROJ-12');
    // It is a comment bubble on the issue, not a list of arguments.
    await expect(frame.getByText('You will post')).toBeVisible();
    const box = frame.getByLabel('Comment');
    await expect(box).toHaveValue(COMMENT_INPUT.comment);
    await waitForCardHeightAtLeast(page, 220);
    await shot(page, testInfo, 'act-preview-comment.png');

    await box.fill('Approved — please ship it today.');
    await frame.getByRole('button', { name: 'Post comment' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Commented on PROJ-12.');
    await waitForCardHeightBelow(page, 150);
    await shot(page, testInfo, 'act-preview-comment-done.png');

    // The twin, with the person's words over the model's, nothing else changed.
    expect(confirmCall.value?.name).toBe('jira_add_comment_confirm');
    expect(confirmCall.value?.arguments).toEqual({
      issueKey: 'PROJ-12',
      comment: 'Approved — please ship it today.',
    });

    await expect(
      noteLine(page, 'The user confirmed "Comment on PROJ-12" on the preview card')
    ).toBeVisible(COLD);
    await expect(page.getByText('Stub model: I saw')).toBeVisible(COLD);
    await expect
      .poll(() => decisionTurn(client, ids.chatId), COLD)
      .toEqual({ status: 'completed', noteTurnId: expect.any(String) });
  } finally {
    await client.end();
  }
});

test('cancelling a card runs nothing', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '2');
  try {
    await seedChat(client, ids, [commentCard()]);
    let confirmed = false;
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmed = true;
      await route.abort();
    });
    await page.goto(`/chat/${ids.chatId}`);
    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText('Comment on PROJ-12', COLD);
    await frame.getByRole('button', { name: 'Cancel' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Cancelled');
    await expect(
      noteLine(page, 'The user cancelled "Comment on PROJ-12" from the preview card')
    ).toBeVisible(COLD);
    expect(confirmed).toBe(false);
  } finally {
    await client.end();
  }
});

test('every kind of card draws, and none overflows a phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '3');
  const cards = gallery();
  try {
    await seedChat(client, ids, cards);
    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

    const frames = page.locator('iframe[title="Preview card"]');
    await expect(frames).toHaveCount(cards.length, COLD);
    for (const [index, seeded] of cards.entries()) {
      const frame = page.frameLocator('iframe[title="Preview card"]').nth(index);
      await expect(frame.locator('.card-title')).toHaveText(String(seeded.card.title), COLD);
      await expect(frame.locator('.a-verb')).toHaveText(String(seeded.card.verb));
      // Drawn by its own layout, not the "could not be prepared" fallback.
      await expect(frame.locator('.a-body')).toBeVisible();
      await expect(frame.locator('.status.error')).toHaveCount(0);
    }
    // Let every iframe grow to its content before the shots.
    await page.waitForTimeout(800);
    for (const [index, seeded] of cards.entries()) {
      await frames.nth(index).scrollIntoViewIfNeeded();
      await frames.nth(index).screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
          'test-results',
          'screens',
          testInfo.project.name,
          `act-preview-${String(index + 1).padStart(2, '0')}-${seeded.tool.replace(/_preview$/, '')}.png`
        ),
      });
    }

    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.waitForTimeout(800);
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    for (let index = 0; index < cards.length; index += 1) {
      const frame = page.frameLocator('iframe[title="Preview card"]').nth(index);
      const overflow = await frame
        .locator('body')
        .evaluate((body) => body.scrollWidth - body.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
    await shot(page, testInfo, 'act-preview-gallery-mobile.png');
  } finally {
    await client.end();
  }
});
