/**
 * Which git-host calls stand out in a thread. A reply's tool calls fold
 * into one collapsed line; in a code project's chat the calls a person
 * waits on — a pull request opened or merged, a commit, a branch — are
 * lifted out as cards of their own (lib/code/milestones.ts), while
 * reading a file, listing branches or pipelines, and the host's quieter
 * acts fold with the rest. In an ordinary chat nothing is lifted: a word
 * to GitHub or Bitbucket is a tool call like any other. The same turn is
 * seeded straight into the database twice — a plain chat, and a chat in
 * a code project — with ids of their own per Playwright project; also a
 * viewport pass at phone width.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function seal(plaintext: string): string {
  const encoded = process.env.CONTENT_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY || '';
  const key = Buffer.from(encoded, 'base64');
  if (key.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return (
    'renc1:' +
    [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join('.')
  );
}

/** Per-project fixtures: the Playwright projects share one database. */
function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a${digit}1`,
    turnId: `7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a${digit}2`,
    chatTitle: `Open a pull request for the timeout fix (host cards ${digit})`,
    projectId: `7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a${digit}3`,
    codeChatId: `7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a${digit}4`,
    codeTurnId: `7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a${digit}5`,
    projectName: `Demo service (host cards ${digit})`,
    codeChatTitle: `Open a pull request for the timeout fix (code, host cards ${digit})`,
  };
}

const PROMPT = 'Open a pull request for the timeout fix on acme/demo.';

async function db(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

async function clean(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chats WHERE id = $1 OR id = $2', [ids.chatId, ids.codeChatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
  } finally {
    await client.end();
  }
}

/**
 * One finished turn — two host reads, then the pull request, then the
 * reply — written into a plain chat and into a code project's chat.
 */
async function seed(ids: ReturnType<typeof idsFor>): Promise<void> {
  await clean(ids);
  const client = await db();
  try {
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, title, last_message_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [ids.chatId, E2E_TENANT_ID, E2E_SUBJECT, ids.chatTitle]
    );
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'The demo service.', 'code', 'github', 'acme/demo', 'main')`,
      [ids.projectId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectName]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, project_id, title, last_message_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [ids.codeChatId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectId, ids.codeChatTitle]
    );
    // The project's active chat — a history chat takes no turn (lib/code/active-chat.ts).
    await client.query('UPDATE chat_projects SET active_chat_id = $1 WHERE id = $2', [
      ids.codeChatId,
      ids.projectId,
    ]);
    for (const [chatId, turnId] of [
      [ids.chatId, ids.turnId],
      [ids.codeChatId, ids.codeTurnId],
    ]) {
      await client.query(
        `INSERT INTO chat_turns (id, tenant_id, chat_id, status, iterations, input_tokens, output_tokens, finished_at)
         VALUES ($1, $2, $3, 'completed', 3, 2100, 320, NOW())`,
        [turnId, E2E_TENANT_ID, chatId]
      );
      await seedTurn(client, chatId, turnId);
    }
  } finally {
    await client.end();
  }
}

async function seedTurn(client: Client, chatId: string, turnId: string): Promise<void> {
  {
    const rows: {
      seq: number;
      role: string;
      kind: string;
      stop: string | null;
      blocks: unknown[];
    }[] = [
      {
        seq: 1,
        role: 'user',
        kind: 'prompt',
        stop: null,
        blocks: [{ type: 'text', text: PROMPT }],
      },
      {
        seq: 2,
        role: 'assistant',
        kind: 'assistant',
        stop: 'tool_use',
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_e2e_branches',
            name: 'github_list_branches',
            input: { owner: 'acme', repo: 'demo' },
          },
          {
            type: 'tool_use',
            id: 'toolu_e2e_read',
            name: 'github_read_file',
            input: { owner: 'acme', repo: 'demo', path: 'src/timeout.ts', ref: 'fix/timeout' },
          },
        ],
      },
      {
        seq: 3,
        role: 'user',
        kind: 'tool_results',
        stop: null,
        blocks: [
          { type: 'tool_result', toolUseId: 'toolu_e2e_branches', content: 'main\nfix/timeout' },
          {
            type: 'tool_result',
            toolUseId: 'toolu_e2e_read',
            content: 'export const TIMEOUT_MS = 30_000;',
          },
        ],
      },
      {
        seq: 4,
        role: 'assistant',
        kind: 'assistant',
        stop: 'tool_use',
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_e2e_pr',
            name: 'github_create_pull_request',
            input: {
              owner: 'acme',
              repo: 'demo',
              title: 'Fix the timeout',
              head: 'fix/timeout',
              base: 'main',
            },
          },
        ],
      },
      {
        seq: 5,
        role: 'user',
        kind: 'tool_results',
        stop: null,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_e2e_pr',
            content:
              'Created pull request #12: Fix the timeout\nfix/timeout → main\n\n[Open in GitHub](https://github.com/acme/demo/pull/12)',
          },
        ],
      },
      {
        seq: 6,
        role: 'assistant',
        kind: 'assistant',
        stop: 'end_turn',
        blocks: [{ type: 'text', text: 'Pull request #12 is open against main.' }],
      },
    ];
    for (const row of rows) {
      await client.query(
        `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, stop_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8)`,
        [
          E2E_TENANT_ID,
          chatId,
          turnId,
          row.seq,
          row.role,
          row.kind,
          seal(JSON.stringify(row.blocks)),
          row.stop,
        ]
      );
    }
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('git-host tool cards in an ordinary chat', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seed(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await clean(idsFor(testInfo.project.name));
  });

  test('a plain chat folds every host call; a code chat lifts the pull request alone', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const shot = (name: string) =>
      page.screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
          'test-results',
          'screens',
          testInfo.project.name,
          name
        ),
        fullPage: false,
      });
    const main = page.getByRole('main');

    // ── The plain chat: no card at all — the pull request folds with the
    //    reads, three steps under one line ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expect(main.getByText('Pull request #12 is open against main.')).toBeVisible();
    await expect(main.locator('details[data-milestone]')).toHaveCount(0);
    const plainWork = main.locator('details.chat-fold').first();
    await expect(plainWork).toContainText('3 tool calls');
    await plainWork.locator('> summary').click();
    await expect(plainWork.locator('ol > li > details.chat-fold')).toHaveCount(3);
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-plain.png');

    // ── The code project's chat: the two reads are steps inside the one
    //    folded line, and the pull request stands on its own with the
    //    host's link ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.codeChatId}`);
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expect(main.locator('details[data-milestone="github_list_branches"]')).toHaveCount(0);
    await expect(main.locator('details[data-milestone="github_read_file"]')).toHaveCount(0);
    const work = main.locator('details.chat-fold:not([data-milestone])').first();
    await expect(work).toContainText('2 tool calls');
    await work.locator('> summary').click();
    await expect(work.locator('ol > li > details.chat-fold')).toHaveCount(2);
    const card = main.locator('details[data-milestone="github_create_pull_request"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Created pull request #12');
    await card.locator('> summary').click();
    await expect(card.getByRole('link', { name: 'Open in GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/acme/demo/pull/12'
    );
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-code.png');

    // ── Phone width, both ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expect(main.locator('details[data-milestone]')).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-code-mobile.png');
    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expect(main.locator('details[data-milestone]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-plain-mobile.png');
  });
});
