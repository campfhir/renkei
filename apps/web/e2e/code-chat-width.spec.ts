/**
 * A code project's chat sits beside the code pane (and the app menu), so at
 * desktop widths its column is far narrower than the window. Checks that the
 * chat keeps a minimum width there, that the composer's row — tools, model,
 * Auto switch, context ring, send — folds its tools into one menu and stays
 * inside the column, and that nothing scrolls sideways. A window width is a
 * resized Chromium viewport (see AGENTS.md's "UI changes").
 */

import { test, expect } from './worker-env';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
import { MODEL_ID, mockVendor, seedVoice, shot } from './voice-fixtures';
import { keyFor } from './keys';



test.use({
  permissions: ['microphone'],
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    projectId: `79797979-7979-4797-8797-7979797979${digit}1`,
    chatId: `79797979-7979-4797-8797-7979797979${digit}2`,
    projectName: `Tools menu service (${digit})`,
    chatTitle: `Which endpoint posts refunds? (${digit})`,
  };
}

test.beforeEach(async ({ browserName: _browser }, testInfo) => {
  const ids = idsFor(testInfo.project.name);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedVoice(client);
    await client.query('DELETE FROM chats WHERE project_id = $1', [ids.projectId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query(
      `INSERT INTO chat_projects\n         (id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch)\n       VALUES ($1, $2, $3, 'A code project.', 'code', 'atlassian-bitbucket', 'acme/tools-menu', 'main')`,
      [ids.projectId, E2E_SUBJECT, ids.projectName]
    );
    await client.query(
      `INSERT INTO chats (id, owner_subject, project_id, title, llm_model_id, last_message_at)\n       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [ids.chatId, E2E_SUBJECT, ids.projectId, ids.chatTitle, MODEL_ID]
    );
  } finally {
    await client.end();
  }
});



test.beforeEach(async ({ browserName: _browser }, testInfo) => {
  const ids = idsFor(testInfo.project.name);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedVoice(client);
    await client.query('DELETE FROM chats WHERE project_id = $1', [ids.projectId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query(
      `INSERT INTO chat_projects\n         (id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch)\n       VALUES ($1, $2, $3, 'A code project.', 'code', 'atlassian-bitbucket', 'acme/chat-width', 'main')`,
      [ids.projectId, E2E_SUBJECT, ids.projectName]
    );
    await client.query(
      `INSERT INTO chats (id, owner_subject, project_id, title, llm_model_id, last_message_at)\n       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [ids.chatId, E2E_SUBJECT, ids.projectId, ids.chatTitle, MODEL_ID]
    );
    // A model with a window and one measured reply, so the context ring shows.
    await client.query(
      `UPDATE llm_model_configs SET settings = '{"contextWindow":200000}'::jsonb WHERE id = $1`,
      [MODEL_ID]
    );
    const turnId = ids.chatId.replace(/.$/, '9');
    await client.query(
      `INSERT INTO chat_turns (id, chat_id, status, kind, llm_model_id, finished_at)\n       VALUES ($1, $2, 'completed', 'reply', $3, NOW())`,
      [turnId, ids.chatId, MODEL_ID]
    );
    const chatKey = await keyFor(client, {
      kind: 'chat',
      resourceId: ids.chatId,
      ownerSubject: E2E_SUBJECT,
    });
    for (const [seq, role, kind, text, usage] of [
      [1, 'user', 'prompt', 'Which endpoint posts refunds?', null],
      [2, 'assistant', 'assistant', 'POST /refunds.', { inputTokens: 60_000, outputTokens: 400 }],
    ] as const) {
      await client.query(
        `INSERT INTO chat_messages (chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, usage)\n         VALUES ($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9, $10::jsonb)`,
        [
          ids.chatId,
          turnId,
          seq,
          role,
          kind,
          chatKey.seal(JSON.stringify([{ type: 'text', text }])),
          role === 'assistant' ? MODEL_ID : null,
          role === 'assistant' ? 'anthropic' : null,
          role === 'assistant' ? 'e2e-model' : null,
          usage ? JSON.stringify(usage) : null,
        ]
      );
    }
  } finally {
    await client.end();
  }
});

for (const width of [1024, 1280, 1440, 1920]) {
  test(`desktop ${width}: the chat keeps its width and the composer row fits`, async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    await page.setViewportSize({ width, height: 800 });
    await mockVendor(page);
    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByLabel('Message')).toBeVisible();
    // The dev server's floating badge sits over the composer's left edge.
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await expect(page.getByTestId('context-meter')).toBeVisible();
    // The server-rendered page assumes a split; the real layout lands once the
    // client has measured the frame.
    await page.waitForLoadState('networkidle');

    const layout = await page.evaluate(() => {
      const send = document.querySelector('button[aria-label="Send"]');
      const row = send?.parentElement ?? null;
      const composer = row?.closest('.\\@container') ?? null;
      const rect = (element: Element) => element.getBoundingClientRect();
      return {
        composerWidth: composer ? rect(composer).width : 0,
        composerRight: composer ? rect(composer).right : 0,
        buttons: Array.from(row?.querySelectorAll('button') ?? [])
          .filter((button) => button.offsetParent !== null)
          .map((button) => ({
            label: button.getAttribute('aria-label') ?? button.textContent ?? '',
            right: rect(button).right,
          })),
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    // The chat column is at least its minimum; nothing in the row pokes out of it.
    expect(layout.composerWidth).toBeGreaterThanOrEqual(400);
    for (const button of layout.buttons) {
      expect(button.right, button.label).toBeLessThanOrEqual(layout.composerRight);
    }
    expect(layout.sideways).toBeLessThanOrEqual(0);
    // In a column this narrow the tools are the one folded menu, not three buttons.
    if (layout.composerWidth < 480) {
      await expect(page.getByRole('button', { name: 'Prompts and voice' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Insert a prompt' })).toBeHidden();
    }
    await expect(page.getByRole('button', { name: /Auto/ })).toBeVisible();
    await shot(page, testInfo, `code-chat-width-${width}`, false);
  });
}

test('the saved pane ratio cannot squeeze the chat below its minimum', async ({
  page,
}, testInfo) => {
  const ids = idsFor(testInfo.project.name);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('code-pane:ratio', '0.89'));
  await mockVendor(page);
  await page.goto(`/chat/${ids.chatId}`);
  await expect(page.getByLabel('Message')).toBeVisible();
  await page.waitForLoadState('networkidle');
  const width = await page.getByLabel('Message').evaluate((element) => {
    const column = element.closest('.min-h-0.min-w-0.flex-1');
    return column ? column.getBoundingClientRect().width : 0;
  });
  expect(width).toBeGreaterThanOrEqual(400);
});
