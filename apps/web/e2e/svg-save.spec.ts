/**
 * Saving an SVG the model wrote as an image: a fenced ```svg block gets
 * "Save as PNG / SVG" under it (a non-SVG block and a truncated SVG do not
 * save), and an svg mockup carries the same on its card and in the
 * fullscreen viewer. Nothing is mocked — the browser rasterises the real
 * markup, and the download's bytes are checked.
 *
 * Read-only, so ids per Playwright project are enough (see mockups.spec.ts).
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** The first hit on a route compiles it (`next dev` builds lazily): the 5s default is not enough. */
const COLD = { timeout: 30_000 };

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee${digit}`,
    turnId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeee${digit}2`,
    modelId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeee${digit}3`,
    title: `Draw me a badge (${digit})`,
    modelLabel: `SVG save model ${digit}`,
    logoCall: `toolu_svgsave_logo_${digit}`,
  };
}
type Ids = ReturnType<typeof idsFor>;

/** `@renkei/crypto`'s content envelope, reproduced (see chat.spec.ts's note). */
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

const BADGE_SVG = `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <circle cx="60" cy="60" r="54" fill="#4f46e5"/>
  <path d="M36 62l16 16 32-34" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const LOGO_SOURCE = `<svg viewBox="0 0 200 80" width="200" height="80" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Renkei logo">
  <rect width="200" height="80" rx="12" fill="#4f46e5"/>
  <text x="100" y="50" font-family="sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">renkei</text>
</svg>`;

const REPLY = [
  'Here is a badge as SVG:',
  '```svg\n' + BADGE_SVG + '\n```',
  'A truncated one (cut off mid-stream):',
  '```svg\n<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><circle cx="5"\n```',
  'And some code that is not an image:',
  '```js\nconsole.log("hi");\n```',
].join('\n\n');

async function seedChat(client: Client, ids: Ids): Promise<void> {
  await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [ids.modelId]);
  await client.query(
    `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, base_url, encrypted_secrets, enabled, is_default)
     VALUES ($1, $2, $3, 'anthropic', 'e2e-model', $4, $5, true, false)`,
    [
      ids.modelId,
      E2E_TENANT_ID,
      ids.modelLabel,
      'http://127.0.0.1:8092/anthropic',
      sealSecret(JSON.stringify({ apiKey: 'e2e' })),
    ]
  );
  await client.query(
    `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [ids.chatId, E2E_TENANT_ID, E2E_SUBJECT, ids.title, ids.modelId]
  );
  await client.query(
    `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, finished_at)
     VALUES ($1, $2, $3, 'completed', $4, 2, NOW())`,
    [ids.turnId, E2E_TENANT_ID, ids.chatId, ids.modelId]
  );
  const rows: { seq: number; role: string; kind: string; blocks: unknown[] }[] = [
    {
      seq: 1,
      role: 'user',
      kind: 'prompt',
      blocks: [{ type: 'text', text: 'Draw me a badge, and a logo mockup.' }],
    },
    {
      seq: 2,
      role: 'assistant',
      kind: 'assistant',
      blocks: [
        { type: 'text', text: REPLY },
        {
          type: 'tool_use',
          id: ids.logoCall,
          name: 'chat_show_mockup',
          input: { title: 'Renkei logo', format: 'svg', source: LOGO_SOURCE, width: 320 },
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
          toolUseId: ids.logoCall,
          content: 'Showed “Renkei logo” inline in the chat.',
        },
      ],
    },
  ];
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    await client.query(
      `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model)
       VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10)`,
      [
        E2E_TENANT_ID,
        ids.chatId,
        ids.turnId,
        row.seq,
        row.role,
        row.kind,
        seal(JSON.stringify(row.blocks)),
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

let client: Client;
let ids: Ids;

// eslint-disable-next-line no-empty-pattern -- Playwright reads fixtures off the first parameter's destructuring; this one needs none
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  ids = idsFor(testInfo.project.name);
  await seedChat(client, ids);
});

test.afterEach(async () => {
  await client?.end();
});

async function readDownload(download: Download): Promise<Buffer> {
  const file = await download.path();
  return readFile(file);
}

/** A PNG's pixel size, from its IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('a fenced svg block saves as a PNG or an .svg file; other blocks and broken SVG do not', async ({
  page,
}, testInfo) => {
  await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
  const blocks = page.locator('.chat-code');
  await expect(blocks).toHaveCount(3, COLD);
  const [badge, broken, plain] = [blocks.nth(0), blocks.nth(1), blocks.nth(2)];

  // Only the SVG blocks offer to save; the JS block has just Copy.
  await expect(badge.getByRole('button', { name: 'Save as PNG' })).toBeVisible();
  await expect(badge.getByRole('button', { name: 'Save as SVG' })).toBeVisible();
  await expect(plain.getByRole('button', { name: /^Save as/ })).toHaveCount(0);
  await expect(plain.getByRole('button', { name: 'Copy' })).toBeVisible();
  await shot(page, testInfo, 'svg-save-code-block.png');

  // PNG: a real image, drawn at 2× the 120×120 viewBox.
  const pngDownload = page.waitForEvent('download');
  await badge.getByRole('button', { name: 'Save as PNG' }).click();
  const png = await pngDownload;
  // The button confirms for a moment: look before reading the file back.
  await expect(badge.getByRole('button', { name: 'Save as PNG' })).toContainText('Saved');
  await shot(page, testInfo, 'svg-save-code-block-saved.png');
  expect(png.suggestedFilename()).toBe('image.png');
  expect(pngSize(await readDownload(png))).toEqual({ width: 240, height: 240 });

  // SVG: the markup itself, given the size an image needs.
  const svgDownload = page.waitForEvent('download');
  await badge.getByRole('button', { name: 'Save as SVG' }).click();
  const svg = await svgDownload;
  expect(svg.suggestedFilename()).toBe('image.svg');
  const markup = (await readDownload(svg)).toString('utf8');
  expect(markup).toContain('<circle');
  expect(markup).toContain('width="120"');

  // A truncated SVG says so instead of saving something broken.
  await broken.getByRole('button', { name: 'Save as PNG' }).click();
  await expect(broken.getByRole('alert')).toContainText('not a complete, valid SVG');
  await shot(page, testInfo, 'svg-save-code-block-error.png');
});

test('an svg mockup saves from its card and from the fullscreen viewer', async ({
  page,
}, testInfo) => {
  await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
  const card = page.locator('figure', { hasText: 'Renkei logo' });
  await expect(card).toBeVisible(COLD);

  const fromCard = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Save as PNG' }).click();
  const cardPng = await fromCard;
  expect(cardPng.suggestedFilename()).toBe('renkei-logo.png');
  expect(pngSize(await readDownload(cardPng))).toEqual({ width: 400, height: 160 });
  await shot(page, testInfo, 'svg-save-mockup-card.png');

  await page.getByRole('button', { name: 'Open Renkei logo full screen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mockup: Renkei logo' });
  await expect(dialog).toBeVisible();
  await shot(page, testInfo, 'svg-save-mockup-viewer.png');
  const fromViewer = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save as SVG' }).click();
  const viewerSvg = await fromViewer;
  expect(viewerSvg.suggestedFilename()).toBe('renkei-logo.svg');
  expect((await readDownload(viewerSvg)).toString('utf8')).toContain('renkei');
});

test('the save buttons fit at phone width', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
  const card = page.locator('figure', { hasText: 'Renkei logo' });
  await expect(card).toBeVisible(COLD);
  await expect(
    page.locator('.chat-code').first().getByRole('button', { name: 'Save as PNG' })
  ).toBeVisible();
  await expect(card.getByRole('button', { name: 'Save as PNG' })).toBeVisible();
  // No horizontal page scroll from the extra buttons.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await shot(page, testInfo, 'svg-save-mobile.png');
});
