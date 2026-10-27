/**
 * Mockups the model shows (chat_show_mockup, lib/chat/mockup-tools.ts): a
 * reply whose tool calls carry a React component, an HTML page and an SVG
 * is drawn as three inline cards; a click opens the fullscreen viewer, where
 * the mockup is live and can be zoomed, panned and re-laid-out at a phone's
 * width; and the document behind each one is locked down (no network, no
 * cookies) because the model wrote it.
 *
 * The turn really runs: the scripted stand-in model
 * (e2e/support/stub-model.ts) calls chat_show_mockup four times, and the
 * app's own tool takes three and refuses the one that does not compile.
 * The mockup documents are real — served by the real route, compiled by
 * the real esbuild, styled by the real Tailwind runtime — nothing here is
 * mocked: no vendor is involved.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from '../support/stub-model';
import { createChat, send } from '../support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** The first hit on a route compiles it (`next dev` builds lazily): the 5s default is not enough. */
const COLD = { timeout: 30_000 };

const PROMPT = 'Show me the settings screen, a landing hero and a logo.';

const SETTINGS_SOURCE = `import { useState } from 'react';

export default function Settings() {
  const [tab, setTab] = useState('Profile');
  const tabs = ['Profile', 'Billing', 'Team'];
  return (
    <div className="min-h-[520px] bg-slate-50 p-8">
      <h1 className="text-2xl font-semibold text-slate-900">Notification settings</h1>
      <div role="tablist" className="mt-4 flex gap-2">
        {tabs.map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={
              tab === name
                ? 'rounded-full bg-indigo-600 px-4 py-1.5 text-sm text-white'
                : 'rounded-full bg-white px-4 py-1.5 text-sm text-slate-700 shadow'
            }
          >
            {name}
          </button>
        ))}
      </div>
      <section data-testid="panel" className="mt-6 rounded-xl bg-white p-6 shadow">
        <h2 className="text-lg font-medium">{tab} preferences</h2>
        <p className="mt-2 text-slate-600">Choose how you hear about {tab.toLowerCase()} activity.</p>
      </section>
    </div>
  );
}
`;

const HERO_SOURCE = `<section class="bg-gradient-to-br from-indigo-600 to-fuchsia-600 px-6 py-10 text-white">
  <h1 class="text-3xl font-bold">Ship it Friday</h1>
  <p class="mt-2 text-indigo-100">Release notes, written for you.</p>
  <a href="https://example.com/out" class="mt-6 inline-block rounded-lg bg-white px-5 py-2.5 font-semibold text-indigo-700">Get started</a>
</section>`;

const LOGO_SOURCE = `<svg viewBox="0 0 200 80" width="200" height="80" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Renkei logo">
  <rect width="200" height="80" rx="12" fill="#4f46e5"/>
  <text x="100" y="50" font-family="sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">renkei</text>
</svg>`;

interface Ids {
  chatId: string;
  title: string;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      name
    ),
    fullPage: true,
  });
}

let ids: Ids;
let modelId = '';

test.beforeEach(async ({ page, person: _person }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  modelId = await addStubModel(page.request, tag, {
    script: [
      {
        when: PROMPT,
        steps: [
          {
            text: 'Here are three mockups.',
            tools: [
              {
                name: 'chat_show_mockup',
                input: { title: 'Settings page', format: 'react', source: SETTINGS_SOURCE },
              },
              {
                name: 'chat_show_mockup',
                input: { title: 'Mobile hero', format: 'html', source: HERO_SOURCE, width: 390 },
              },
              {
                name: 'chat_show_mockup',
                input: { title: 'Logo', format: 'svg', source: LOGO_SOURCE, width: 320 },
              },
              {
                name: 'chat_show_mockup',
                input: { title: 'Broken try', format: 'react', source: 'export default () => <div>;' },
              },
            ],
          },
          { text: 'Pick the one you like.' },
        ],
      },
    ],
  });
  const title = `Design the settings screen ${tag}`;
  const chatId = await createChat(page.request, { llmModelId: modelId, title });
  await send(page.request, chatId, PROMPT, modelId);
  ids = { chatId, title };
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop-light') await removeModel(page.request, modelId);
});

function inlineFrame(page: Page, title: string) {
  return page.frameLocator(`figure iframe[title="Mockup: ${title}"]`);
}

const zoomLabel = (page: Page) => page.getByTestId('mockup-zoom');
const zoomPercent = async (page: Page) =>
  Number.parseInt((await zoomLabel(page).innerText()) ?? '0');


test('a reply’s mockups are drawn inline, each in its format, and a refused call draws none', async ({
  page,
}, testInfo) => {
  await page.goto(`/chat/${ids.chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: ids.title })).toBeVisible();

  // Three cards — the call the tool refused stays in the fold, no card for it.
  await expect(page.locator('figure')).toHaveCount(3, COLD);
  await expect(page.locator('figure', { hasText: 'Broken try' })).toHaveCount(0);

  // React + Tailwind: the component mounted and Tailwind styled it.
  const settings = inlineFrame(page, 'Settings page');
  const heading = settings.getByRole('heading', { name: 'Notification settings' });
  await expect(heading).toBeVisible(COLD);
  await expect(heading).toHaveCSS('font-size', '24px');
  await expect(heading).toHaveCSS('font-weight', '600');

  // HTML: Tailwind's gradient utilities applied.
  const hero = inlineFrame(page, 'Mobile hero');
  await expect(hero.getByRole('heading', { name: 'Ship it Friday' })).toBeVisible(COLD);
  await expect(hero.locator('section')).toHaveCSS('background-image', /linear-gradient/);

  // SVG: drawn as an image.
  await expect(inlineFrame(page, 'Logo').getByRole('img', { name: 'Renkei logo' })).toBeVisible(
    COLD
  );

  // The header says what each one is and how wide it was designed.
  await expect(page.locator('figure', { hasText: 'Settings page' })).toContainText(
    'react · 1024px'
  );
  await expect(page.locator('figure', { hasText: 'Mobile hero' })).toContainText('html · 390px');

  // A card fits its frame to the document: the 320×80 logo is far
  // shorter than the 400px a frame starts at.
  const logoHeight = await page
    .locator('figure iframe[title="Mockup: Logo"]')
    .evaluate((frame) => Number.parseInt(getComputedStyle(frame).height));
  expect(logoHeight).toBeLessThan(200);

  // The inline frame is for looking: pointer events go to the card.
  await expect(page.locator('figure iframe[title="Mockup: Settings page"]')).toHaveCSS(
    'pointer-events',
    'none'
  );
  await shot(page, testInfo, 'mockups-inline.png');
});

test('clicking a card opens it full screen, live, with zoom, widths, pan and a way back', async ({
  page,
}, testInfo) => {
  await page.goto(`/chat/${ids.chatId}`);
  const opener = page.getByRole('button', { name: 'Open Settings page full screen' });
  await expect(opener).toBeVisible(COLD);
  await opener.click();

  const dialog = page.getByRole('dialog', { name: 'Mockup: Settings page' });
  await expect(dialog).toBeVisible();
  const frame = dialog.frameLocator('iframe');

  // Live: the tabs really work — a click in the frame runs the component's own state.
  await expect(frame.getByTestId('panel')).toContainText('Profile preferences', COLD);
  await frame.getByRole('tab', { name: 'Billing' }).click();
  await expect(frame.getByTestId('panel')).toContainText('Billing preferences');
  await expect(frame.getByRole('tab', { name: 'Billing' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await shot(page, testInfo, 'mockups-viewer.png');

  // Zoom: buttons, keys, and ctrl + wheel — over the stage and over the mockup itself.
  expect(await zoomPercent(page)).toBe(100);
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  expect(await zoomPercent(page)).toBe(125);
  await dialog.getByRole('button', { name: 'Zoom out' }).click();
  await dialog.getByRole('button', { name: 'Zoom out' }).click();
  expect(await zoomPercent(page)).toBe(90);
  await page.keyboard.press('0');
  expect(await zoomPercent(page)).toBe(100);
  await page.keyboard.press('+');
  expect(await zoomPercent(page)).toBe(125);
  await dialog.getByRole('button', { name: 'Reset zoom to 100%' }).click();
  expect(await zoomPercent(page)).toBe(100);

  const box = await dialog.locator('iframe').boundingBox();
  if (!box) throw new Error('The viewer’s frame has no box.');
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(100);
  await dialog.getByRole('button', { name: 'Reset zoom to 100%' }).click();

  // A real zoom: the frame is drawn at twice the size at 200%.
  const before = (await dialog.locator('iframe').boundingBox())?.width ?? 0;
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  expect(await zoomPercent(page)).toBe(200);
  const after = (await dialog.locator('iframe').boundingBox())?.width ?? 0;
  expect(after / before).toBeCloseTo(2, 1);

  // Pan: with the hand tool on, a drag scrolls the stage.
  await dialog.getByRole('button', { name: 'Drag to pan' }).click();
  const pan = dialog.getByTestId('mockup-pan');
  await expect(pan).toBeVisible();
  const stage = pan.locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]');
  const start = await stage.evaluate((el) => el.scrollLeft);
  await page.mouse.move(400, 500);
  await page.mouse.down();
  await page.mouse.move(700, 500, { steps: 6 });
  await page.mouse.up();
  expect(await stage.evaluate((el) => el.scrollLeft)).toBeLessThan(start - 100);
  await dialog.getByRole('button', { name: 'Drag to pan' }).click();
  await expect(pan).toHaveCount(0);

  // Widths: the frame is re-laid-out at a phone's.
  await dialog.getByRole('button', { name: 'Reset zoom to 100%' }).click();
  await dialog.getByRole('button', { name: /^Phone, 390px wide$/ }).click();
  await expect(dialog.getByRole('button', { name: /^Phone, 390px wide$/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect
    .poll(async () => (await dialog.locator('iframe').boundingBox())?.width ?? 0)
    .toBeCloseTo(390, -1);
  await shot(page, testInfo, 'mockups-viewer-phone-width.png');

  // Escape closes it and focus goes back to what opened it.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('Escape and zoom keys still work while the mockup itself has focus', async ({ page }) => {
  await page.goto(`/chat/${ids.chatId}`);
  await page.getByRole('button', { name: 'Open Settings page full screen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mockup: Settings page' });
  const frame = dialog.frameLocator('iframe');
  await frame.getByRole('tab', { name: 'Team' }).click(COLD);
  // Focus is now inside the frame; the frame's own key handler forwards these.
  await page.keyboard.press('Control+=');
  await expect.poll(() => zoomPercent(page)).toBe(125);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('a mockup’s document can neither reach the network nor read cookies, and links go nowhere', async ({
  page,
}) => {
  await page.goto(`/chat/${ids.chatId}`);
  await expect(inlineFrame(page, 'Mobile hero').getByRole('heading')).toBeVisible(COLD);

  const mockupFrame = page.frames().find((frame) => frame.url().includes('/mockups/'));
  if (!mockupFrame) throw new Error('No mockup frame on the page.');
  expect(
    await mockupFrame.evaluate(() =>
      fetch(location.href).then(
        () => 'reached',
        () => 'blocked'
      )
    )
  ).toBe('blocked');
  expect(
    await mockupFrame.evaluate(() => {
      try {
        return document.cookie === undefined ? 'blocked' : 'readable';
      } catch {
        return 'blocked';
      }
    })
  ).toBe('blocked');

  // A link in a mockup does not navigate the frame away from the design.
  const hero = inlineFrame(page, 'Mobile hero');
  await hero.getByRole('link', { name: 'Get started' }).dispatchEvent('click');
  await expect(hero.getByRole('heading', { name: 'Ship it Friday' })).toBeVisible();

  // The route says the same in its headers, so the URL opened on its own is just as locked.
  const url = mockupFrame.url();
  const response = await page.request.get(url);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-security-policy']).toMatch(/sandbox allow-scripts$/);
  expect(response.headers()['content-security-policy']).toContain("connect-src 'none'");
  expect(await response.text()).toMatch(/^<!doctype html>/i);

  // And it only answers for a mockup call that exists in this chat.
  const missing = await page.request.get(url.replace(/mockups\/[^/?]+/, 'mockups/toolu_nothing'));
  expect(missing.status()).toBe(404);
});

test('at a phone’s width the cards fit the screen and the viewer stays reachable', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/chat/${ids.chatId}`);
  await expect(page.locator('figure')).toHaveCount(3, COLD);

  // Frames load lazily, as they scroll near: bring each into view and wait for its design.
  for (const figure of await page.locator('figure').all()) await figure.scrollIntoViewIfNeeded();
  await inlineFrame(page, 'Settings page')
    .getByRole('heading', { name: 'Notification settings' })
    .waitFor(COLD);
  await inlineFrame(page, 'Mobile hero').getByRole('heading', { name: 'Ship it Friday' }).waitFor();
  await inlineFrame(page, 'Logo').getByRole('img', { name: 'Renkei logo' }).waitFor();
  await page.locator('figure').first().scrollIntoViewIfNeeded();

  for (const figure of await page.locator('figure').all()) {
    const box = await figure.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  // The desktop-width design is scaled down to fit, not cropped or scrolled sideways.
  const settingsFrame = await page
    .locator('figure iframe[title="Mockup: Settings page"]')
    .boundingBox();
  expect(settingsFrame?.width ?? 0).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'mockups-inline-mobile.png');

  await page.getByRole('button', { name: 'Open Settings page full screen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mockup: Settings page' });
  await expect(dialog).toBeVisible();
  // Every control is on screen even with the toolbar wrapped.
  for (const name of ['Close', 'Zoom in', 'Zoom out', 'Fit to width', 'Copy the code']) {
    const box = await dialog.getByRole('button', { name }).boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    expect((box?.y ?? -1) + (box?.height ?? 0)).toBeLessThanOrEqual(MOBILE_VIEWPORT.height);
  }
  // Opens fitted: a 1024px design at 390px wide is scaled to its width, and drawn whole.
  expect(await zoomPercent(page)).toBeLessThan(40);
  await expect(
    dialog.frameLocator('iframe').getByRole('heading', { name: 'Notification settings' })
  ).toBeVisible(COLD);
  await expect(dialog.frameLocator('iframe').getByTestId('panel')).toBeVisible();
  // Its height followed the design (520px on 1024, measured on screen so the
  // scale cancels) — not the 80px floor, and not the 600px it starts at.
  await expect
    .poll(async () => {
      const frame = await dialog.locator('iframe').boundingBox();
      return frame ? Math.round((frame.height / frame.width) * 100) : 0;
    })
    .toBe(51);
  await shot(page, testInfo, 'mockups-viewer-mobile.png');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});
