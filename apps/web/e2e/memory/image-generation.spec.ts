/**
 * Image generation, end to end in a browser. The pictures are really
 * drawn: the scripted stand-in chat model (e2e/support/stub-model.ts)
 * calls chat_generate_image, the app's own tool asks the stand-in image
 * model (llm-stub.mjs's Images endpoint) and keeps what it answers in the
 * blob store, and the thread shows it:
 *
 *   - a picture the model drew is shown INLINE in the call that drew it,
 *     outside the tool-call fold, with its own icon, and a call the image
 *     model's safety system refused shows its reason instead;
 *   - a call still waiting is an outline in the SHAPE the model asked for
 *     (the aspect ratio of `size`, or of `aspectRatio`), at a phone's width
 *     too;
 *   - a .gif call is worded as an animation, waiting and done, and the GIF
 *     it made (written by the tool's own encoder) plays inline;
 *   - Preferences offers the org's image models and saves the person's pick,
 *     and leaves the section out when the org has none;
 *   - My usage and Organization usage count the pictures: how many, how much
 *     space, the tokens billed, and who has the most.
 *
 * The person's message steers the stand-in image model (llm-stub.mjs):
 * `[refuse 1024x1024]` refuses a square, `[slow]` holds a picture back so
 * the call can be seen waiting.
 *
 * The image models are the organization's roster, and the empty Preferences
 * section needs the org to genuinely have none: the spec runs serially, on
 * one project, and removes every model it adds. The organization's usage
 * totals hold every picture this server has drawn, so they are asserted as
 * at least this spec's own.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel, type StubReply } from '../support/stub-model';
import { createChat, readChat, send, settled, startTurn } from '../support/chat';
import { createPerson, type Person } from '../support/person';
import { MEMORY_BASE_URL } from './constants';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** The first hit on a route compiles it (`next dev` builds lazily). */
const COLD = { timeout: 30_000 };

// The roster and the image tool are an operator's to stage.
test.use({ roles: ['renkei-user', 'renkei-operator'] });
test.describe.configure({ mode: 'serial' });

const PROMPT = 'generate a picture of a cute polarbear [refuse 1024x1024]';
const GIF_PROMPT = 'make a gif of a red ball rolling across the sky';

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

/** Models this test added, removed after it. */
let added: string[] = [];
let tag = '';

test.beforeEach(async ({ page, person: _person }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'One project: the image roster is the org’s.'
  );
  // Each test has the model draw for real, and the pages compile on first sight.
  test.slow();
  added = [];
  tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  // The roster's image models are this spec's alone: one a run cut short
  // left behind is taken off first, through the same route.
  const roster = await page.request.get('/api/admin/llm-models');
  const { models: listed }: { models: { id: string; label: string }[] } = await roster.json();
  for (const left of listed.filter((entry) => ['Painter', 'Fox'].includes(entry.label))) {
    await removeModel(page.request, left.id);
  }
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.project.name !== 'desktop-light') return;
  for (const id of added) await removeModel(page.request, id);
});

async function model(
  request: APIRequestContext,
  options: Parameters<typeof addStubModel>[2]
): Promise<string> {
  const id = await addStubModel(request, tag, options);
  added.push(id);
  return id;
}

/** The chat model, and the one image model a chat's tool draws with. */
async function models(request: APIRequestContext, script: StubReply[]): Promise<string> {
  await model(request, { label: 'Painter', image: { apiSurface: 'images', model: 'gpt-image-1' } });
  return model(request, { label: `Chatty ${tag}`, script });
}

const draw = (input: Record<string, unknown>) => ({ name: 'chat_generate_image', input });

/** A finished chat: one picture drawn, one call the image model refused. */
async function doneChat(request: APIRequestContext): Promise<string> {
  const chatModel = await models(request, [
    {
      when: PROMPT,
      steps: [
        {
          text: 'Here is your polar bear.',
          tools: [
            draw({ filename: 'cute_polar_bear.png', size: '1536x1024', quality: 'high' }),
            draw({ filename: 'second.png', aspectRatio: '1:1' }),
          ],
        },
        { text: 'The second one could not be drawn.' },
      ],
    },
  ]);
  const chatId = await createChat(request, { llmModelId: chatModel, title: 'Polar bear' });
  // Drawing acts, so the turn asks first: allowed once, as the card would.
  await send(request, chatId, PROMPT, chatModel, { allow: true });
  return chatId;
}

/** The kept picture's id, from the chat's artifacts. */
async function pictureOf(request: APIRequestContext, chatId: string, name: string) {
  const artifact = (await readChat(request, chatId)).chat.artifacts.find(
    (file) => file.filename === name
  );
  if (!artifact) throw new Error(`No ${name} in the chat.`);
  const bytes = await (await request.get(`/api/chat/attachments/${artifact.id}`)).body();
  return { id: artifact.id, size: bytes.length };
}

test('a picture the model drew is shown inline in its call, with its own icon, and a refused call says why', async ({
  page,
}, testInfo) => {
  const chatId = await doneChat(page.request);

  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Polar bear' })).toBeVisible();

  const cards = page.getByTestId('image-card').filter({ visible: true });
  await expect(cards).toHaveCount(2, COLD);
  const drawn = cards.nth(0);
  await expect(drawn).toHaveAttribute('data-state', 'done');
  await expect(drawn).toContainText('Generated image');
  await expect(drawn).toContainText(/\d+(\.\d)?s|\d+ms/);

  // The picture itself, loaded — the file this call kept, not the other's.
  const picture = drawn.getByRole('img', { name: 'cute_polar_bear.png' });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1536);
  await expect(drawn.getByTestId('image-card-picture')).toBeVisible();
  // Right under the picture, the same line as every file a reply made: name, size, Download.
  const caption = drawn.getByTestId('file-caption');
  await expect(caption).toContainText('cute_polar_bear.png', COLD);
  await expect(caption).toContainText(/\d+(\.\d)? KB/);
  const pictureBox = await drawn.getByTestId('image-card-picture').boundingBox();
  const captionBox = await caption.boundingBox();
  expect(captionBox?.y ?? 0).toBeGreaterThanOrEqual(
    (pictureBox?.y ?? 0) + (pictureBox?.height ?? 0) - 1
  );
  const fromCaption = page.waitForEvent('download');
  await caption.getByRole('link', { name: 'Download cute_polar_bear.png' }).click();
  expect((await fromCaption).suggestedFilename()).toBe('cute_polar_bear.png');
  // Clicking it opens a preview window with the picture and a Download button.
  await drawn.getByRole('button', { name: 'Preview image' }).click();
  const preview = page.getByTestId('image-preview');
  await expect(preview).toBeVisible();
  const big = preview.getByTestId('image-preview-picture');
  await expect.poll(() => big.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1536);
  // A large picture is fitted to the window, not spilled past it.
  const fitted = await big.boundingBox();
  const viewport = page.viewportSize();
  if (!fitted || !viewport) throw new Error('The preview is not on screen.');
  expect(fitted.width).toBeLessThanOrEqual(viewport.width);
  expect(fitted.y + fitted.height).toBeLessThanOrEqual(viewport.height);
  const download = preview.getByTestId('image-preview-download');
  await expect(download).toHaveAttribute('download', 'cute_polar_bear.png');
  await expect(download).toHaveAttribute('href', /\/chat\/attachments\/[0-9a-f-]{36}$/);
  const saved = page.waitForEvent('download');
  await download.click();
  expect((await saved).suggestedFilename()).toBe('cute_polar_bear.png');
  await shot(page, testInfo, 'image-preview.png');
  // Escape closes it and puts focus back on the picture's button.
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  // Inline, not folded away with the other tool calls; and the image glyph, not the wrench.
  await expect(drawn.locator('xpath=ancestor::details')).toHaveCount(0);
  await expect(drawn.locator('figcaption svg path').first()).toHaveAttribute('d', /^M4 5h16v14H4z/);

  // The call the image model refused: the reason, no picture.
  const refused = cards.nth(1);
  await expect(refused).toHaveAttribute('data-state', 'failed');
  await expect(refused).toContainText('Image could not be generated');
  await expect(refused.getByTestId('image-card-error')).toContainText('safety system refused');
  await expect(refused.getByRole('img')).toHaveCount(0);
  await shot(page, testInfo, 'image-card-done.png');

  // Phone width: the picture stays inside the thread.
  await page.setViewportSize(MOBILE_VIEWPORT);
  const box = await picture.boundingBox();
  expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'image-card-done-mobile.png');

  // The preview window at phone width: picture and both buttons inside the screen, no sideways scroll.
  await drawn.getByRole('button', { name: 'Preview image' }).click();
  const phonePreview = page.getByTestId('image-preview');
  await expect(phonePreview).toBeVisible();
  for (const target of [
    phonePreview.getByTestId('image-preview-picture'),
    phonePreview.getByTestId('image-preview-download'),
    phonePreview.getByRole('button', { name: 'Close' }),
  ]) {
    const at = await target.boundingBox();
    if (!at) throw new Error('A preview control is not on screen.');
    expect(at.x).toBeGreaterThanOrEqual(0);
    expect(at.x + at.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    expect(at.y + at.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await shot(page, testInfo, 'image-preview-mobile.png');
  await phonePreview.getByRole('button', { name: 'Close' }).click();
  await expect(phonePreview).toHaveCount(0);
});

test('installed to the iOS home screen, Download opens the file over the app instead of trapping it', async ({
  page,
}, testInfo) => {
  const chatId = await doneChat(page.request);
  // iOS WebKit's marker for a home-screen (standalone) launch; nothing else sets it.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  });
  await page.setViewportSize(MOBILE_VIEWPORT);

  const chatUrl = `/chat/${chatId}`;
  await page.goto(chatUrl);
  const drawn = page.getByTestId('image-card').filter({ visible: true }).nth(0);
  await expect(drawn).toHaveAttribute('data-state', 'done', COLD);
  await drawn.getByRole('button', { name: 'Preview image' }).click();
  const preview = page.getByTestId('image-preview');
  await expect(preview).toBeVisible();

  // The file goes to a window of its own (iOS's closable in-app browser sheet),
  // not an in-place navigation of the app's only webview.
  const opened = page.context().waitForEvent('page');
  await preview.getByTestId('image-preview-download').click();
  const sheet = await opened;
  await expect.poll(() => sheet.url()).toMatch(/\/chat\/attachments\/[0-9a-f-]{36}$/);
  await sheet.close();

  // The app underneath never left the chat, and its preview still closes.
  expect(new URL(page.url()).pathname).toBe(chatUrl);
  await expect(preview).toBeVisible();
  await shot(page, testInfo, 'image-preview-ios-standalone.png');
  await preview.getByRole('button', { name: 'Close' }).click();
  await expect(preview).toHaveCount(0);
});

test('installed to the iOS home screen with file sharing, Download opens the share sheet with the picture', async ({
  page,
}, testInfo) => {
  const chatId = await doneChat(page.request);
  const picture = await pictureOf(page.request, chatId, 'cute_polar_bear.png');
  const fetchedAhead = page
    .waitForResponse(
      (response) =>
        response.url().endsWith(`/api/chat/attachments/${picture.id}`) &&
        response.request().resourceType() === 'fetch'
    )
    .then((response) => response.body());
  // iOS standalone plus a stand-in share sheet that records what it was handed.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    const shared: { name: string; type: string; size: number }[] = [];
    Reflect.set(window, '__shared', shared);
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: (data: ShareData) => Boolean(data.files?.length),
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        for (const file of data.files ?? []) {
          shared.push({ name: file.name, type: file.type, size: file.size });
        }
      },
    });
  });
  await page.setViewportSize(MOBILE_VIEWPORT);

  const chatUrl = `/chat/${chatId}`;
  await page.goto(chatUrl);
  const drawn = page.getByTestId('image-card').filter({ visible: true }).nth(0);
  await expect(drawn).toHaveAttribute('data-state', 'done', COLD);
  await drawn.getByRole('button', { name: 'Preview image' }).click();
  const preview = page.getByTestId('image-preview');
  await expect(preview).toBeVisible();

  // The picture was fetched when the preview opened, so the tap goes straight
  // to the share sheet: no new window, no navigation.
  let opened = 0;
  page.context().on('page', () => opened++);
  await fetchedAhead;
  await preview.getByTestId('image-preview-download').click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__shared').length)).toBe(1);
  const shared = await page.evaluate(() => Reflect.get(window, '__shared'));
  expect(shared[0]).toEqual({ name: 'cute_polar_bear.png', type: 'image/png', size: picture.size });
  expect(opened).toBe(0);
  expect(new URL(page.url()).pathname).toBe(chatUrl);
  await expect(preview).toBeVisible();
  await shot(page, testInfo, 'image-preview-ios-share.png');
});

/**
 * A chat whose one image call is waiting: parked on the permission ask
 * (`parked`), or allowed and being drawn — slowly, `[slow]` in the prompt.
 */
async function waitingChat(
  request: APIRequestContext,
  chatModel: string,
  input: Record<string, unknown>,
  { parked }: { parked: boolean }
): Promise<{ chatId: string; turnId: string }> {
  const chatId = await createChat(request, {
    llmModelId: chatModel,
    title: 'Waiting for a picture',
  });
  const turnId = await startTurn(
    request,
    chatId,
    `generate a picture of a cute polarbear [slow] ${JSON.stringify(input)}`,
    chatModel
  );
  let toolUseId = '';
  await expect
    .poll(
      async () => {
        const ask = (await readChat(request, chatId)).chat.activeTurn?.pendingPermission;
        toolUseId = ask?.toolUseId ?? '';
        return ask?.name ?? null;
      },
      { timeout: 30_000 }
    )
    .toBe('chat_generate_image');
  if (!parked) {
    const decided = await request.post(`/api/chat/chats/${chatId}/turns/${turnId}/permission`, {
      data: { toolUseId, decision: 'once' },
    });
    expect(decided.ok(), await decided.text()).toBe(true);
  }
  return { chatId, turnId };
}

/** Stop a waiting chat's turn, so its slow picture is never drawn. */
async function stop(request: APIRequestContext, waiting: { chatId: string; turnId: string }) {
  // Tidying only: a dropped keep-alive connection here proves nothing either way.
  await request
    .post(`/api/chat/chats/${waiting.chatId}/turns/${waiting.turnId}/cancel`)
    .catch(() => undefined);
}

/** The chat model for the waiting cases: each variant's input rides in its prompt. */
function waitingScript(inputs: Record<string, unknown>[]): StubReply[] {
  return inputs.map((input) => ({
    when: JSON.stringify(input),
    steps: [{ text: 'Drawing it now.', tools: [draw(input)] }, { text: 'There it is.' }],
  }));
}

test('a call waiting on permission shows no outline; once approved it is an outline in the shape asked for', async ({
  page,
}, testInfo) => {
  test.slow();
  const portrait = { filename: 'bear.png', size: '1024x1536' };
  const wide = { filename: 'bear.png', aspectRatio: '16:9' };
  const square = { filename: 'bear.png' };
  const landscape = { filename: 'bear.png', size: '1536x1024' };
  const chatModel = await models(page.request, waitingScript([portrait, wide, square, landscape]));
  const card = page.getByTestId('image-card').filter({ visible: true });

  // Parked on the permission ask: nothing is being drawn, so no outline — only the caption.
  const parked = await waitingChat(page.request, chatModel, portrait, { parked: true });
  await page.goto(`/chat/${parked.chatId}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Waiting for a picture' })
  ).toBeVisible();
  await expect(card).toBeVisible(COLD);
  await expect(card).toHaveAttribute('data-state', 'waiting');
  await expect(card).toContainText('Waiting for permission to generate an image');
  await expect(card.getByTestId('image-card-skeleton')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Permission needed' })).toBeVisible();
  await shot(page, testInfo, 'image-card-waiting-no-outline.png');
  await stop(page.request, parked);

  // Approved and being drawn: portrait pixels, so width over height is 2/3.
  const drawing = await waitingChat(page.request, chatModel, portrait, { parked: false });
  await page.goto(`/chat/${drawing.chatId}`);
  await expect(card).toHaveAttribute('data-state', 'pending', COLD);
  await expect(card).toContainText('Generating image');
  const skeleton = card.getByTestId('image-card-skeleton');
  await expect(skeleton).toBeVisible();
  await expect(card).toHaveAttribute('data-ratio', '0.667');
  const tall = await skeleton.boundingBox();
  expect((tall?.width ?? 0) / (tall?.height ?? 1)).toBeCloseTo(2 / 3, 1);
  await shot(page, testInfo, 'image-card-generating-portrait.png');
  await stop(page.request, drawing);

  // A ratio instead of pixels: 16:9 landscape.
  const ratio = await waitingChat(page.request, chatModel, wide, { parked: false });
  await page.goto(`/chat/${ratio.chatId}`);
  await expect(card).toHaveAttribute('data-ratio', /^1\.7/, COLD);
  const widescreen = await card.getByTestId('image-card-skeleton').boundingBox();
  expect((widescreen?.width ?? 0) / (widescreen?.height ?? 1)).toBeCloseTo(16 / 9, 1);
  await stop(page.request, ratio);

  // Nothing asked: a square.
  const plain = await waitingChat(page.request, chatModel, square, { parked: false });
  await page.goto(`/chat/${plain.chatId}`);
  await expect(card).toHaveAttribute('data-ratio', '1.000', COLD);
  await stop(page.request, plain);

  // Phone width: the outline keeps its shape and fits the screen.
  const phone = await waitingChat(page.request, chatModel, landscape, { parked: false });
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/chat/${phone.chatId}`);
  await expect(card).toHaveAttribute('data-state', 'pending', COLD);
  const narrow = await card.getByTestId('image-card-skeleton').boundingBox();
  expect(narrow?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  expect((narrow?.width ?? 0) / (narrow?.height ?? 1)).toBeCloseTo(1.5, 1);
  await shot(page, testInfo, 'image-card-generating-mobile.png');
  await stop(page.request, phone);
});

test('an animated GIF is worded as an animation while it is made, and plays inline once it is', async ({
  page,
}, testInfo) => {
  test.slow();
  const slowGif = { filename: 'ball.gif', aspectRatio: '16:9' };
  const chatModel = await models(page.request, [
    ...waitingScript([slowGif]),
    {
      when: GIF_PROMPT,
      steps: [
        {
          text: 'Here is your animation.',
          tools: [draw({ filename: 'ball.gif', aspectRatio: '16:9', frames: 4 })],
        },
        { text: 'It loops.' },
      ],
    },
  ]);

  // Being made: an animation, in the 16:9 shape asked for.
  const waiting = await waitingChat(page.request, chatModel, slowGif, { parked: false });
  await page.goto(`/chat/${waiting.chatId}`);
  const pending = page.getByTestId('image-card').filter({ visible: true });
  await expect(pending).toHaveAttribute('data-state', 'pending', COLD);
  await expect(pending).toHaveAttribute('data-kind', 'animation');
  await expect(pending).toContainText('Generating animation');
  await expect(pending).toHaveAttribute('data-ratio', /^1\.7/);
  await shot(page, testInfo, 'image-card-generating-animation.png');
  await stop(page.request, waiting);

  // Made: four frames, each its own picture, encoded into a looping GIF.
  const chatId = await createChat(page.request, { llmModelId: chatModel, title: 'Bouncing ball' });
  await send(page.request, chatId, GIF_PROMPT, chatModel, { allow: true });
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Bouncing ball' })).toBeVisible(COLD);
  const card = page.getByTestId('image-card').filter({ visible: true });
  await expect(card).toHaveAttribute('data-state', 'done', COLD);
  await expect(card).toHaveAttribute('data-kind', 'animation');
  await expect(card).toContainText('Generated animation');
  const picture = card.getByRole('img', { name: 'ball.gif' });
  await expect(picture).toBeVisible();
  // 16:9, as asked.
  const [width, height] = await picture.evaluate((img: HTMLImageElement) => [
    img.naturalWidth,
    img.naturalHeight,
  ]);
  expect(width / height).toBeCloseTo(16 / 9, 1);
  await expect(card.getByTestId('file-caption')).toContainText('ball.gif');

  // It plays: what is on screen changes from one moment to the next. (A canvas
  // cannot tell — drawImage always paints an animated image's first frame.)
  const before = await picture.screenshot();
  await expect
    .poll(async () => (await picture.screenshot()).equals(before), { timeout: 5_000 })
    .toBe(false);
  await shot(page, testInfo, 'image-card-animation.png');

  // The preview window shows the animation too.
  await card.getByRole('button', { name: 'Preview image' }).click();
  const preview = page.getByTestId('image-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId('image-preview-download')).toHaveAttribute(
    'download',
    'ball.gif'
  );
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  // Phone width: the animation stays inside the thread.
  await page.setViewportSize(MOBILE_VIEWPORT);
  const box = await picture.boundingBox();
  expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await shot(page, testInfo, 'image-card-animation-mobile.png');
});

test('Preferences offers the org’s image models, saves the person’s pick, and is silent with none', async ({
  page,
}, testInfo) => {
  // No image model in the org: the section is not there.
  await model(page.request, { label: `Chatty ${tag}` });
  await page.goto(`/preferences`);
  await expect(page.getByRole('heading', { name: 'Preferences', level: 1 })).toBeVisible(COLD);
  await expect(page.getByRole('heading', { name: 'Image generation' })).toHaveCount(0);

  // Two image models: the picker, defaulting to the org's first by name.
  const painterId = await model(page.request, {
    label: 'Painter',
    image: { apiSurface: 'images', model: 'gpt-image-1' },
  });
  await model(page.request, { label: 'Fox', image: { apiSurface: 'flux', model: 'FLUX.2-flex' } });
  await page.reload();
  const select = page.getByLabel('Preferred image model');
  await expect(select).toBeVisible(COLD);
  await expect(select).toHaveValue('');
  await expect(select.locator('option').first()).toHaveText('Organization default (Fox)');
  await expect(select.locator('option')).toHaveText([
    'Organization default (Fox)',
    'Fox · FLUX.2-flex',
    'Painter · gpt-image-1',
  ]);
  const section = page.locator('section', { has: select });
  await expect(section.getByRole('button', { name: 'Save' })).toBeDisabled();

  await select.selectOption({ label: 'Painter · gpt-image-1' });
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible(COLD);
  await shot(page, testInfo, 'preferences-image-model.png');

  // Saved: it survives a reload, and the stored preference is the model's id.
  await page.reload();
  await expect(page.getByLabel('Preferred image model')).toHaveValue(painterId);
  const stored = await page.request.get('/api/preferences');
  expect((await stored.json()).image).toEqual({ modelId: painterId });

  // Back to the organization default clears it.
  await page.getByLabel('Preferred image model').selectOption('');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible(COLD);

  // Phone width.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.reload();
  await expect(page.getByLabel('Preferred image model')).toBeVisible();
  await shot(page, testInfo, 'preferences-image-model-mobile.png');
});

const TWO = 'two pictures, please';
const ONE = 'one picture, please';

/**
 * The person draws two pictures; somebody else draws one. Each picture is
 * billed 61 tokens in and 4,160 out (llm-stub.mjs's Images usage).
 */
async function usage(request: APIRequestContext, outside: APIRequestContext): Promise<Person> {
  const chatModel = await models(request, [
    {
      when: TWO,
      steps: [
        { tools: [draw({ filename: 'one.png' }), draw({ filename: 'two.png' })] },
        { text: 'Both drawn.' },
      ],
    },
    { when: ONE, steps: [{ tools: [draw({ filename: 'three.png' })] }, { text: 'Drawn.' }] },
  ]);
  const mine = await createChat(request, { llmModelId: chatModel, title: 'Two pictures' });
  await send(request, mine, TWO, chatModel, { allow: true });
  const other = await createPerson(outside, { displayName: `Another Person ${tag}` });
  const theirs = await outside.post(`${MEMORY_BASE_URL}/api/chat/chats`, {
    headers: other.headers,
    data: { llmModelId: chatModel },
  });
  expect(theirs.status(), await theirs.text()).toBe(201);
  const { chatId } = await theirs.json();
  const asked = await outside.post(`${MEMORY_BASE_URL}/api/chat/chats/${chatId}/turns`, {
    headers: other.headers,
    data: { text: ONE, llmModelId: chatModel },
  });
  expect(asked.status(), await asked.text()).toBe(202);
  // Their ask is theirs to answer: allowed once, from their side.
  await expect
    .poll(
      async () => {
        const view = await outside.get(`${MEMORY_BASE_URL}/api/chat/chats/${chatId}`, {
          headers: other.headers,
        });
        const turn = (await view.json()).chat.activeTurn;
        if (turn?.pendingPermission) {
          await outside.post(
            `${MEMORY_BASE_URL}/api/chat/chats/${chatId}/turns/${turn.id}/permission`,
            {
              headers: other.headers,
              data: { toolUseId: turn.pendingPermission.toolUseId, decision: 'once' },
            }
          );
        }
        return turn === null;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  await settled(request, mine);
  return other;
}

test('My usage and Organization usage count the pictures in KB/MB/GB with their tokens', async ({
  page,
  person,
  request,
}, testInfo) => {
  await usage(page.request, request);

  // Mine: two pictures, 122 tokens in and 8.3k out.
  await page.goto(`/utilization`);
  const mine = page.getByRole('main').getByTestId('image-usage-card');
  await expect(mine).toBeVisible(COLD);
  await expect(mine.getByTestId('image-usage-count')).toHaveText('2');
  await expect(mine.getByTestId('image-usage-bytes')).toHaveText(/^[\d.]+ (KB|MB)$/);
  await expect(mine.getByTestId('image-usage-tokens')).toContainText('122 tokens in');
  await expect(mine.getByTestId('image-usage-tokens')).toContainText('8.3k tokens out');
  // And the same tokens are a surface of their own in "Tokens by surface".
  const mySurfaces = page.locator('section', {
    has: page.getByRole('heading', { name: 'Tokens by surface' }),
  });
  const myImages = mySurfaces.getByRole('listitem').filter({ hasText: 'Images' });
  await expect(myImages).toContainText('8.4k');
  await expect(myImages).toContainText('(122 in · 8.3k out)');
  await shot(page, testInfo, 'usage-images-mine.png');

  // The organization: every picture this server drew, ours among them, and who has the most.
  await page.goto(`/admin/usage`);
  const org = page.getByRole('main').getByTestId('image-usage-card');
  await expect(org).toBeVisible(COLD);
  expect(Number(await org.getByTestId('image-usage-count').innerText())).toBeGreaterThanOrEqual(3);
  await expect(org.getByTestId('image-usage-bytes')).toHaveText(/^[\d.]+ (KB|MB|GB)$/);
  // The tokens image models billed are a surface beside chat and agents, and part of the headline total.
  const surfaces = page.locator('section', {
    has: page.getByRole('heading', { name: 'Tokens by surface' }),
  });
  const surfaceImages = surfaces.getByRole('listitem').filter({ hasText: 'Images' });
  await expect(surfaceImages).toHaveText(/^Images\s*[\d.]+k/);
  await expect(surfaceImages).toContainText(/\([\d.,k]+ in · [\d.,k]+ out\)/);
  const board = page.locator('section', {
    has: page.getByRole('heading', { name: 'Top image creators' }),
  });
  await expect(board).toBeVisible();
  const myRow = board.locator('li', { hasText: person.displayName });
  // (The fixture names every person alike: one of those rows is this one, with its two.)
  await expect(myRow.filter({ hasText: /[\d.]+ (KB|MB) · 2 images/ }).first()).toBeVisible();
  // Every person this server has seen draw is on the board, most first: more than one of them.
  // (Somebody else's one picture can fall below the cut once earlier runs have drawn more.)
  expect(await board.locator('li').count()).toBeGreaterThan(1);
  await shot(page, testInfo, 'usage-images-org.png');

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.reload();
  await expect(page.getByRole('main').getByTestId('image-usage-card')).toBeVisible();
  await shot(page, testInfo, 'usage-images-org-mobile.png');
});

test('the Tokens chart shows images by colour beside chat and agents, hour by hour and day by day', async ({
  page,
  request,
}, testInfo) => {
  await usage(page.request, request);
  const main = page.getByRole('main');
  // The chart's bars carry a tooltip; the ones with any tokens are the filled ones.
  const imageBars = main.locator('[role="img"] [title*="Images"]');
  const imageTitle = /Images [\d,]+ \(\d+ images?, [\d.]+ (KB|MB|GB)\)/;

  await page.goto(`/admin/usage`);
  await expect(main.getByTestId('image-usage-card')).toBeVisible(COLD);

  // There is no switch for images: the chart's own switch is Tokens, Agent runs, Tool calls.
  await expect(main.getByRole('button', { name: 'Images', exact: true })).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Tokens', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  // The legend names images with the other surfaces, in pink, distinct from the Agents purple.
  const legend = main.locator('figure').getByText('Images', { exact: true });
  await expect(legend).toBeVisible();
  await expect(legend.locator('span').first()).toHaveClass(/bg-pink-500/);

  // 30 days, by day: today's bar holds the image tokens, with how many pictures and how big.
  await expect(imageBars).toHaveCount(1);
  await expect(imageBars).toHaveAttribute('title', imageTitle);
  await expect(imageBars.locator('div.bg-pink-500')).toHaveCount(1);
  await shot(page, testInfo, 'usage-tokens-chart-images-daily.png');

  // Today, by hour: the same pink segment in the current hour's bar.
  await main.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(imageBars.first()).toHaveAttribute('title', imageTitle);
  await expect(main.locator('figure').getByText('Today, by hour')).toBeVisible();
  await shot(page, testInfo, 'usage-tokens-chart-images-hourly.png');

  // The other series are untouched by images.
  await main.getByRole('button', { name: 'Agent runs', exact: true }).click();
  await expect(main.locator('[title*="Images"]')).toHaveCount(0);

  // My usage keeps its own input/output chart, with no Images switch.
  await page.goto(`/utilization`);
  await expect(main.getByTestId('image-usage-card')).toBeVisible(COLD);
  await expect(main.getByRole('button', { name: 'Images', exact: true })).toHaveCount(0);

  // Phone width.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/admin/usage`);
  await expect(main.getByTestId('image-usage-card')).toBeVisible(COLD);
  await expect(imageBars).toHaveCount(1);
  await shot(page, testInfo, 'usage-tokens-chart-images-mobile.png');
});
