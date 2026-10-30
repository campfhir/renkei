/**
 * A sidebar chat row's "⋯" menu opens above its row when there is no room
 * below it. The sidebar is pinned to the bottom of the window, so a menu
 * that opened downward past that edge only grew the sidebar's scroll area
 * instead of showing. The window is made just tall enough for the row's
 * button, so the menu has to flip.
 *
 * The chats are the person's own, each asked one question through the
 * chat routes (the sidebar lists only chats with a message in them),
 * answered by the stand-in model.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from './support/stub-model';
import { createChat, send } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

// Enough rows that the column scrolls, so one can be brought into view at its end.
const ROWS = 14;

test('a row menu opens above its row when there is no room below', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'The pinned sidebar column is a desktop layout; one project is enough.'
  );
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const prefix = `Menu flip e2e ${tag}`;
  const titles = Array.from(
    { length: ROWS },
    (_, index) => `${prefix} ${String(index + 1).padStart(2, '0')}`
  );
  // The first asked: the oldest, at the bottom of the list.
  const target = titles[0];
  const modelId = await addStubModel(page.request, tag);
  try {
    for (const title of titles) {
      const chatId = await createChat(page.request, { llmModelId: modelId, title });
      await send(page.request, chatId, 'Hello.', modelId);
    }

    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto('/chat');
    // /chat streams its loading shell and then redirects to the newest chat
    // in the browser, after goto has returned: touching the page before that
    // lands has it destroyed under the call.
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    const list = page.getByRole('navigation', { name: 'Chats' });
    const row = list.getByRole('link', { name: new RegExp(`^${target}`) });
    await expect(row).toBeAttached();
    await row.evaluate((element) => element.scrollIntoView({ block: 'end' }));

    const actions = row.locator('..').getByRole('button', { name: 'Chat actions' });
    await row.hover();
    // Shrink the window to a few pixels below the row's button: the menu
    // needs far more room than that, so it has to open above the row.
    const button = await actions.boundingBox();
    if (!button) throw new Error('The row has no actions button on screen.');
    await page.setViewportSize({
      width: 1280,
      height: Math.ceil(button.y + button.height) + 40,
    });

    // The click can land before the page has hydrated and attached its
    // handlers, so it is retried until the menu is open.
    const rename = page.getByRole('button', { name: 'Rename', exact: true });
    await expect(async () => {
      await actions.click();
      await expect(rename).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    const panel = rename.locator('..');

    const viewport = page.viewportSize();
    const menu = await panel.boundingBox();
    const trigger = await actions.boundingBox();
    if (!menu || !trigger || !viewport) throw new Error('The menu is not on screen.');
    // Inside the window, and wholly above the button that opened it.
    expect(menu.y).toBeGreaterThanOrEqual(0);
    expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height);
    expect(menu.y + menu.height).toBeLessThanOrEqual(trigger.y);

    await testInfo.attach('menu-flipped-above-row', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // The menu still works from its flipped place: Rename opens its dialog.
    await rename.click();
    await expect(page.getByRole('dialog', { name: 'Rename chat' })).toBeVisible();
  } finally {
    await removeModel(page.request, modelId);
  }
});
