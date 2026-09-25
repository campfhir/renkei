/**
 * An ordinary chat's sub-agent — no project, no checkout: the assistant
 * handed a reading errand to `chat_delegate` (lib/chat/chat-delegate.ts)
 * on a cheaper model of the org's, and the thread shows it the way a
 * code chat shows its own: a card of its own, marked read-only (a chat
 * sub-agent only ever reads), naming the model it ran on, with its
 * transcript a button away — which used to need a code project. Seeded
 * straight into the database as the runner leaves a finished turn, with
 * ids of its own per Playwright project (code-subagent.spec.ts keeps the
 * same rule). Also a viewport pass at phone width.
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

/** `@renkei/crypto`'s secretbox: `v1.<iv>.<tag>.<ciphertext>` under TOKEN_ENCRYPTION_KEY. */
function secretbox(plaintext: string): string {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const key = Buffer.from(encoded, 'base64');
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

/** Sealed chat content: the `renc1:` envelope over the secretbox. */
function sealContent(plaintext: string): string {
  return `renc1:${secretbox(plaintext)}`;
}

/** Per-project fixtures: the Playwright projects share one database. */
function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `79797979-7979-4797-8797-7979797979${digit}1`,
    turnId: `79797979-7979-4797-8797-7979797979${digit}2`,
    fastModelId: `79797979-7979-4797-8797-7979797979${digit}3`,
    fastModelLabel: `Reading model (${digit})`,
    chatTitle: `What slipped out of the OPS sprint? (sub-agent ${digit})`,
  };
}

const TASK =
  'Read every OPS issue that was in the last closed sprint and is not Done; report each key, its status and its assignee.';
const REPORT =
  'Two issues: OPS-41 (In Progress, Priya) — rotating the Zoom webhook secret; OPS-44 (To Do, Marcus) — backfilling the file share index.';

async function db(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

async function clean(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.fastModelId]);
  } finally {
    await client.end();
  }
}

/** A plain chat — no project — with one finished turn: prompt, the sub-agent's errand, the reply. */
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
      `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, enabled, is_default)
       VALUES ($1, $2, $3, 'anthropic', 'claude-haiku-4-5', $4, TRUE, FALSE)`,
      [ids.fastModelId, E2E_TENANT_ID, ids.fastModelLabel, secretbox('{"apiKey":"e2e"}')]
    );
    await client.query(
      `INSERT INTO chat_turns (id, tenant_id, chat_id, status, iterations, input_tokens, output_tokens, finished_at)
       VALUES ($1, $2, $3, 'completed', 2, 1540, 210, NOW())`,
      [ids.turnId, E2E_TENANT_ID, ids.chatId]
    );
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
        blocks: [{ type: 'text', text: 'Which issues slipped out of the last OPS sprint?' }],
      },
      {
        seq: 2,
        role: 'assistant',
        kind: 'assistant',
        stop: 'tool_use',
        blocks: [
          { type: 'text', text: 'Let me have the sprint looked through.' },
          {
            type: 'tool_use',
            id: 'toolu_e2e_chat_delegate',
            name: 'chat_delegate',
            input: { task: TASK, model: ids.fastModelLabel },
          },
        ],
      },
      {
        seq: 3,
        role: 'user',
        kind: 'tool_results',
        stop: null,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_e2e_chat_delegate',
            content: `Sub-agent done — 2 model calls, 1 tool call (jira_search_issues×1).\n\nReport:\n${REPORT}`,
          },
        ],
      },
      {
        seq: 4,
        role: 'assistant',
        kind: 'assistant',
        stop: 'end_turn',
        blocks: [
          {
            type: 'text',
            text: 'Two issues slipped: OPS-41 with Priya and OPS-44 with Marcus. Both are still open.',
          },
        ],
      },
    ];
    for (const row of rows) {
      await client.query(
        `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, stop_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8)`,
        [
          E2E_TENANT_ID,
          ids.chatId,
          ids.turnId,
          row.seq,
          row.role,
          row.kind,
          sealContent(JSON.stringify(row.blocks)),
          row.stop,
        ]
      );
    }
    const transcript = [
      { role: 'user', content: [{ type: 'text', text: TASK }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Searching the closed sprint.' },
          {
            type: 'tool_use',
            id: 'toolu_e2e_sub_search',
            name: 'jira_search_issues',
            input: { jql: 'project = OPS AND sprint in closedSprints() AND status != Done' },
          },
        ],
        durationMs: 3100,
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_e2e_sub_search',
            content: 'OPS-41 In Progress Priya\nOPS-44 To Do Marcus',
            durationMs: 640,
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: REPORT }] },
    ];
    await client.query(
      `INSERT INTO chat_subagent_runs
         (tenant_id, chat_id, turn_id, tool_use_id, status, task, read_only, max_steps, steps, tool_calls,
          transcript, report, input_tokens, output_tokens, llm_model_id, provider, model, finished_at)
       VALUES ($1, $2, $3, 'toolu_e2e_chat_delegate', 'completed', $4, TRUE, 15, 2, 1, $5, $6, 640, 90,
               $7, 'anthropic', 'claude-haiku-4-5', NOW())`,
      [
        E2E_TENANT_ID,
        ids.chatId,
        ids.turnId,
        sealContent(TASK),
        sealContent(JSON.stringify(transcript)),
        sealContent(REPORT),
        ids.fastModelId,
      ]
    );
  } finally {
    await client.end();
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('ordinary chat sub-agent', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seed(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await clean(idsFor(testInfo.project.name));
  });

  test('a plain chat shows the sub-agent card, read-only, with its transcript', async ({
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

    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(main.getByText('Which issues slipped out of the last OPS sprint?')).toBeVisible();

    // ── The card, folded: a chat sub-agent is read-only by nature, ran on
    //    the model the assistant picked, and reported ──
    const subagent = main.locator('details[data-subagent]');
    await expect(subagent).toContainText('Sub-agent reported');
    await expect(subagent).toContainText('read-only');
    await expect(subagent.locator('[data-subagent-model]')).toHaveText(`on ${ids.fastModelLabel}`);
    await subagent.locator('> summary').click();
    await expect(subagent).toHaveAttribute('open', '');
    await expect(subagent.getByText('Two issues: OPS-41', { exact: false })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('chat-subagent-card.png');

    // ── Its transcript opens from here, without a code project ──
    await subagent.getByRole('button', { name: 'View transcript' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sub-agent' });
    await expect(dialog.getByText('2 of 15 model calls')).toBeVisible();
    await expect(dialog.locator('[data-subagent-model]')).toHaveText(`on ${ids.fastModelLabel}`);
    await expect(dialog.getByText('Searching the closed sprint.')).toBeVisible();
    await expect(dialog.getByText(TASK)).toBeVisible();
    await shot('chat-subagent-transcript.png');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // ── Phone width ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(main.getByText('Which issues slipped out of the last OPS sprint?')).toBeVisible();
    const narrow = main.locator('details[data-subagent]');
    await expect(narrow).toContainText('read-only');
    await expectNoHorizontalOverflow(page);
    await shot('chat-subagent-mobile.png');
  });
});
