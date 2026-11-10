/**
 * Saving an SVG the model wrote as an image: a fenced ```svg block gets
 * "Save as PNG / SVG" under it (a truncated SVG does not save), and an
 * svg mockup carries the same on its card and in the fullscreen viewer.
 * Nothing is mocked — the reply is the scripted stand-in model's
 * (e2e/support/stub-model.ts), the mockup is the app's own
 * chat_show_mockup, the browser parses and rasterises the real markup,
 * and the download's bytes are checked.
 *
 * The rules are in node: which blocks count as SVG (and so get the
 * buttons), the size drawn, the PNG's pixels and the file's name are
 * lib/svg-image.test.ts; what the buttons say, that a running save takes
 * no second press, and what a failure leaves are
 * app/(app)/chat/_components/svg-save-buttons.model.test.ts.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Download, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel, scripted, type StubStep } from './support/stub-model';
import { createChat, send } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** The first hit on a route compiles it (`next dev` builds lazily): the 5s default is not enough. */
const COLD = { timeout: 30_000 };

const PROMPT = 'Draw me a badge, and a logo mockup.';

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

let ids: { chatId: string };
let modelId = '';

test.beforeEach(async ({ page, person: _person }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  // Each test stages a real turn first, and the documents compile on first sight.
  test.slow();
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  modelId = await addStubModel(page.request, tag);
  const steps: StubStep[] = [
    {
      text: REPLY,
      tools: [
        {
          name: 'chat_show_mockup',
          input: { title: 'Renkei logo', format: 'svg', source: LOGO_SOURCE, width: 320 },
        },
      ],
    },
    { text: 'That is the badge and the logo.' },
  ];
  const chatId = await createChat(page.request, {
    llmModelId: modelId,
    title: `Draw me a badge ${tag}`,
  });
  await send(page.request, chatId, scripted(PROMPT, steps), modelId);
  ids = { chatId };
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop-light') await removeModel(page.request, modelId);
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

test('a fenced svg block saves as a PNG or an .svg file; a broken SVG does not', async ({
  page,
}, testInfo) => {
  await page.goto(`/chat/${ids.chatId}`);
  const blocks = page.locator('.chat-code');
  await expect(blocks).toHaveCount(3, COLD);
  const [badge, broken, plain] = [blocks.nth(0), blocks.nth(1), blocks.nth(2)];

  // The SVG block offers to save; the JS block (lib/svg-image.test.ts) has just Copy.
  await expect(badge.getByRole('button', { name: 'Save as PNG' })).toBeVisible();
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
  await page.goto(`/chat/${ids.chatId}`);
  const card = page.locator('figure:visible', { hasText: 'Renkei logo' });
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
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/chat/${ids.chatId}`);
  const card = page.locator('figure:visible', { hasText: 'Renkei logo' });
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
