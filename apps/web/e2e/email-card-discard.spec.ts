/**
 * Email preview cards in one chat: discarding the first must leave the
 * next one fully editable — its To, Subject and Body are a live form, not
 * the receipt the discarded card shows. And a reply card's own text is
 * editable too (it used to be shown read-only, which read as exactly this
 * bug): an edit goes to the confirm tool with the message it answers, so
 * the draft is rebuilt around the quoted thread.
 *
 * Seeded the way widget-card.spec.ts seeds its chats (sealed rows, the
 * real built email-compose bundle, the real decision and model-context
 * routes against the stub model). Only the card's `tools/call` is
 * mocked at the browser edge — for real it would reach Microsoft Graph.
 */

import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
import { keyFor } from './keys';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

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
const EMAIL_COMPOSE_URI = widgetUri('email-compose.ts', 'email-compose');

function idsFor(project: string, variant: '1' | '2' | '3') {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}1`,
    turnIdA: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}2`,
    turnIdB: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}4`,
    modelId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeee${variant}${digit}3`,
    title: `Email the vendor (${variant}${digit})`,
    modelLabel: `Email widget model ${variant}${digit}`,
  };
}
type Ids = ReturnType<typeof idsFor>;

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

interface Draft {
  toolUseId: string;
  draftId: string;
  subject: string;
  body: string;
  /** A reply card: the message it answers. */
  replyTo?: string;
}

function emailRows(draft: Draft, prompt: string, firstSeq: number) {
  const input = { to: ['vendor@example.com'], subject: draft.subject, body: draft.body };
  return [
    { seq: firstSeq, role: 'user', kind: 'prompt', blocks: [{ type: 'text', text: prompt }] },
    {
      seq: firstSeq + 1,
      role: 'assistant',
      kind: 'assistant',
      blocks: [
        { type: 'text', text: 'Here’s the draft — nothing is sent until you confirm.' },
        {
          type: 'tool_use',
          id: draft.toolUseId,
          name: draft.replyTo ? 'outlook_reply_preview' : 'outlook_send_mail_preview',
          input,
        },
      ],
    },
    {
      seq: firstSeq + 2,
      role: 'user',
      kind: 'tool_results',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: draft.toolUseId,
          content: 'The email is drafted and awaiting the user’s decision on the preview card.',
          uiResourceUri: EMAIL_COMPOSE_URI,
          structuredContent: {
            kind: draft.replyTo ? 'reply' : 'compose',
            draftId: draft.draftId,
            ...(draft.replyTo ? { messageId: draft.replyTo } : {}),
            to: ['vendor@example.com'],
            cc: [],
            bcc: [],
            subject: draft.subject,
            body: draft.body,
            bodyHtml: `<p>${draft.body}</p>`,
          },
        },
      ],
    },
  ];
}

async function seedChat(client: Client, ids: Ids): Promise<void> {
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
}

/** One completed turn presenting one email card. */
async function seedEmailTurn(
  client: Client,
  ids: Ids,
  turnId: string,
  draft: Draft,
  prompt: string
): Promise<void> {
  const chatKey = await keyFor(client, {
    kind: 'chat',
    resourceId: ids.chatId,
    ownerSubject: E2E_SUBJECT,
  });
  await client.query(
    `INSERT INTO chat_turns (id, chat_id, status, llm_model_id, iterations, finished_at)
     VALUES ($1, $2, 'completed', $3, 2, NOW())`,
    [turnId, ids.chatId, ids.modelId]
  );
  const { rows } = await client.query<{ next: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM chat_messages WHERE chat_id = $1',
    [ids.chatId]
  );
  for (const row of emailRows(draft, prompt, Number(rows[0].next))) {
    const assistant = row.role === 'assistant';
    await client.query(
      `INSERT INTO chat_messages (chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model)
       VALUES ($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9)`,
      [
        ids.chatId,
        turnId,
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

function draftFor(ids: Ids, which: 'a' | 'b'): Draft {
  return {
    toolUseId: `toolu_email_${ids.chatId.slice(-3)}_${which}`,
    draftId: `AAMkAD-${randomUUID()}`,
    subject: which === 'a' ? 'Invoice question' : 'Invoice question, take two',
    body: which === 'a' ? 'Hi — about invoice 1042.' : 'Hello again — invoice 1042.',
  };
}

/** Stand in for Graph: discard and send both succeed. Returns what the card called. */
async function mockGraph(page: Page): Promise<unknown[]> {
  const calls: unknown[] = [];
  await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
    const body: unknown = route.request().postDataJSON();
    calls.push(body);
    const discard = JSON.stringify(body).includes('outlook_discard_draft_confirm');
    await route.fulfill({
      json: { result: { content: [{ type: 'text', text: discard ? 'Discarded.' : 'Sent.' }] } },
    });
  });
  return calls;
}

async function expectEditable(page: Page, card: number, text: string): Promise<void> {
  const frame = page.frameLocator('iframe[title="Preview card"]').nth(card);
  const body = frame.locator('textarea');
  await expect(body).toBeVisible(COLD);
  await expect(body).toBeEditable();
  await body.fill(text);
  await expect(body).toHaveValue(text);
  const subject = frame.locator('input').nth(1);
  await subject.fill('Edited subject');
  await expect(subject).toHaveValue('Edited subject');
}

test('discarding one email card leaves the next card in the chat editable', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '1');
  try {
    await seedChat(client, ids);
    await seedEmailTurn(client, ids, ids.turnIdA, draftFor(ids, 'a'), 'Email the vendor.');
    const calls = await mockGraph(page);

    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();
    const first = page.frameLocator('iframe[title="Preview card"]').first();
    await first.getByRole('button', { name: 'Discard' }).click(COLD);
    await expect(first.locator('.done-headline')).toHaveText('Discarded', COLD);
    expect(calls).toEqual([expect.objectContaining({ name: 'outlook_discard_draft_confirm' })]);
    await expect(page.getByText('Stub model: I saw').first()).toBeVisible(COLD);

    // The person asks for another email; it lands as a new turn.
    await seedEmailTurn(client, ids, ids.turnIdB, draftFor(ids, 'b'), 'Try another email.');
    await page.reload();
    await expect(page.locator('iframe[title="Preview card"]')).toHaveCount(2, COLD);
    await expect(first.locator('.done-headline')).toHaveText('Discarded', COLD);
    await expectEditable(page, 1, 'A fresh body the person typed.');
  } finally {
    await client.end();
  }
});

test('a card already on the page stays editable after another card is discarded', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '2');
  try {
    await seedChat(client, ids);
    await seedEmailTurn(client, ids, ids.turnIdA, draftFor(ids, 'a'), 'Email the vendor.');
    await seedEmailTurn(client, ids, ids.turnIdB, draftFor(ids, 'b'), 'And one more.');
    await mockGraph(page);

    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.locator('iframe[title="Preview card"]')).toHaveCount(2, COLD);
    const first = page.frameLocator('iframe[title="Preview card"]').first();
    await first.getByRole('button', { name: 'Discard' }).click(COLD);
    await expect(first.locator('.done-headline')).toHaveText('Discarded', COLD);
    await expect(page.getByText('Stub model: I saw').first()).toBeVisible(COLD);

    await expectEditable(page, 1, 'Typed after the other card was discarded.');
  } finally {
    await client.end();
  }
});

test('a reply card’s own text is editable, and an edit is sent with the message it answers', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = idsFor(testInfo.project.name, '3');
  const reply = { ...draftFor(ids, 'a'), subject: 'RE: Invoice 1042', replyTo: 'AAMkAD-msg-1042' };
  try {
    await seedChat(client, ids);
    await seedEmailTurn(client, ids, ids.turnIdA, reply, 'Reply to the vendor.');
    const calls = await mockGraph(page);

    await page.goto(`/chat/${ids.chatId}`);
    const frame = page.frameLocator('iframe[title="Preview card"]').first();
    await expect(
      frame.getByText('The quoted thread below your text is included on send.')
    ).toBeVisible(COLD);
    // Recipients and subject stay as Graph set them; the text is the person's.
    await expect(frame.locator('input')).toHaveCount(0);
    const body = frame.locator('textarea');
    await expect(body).toHaveValue(reply.body);
    await body.fill('Thanks — paid today.');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(body).toBeVisible();
    await page.screenshot({
      path: path.join(
        import.meta.dirname,
        '..',
        'test-results',
        'screens',
        testInfo.project.name,
        'email-reply-editable.png'
      ),
      fullPage: true,
    });

    await frame.getByRole('button', { name: 'Send' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Sent', COLD);
    expect(calls).toEqual([
      {
        name: 'outlook_send_draft_confirm',
        arguments: {
          draftId: reply.draftId,
          overrides: { comment: 'Thanks — paid today.' },
          replyTo: { messageId: reply.replyTo, kind: 'reply' },
        },
        stateKey: `renkei-email:${reply.draftId}`,
      },
    ]);
  } finally {
    await client.end();
  }
});
