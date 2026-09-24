/**
 * A code chat's sub-agent and the model it ran on: the orchestrator sent
 * it on a cheaper model of the org's (`code_delegate`'s `model`,
 * lib/code/delegate.ts), so its card in the thread says which, and the
 * run's transcript (lib/chat/subagent-runs.ts, migration 118) names the
 * model that actually answered, by the config's label. Seeded straight
 * into the database as the runner leaves a finished turn — no model is
 * called — with ids of its own per Playwright project, so the projects
 * running side by side never race (code.spec.ts keeps the same rule).
 * Also a viewport pass at phone width.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  // The mobile project's device descriptor asks for WebKit, which is not
  // installed here; the pinned Chromium runs every project.
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
  const digit = { 'desktop-light': '5', 'desktop-dark': '6', mobile: '7' }[project] ?? '8';
  return {
    projectId: `77777777-7777-4777-8777-7777777777${digit}1`,
    chatId: `77777777-7777-4777-8777-7777777777${digit}2`,
    turnId: `77777777-7777-4777-8777-7777777777${digit}3`,
    fastModelId: `77777777-7777-4777-8777-7777777777${digit}4`,
    fastModelLabel: `Fast model (${digit})`,
    projectName: `Billing service (sub-agent ${digit})`,
    chatTitle: `Why does the invoice job retry? (sub-agent ${digit})`,
  };
}

const TASK = 'Find every place the invoice job’s retry count is read or written.';
const REPORT =
  'Three places: jobs/invoice.ts:41 reads it, jobs/invoice.ts:58 increments it, and lib/retry.ts:12 caps nothing.';

async function db(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

async function clean(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.fastModelId]);
  } finally {
    await client.end();
  }
}

/**
 * A code project, a chat in it, and one finished turn: the prompt, the
 * sub-agent the orchestrator sent to investigate on the org's cheaper
 * model (its run recorded with that model), and the reply.
 */
async function seed(ids: ReturnType<typeof idsFor>): Promise<void> {
  await clean(ids);
  const client = await db();
  try {
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'Invoices and the nightly jobs.', 'code', 'atlassian-bitbucket', 'acme/billing-service', 'main')`,
      [ids.projectId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectName]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, project_id, title, last_message_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [ids.chatId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectId, ids.chatTitle]
    );
    // The project's active chat — a history chat takes no turn (lib/code/active-chat.ts).
    await client.query('UPDATE chat_projects SET active_chat_id = $1 WHERE id = $2', [
      ids.chatId,
      ids.projectId,
    ]);
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
        blocks: [{ type: 'text', text: 'Why does the invoice job retry forever?' }],
      },
      {
        seq: 2,
        role: 'assistant',
        kind: 'assistant',
        stop: 'tool_use',
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_e2e_delegate',
            name: 'code_delegate',
            input: { task: TASK, readOnly: true, model: ids.fastModelLabel },
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
            toolUseId: 'toolu_e2e_delegate',
            content: `Sub-agent done — 2 model calls, 1 tool call (code_grep×1).\n\nReport:\n${REPORT}`,
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
            text: 'The retry loop has no ceiling: three places touch the count and none caps it.',
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
          { type: 'text', text: 'Searching for the retry count.' },
          {
            type: 'tool_use',
            id: 'toolu_e2e_sub_grep',
            name: 'code_grep',
            input: { pattern: 'retryCount' },
          },
        ],
        // How long this model call took, as delegate.ts keeps it beside the message.
        durationMs: 4200,
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_e2e_sub_grep',
            content: 'jobs/invoice.ts:41\njobs/invoice.ts:58\nlib/retry.ts:12',
            durationMs: 310,
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: REPORT }] },
    ];
    await client.query(
      `INSERT INTO chat_subagent_runs
         (tenant_id, chat_id, turn_id, tool_use_id, status, task, read_only, max_steps, steps, tool_calls,
          transcript, report, input_tokens, output_tokens, llm_model_id, provider, model, finished_at)
       VALUES ($1, $2, $3, 'toolu_e2e_delegate', 'completed', $4, TRUE, 40, 2, 1, $5, $6, 640, 90,
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

test.describe('code chat sub-agent model', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seed(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await clean(idsFor(testInfo.project.name));
  });

  test('the card names the model the orchestrator picked; the transcript names what answered', async ({
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
    await expect(main.getByText('Why does the invoice job retry forever?')).toBeVisible();

    // ── The sub-agent's card, folded: the model it was sent on, beside
    //    its read-only mark and the first line of its report. The one
    //    call of its turn, it stands on its own in the thread rather than
    //    inside a fold of steps ──
    const subagent = main.locator('details[data-subagent]');
    await expect(subagent).toContainText('Sub-agent reported');
    await expect(subagent).toContainText('read-only');
    await expect(subagent.locator('[data-subagent-model]')).toHaveText(`on ${ids.fastModelLabel}`);
    await subagent.locator('> summary').click();
    await expect(subagent).toHaveAttribute('open', '');
    await expect(subagent.getByText('Three places:', { exact: false })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-chat-subagent-card.png');

    // ── Its transcript: the model that actually answered, by the config's
    //    label with the provider and model name behind it, the counts, and
    //    the sub-agent's own steps ──
    await subagent.getByRole('button', { name: 'View transcript' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sub-agent' });
    await expect(dialog.getByText('2 of 40 model calls')).toBeVisible();
    const model = dialog.locator('[data-subagent-model]');
    await expect(model).toHaveText(`on ${ids.fastModelLabel}`);
    await expect(model).toHaveAttribute('title', 'anthropic claude-haiku-4-5');
    await expect(dialog.getByText('Searching for the retry count.')).toBeVisible();
    await expect(dialog.getByText(TASK)).toBeVisible();
    // Where its time went: each model call's own duration on its heading,
    // and the tool call's on its line — the second model call, recorded
    // before durations were kept, carries none and says nothing.
    await expect(dialog.locator('[data-model-call-duration]')).toHaveCount(1);
    await expect(dialog.locator('[data-model-call-duration]')).toHaveText('· 4s');
    await expect(dialog.locator('[data-call-duration]')).toHaveText('0.3s');
    await shot('code-chat-subagent-transcript.png');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // ── Phone width: the same card and the same line, nothing overflowing ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(main.getByText('Why does the invoice job retry forever?')).toBeVisible();
    const narrow = main.locator('details[data-subagent]');
    await expect(narrow.locator('[data-subagent-model]')).toHaveText(`on ${ids.fastModelLabel}`);
    await expectNoHorizontalOverflow(page);
    await shot('code-chat-subagent-mobile.png');
  });
});
