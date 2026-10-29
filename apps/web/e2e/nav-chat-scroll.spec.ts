/**
 * The app menu column: the version stays pinned to its foot and only the
 * chat list scrolls. The menu's sections above it do not move with the list.
 *
 * The chats are the person's own, each asked one question through the
 * chat routes (the sidebar lists only chats with a message in them),
 * answered by the stand-in model: enough of them in the first test that
 * the list overflows and the scroll itself is exercised.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from './support/stub-model';
import { createChat, send } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function chatsTitled(
  request: APIRequestContext,
  modelId: string,
  prefix: string,
  count: number
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const chatId = await createChat(request, { llmModelId: modelId, title: `${prefix} ${index}` });
    await send(request, chatId, 'Hello.', modelId);
  }
}

test('app menu: version is pinned to the foot and the chat list scrolls on its own', async ({
  page,
  person: _person,
}, testInfo) => {
  test.slow();
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    await chatsTitled(page.request, modelId, `Scroll e2e ${tag}`, 14);
    // A standard desktop window. Below this height the menu sections and the
    // list's minimum no longer fit, and the column scrolls as a fallback.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/agents`);

    const column = page.getByRole('navigation', { name: 'Application' });
    const chats = column.getByRole('navigation', { name: 'Chats' });
    const version = column.locator(':scope > p').last();
    await expect(chats).toBeVisible();
    await expect(version).toBeVisible();

    // The chat list is its own scroll box; the column above it is not.
    await expect(chats).toHaveCSS('overflow-y', 'auto');
    await expect
      .poll(() => chats.evaluate((el) => el.scrollHeight > el.clientHeight + 1))
      .toBe(true);

    const footerBox = await version.boundingBox();
    const columnBox = await column.boundingBox();
    if (!footerBox || !columnBox) throw new Error('The menu column is not on screen.');
    // Pinned: the version sits at the foot of the column, inside its padding.
    expect(footerBox.y + footerBox.height).toBeGreaterThan(columnBox.y + columnBox.height - 40);
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(columnBox.y + columnBox.height + 1);

    // The menu's own sections never scroll with the chat list.
    const workspace = column.getByRole('link', { name: 'Home', exact: true });
    const workspaceBefore = await workspace.boundingBox();

    await chats.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => chats.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    const footerAfter = await version.boundingBox();
    const workspaceAfter = await workspace.boundingBox();
    expect(footerAfter?.y).toBeCloseTo(footerBox.y, 0);
    expect(workspaceAfter?.y).toBeCloseTo(workspaceBefore?.y ?? Number.NaN, 0);

    await page.screenshot({
      path: path.join(
        import.meta.dirname,
        '..',
        'test-results',
        'screens',
        testInfo.project.name,
        'nav-chat-scroll.png'
      ),
    });
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('app menu: three chats show at a desktop height without scrolling the list', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop column check.');
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const prefix = `Menu height e2e ${tag}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    await chatsTitled(page.request, modelId, prefix, 5);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/agents`);
    const chats = page
      .getByRole('navigation', { name: 'Application' })
      .getByRole('navigation', { name: 'Chats' });
    const rows = chats.getByRole('link', { name: new RegExp(`^${prefix} \\d`) });
    await expect(rows).toHaveCount(5);

    // Each row whose top and bottom both sit inside the list's visible box.
    const visible = await rows.evaluateAll(
      (links, list) => {
        if (!list) return 0;
        const box = list.getBoundingClientRect();
        return links.filter((link) => {
          const row = link.getBoundingClientRect();
          return row.top >= box.top && row.bottom <= box.bottom;
        }).length;
      },
      await chats.elementHandle()
    );
    expect(visible).toBeGreaterThanOrEqual(3);
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('app menu: the column never scrolls, only the chat list does, on desktop and in the phone drawer', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A layout check at two widths.');
  test.slow();
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const prefix = `Menu scroll e2e ${tag}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    // More chats than the menu holds, so the list has to scroll.
    await chatsTitled(page.request, modelId, prefix, 14);

    // The phone drawer, a laptop, and a desktop: the menu never scrolls at any of them.
    for (const size of [
      { width: 390, height: 844 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await page.goto('/agents');
      if (size.width < 1024) await page.getByRole('button', { name: 'Open menu' }).click();
      const column = page.locator('nav[aria-label="Application"]:visible').first();
      const chats = column.getByRole('navigation', { name: 'Chats' });
      await expect(chats).toBeVisible();
      await expect(column.getByRole('link', { name: `${prefix} 1`, exact: true })).toBeAttached();

      const layout = await column.evaluate((element) => {
        const list = element.querySelector<HTMLElement>('nav[aria-label="Chats"]');
        const footers = element.querySelectorAll<HTMLElement>(':scope > p');
        const footer = footers[footers.length - 1];
        return {
          columnScrolls: element.scrollHeight > element.clientHeight + 1,
          listScrolls: list ? list.scrollHeight > list.clientHeight + 1 : false,
          footerInside: footer
            ? footer.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1
            : false,
        };
      });
      expect(layout, `menu at ${size.width}px`).toEqual({
        columnScrolls: false,
        listScrolls: true,
        footerInside: true,
      });
      // The list always has room for four chats at once.
      const fourShown = await chats.evaluate((list) => {
        const box = list.getBoundingClientRect();
        return [...list.querySelectorAll('a')].filter((link) => {
          const row = link.getBoundingClientRect();
          return row.top >= box.top && row.bottom <= box.bottom;
        }).length;
      });
      expect(fourShown, `chats shown at ${size.width}px`).toBeGreaterThanOrEqual(4);
    }
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('app menu: day headings stick to the top of the history, and the filter stays available', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop layout check.');
  test.slow();
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const prefix = `Sticky heading e2e ${tag}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    // Enough chats to scroll. A chat's day is its last message's, which
    // the server stamps now; the browser's clock is moved a month on, so
    // the list (which groups by the browser's day, chat-nav.tsx) files
    // them under its oldest heading.
    await chatsTitled(page.request, modelId, prefix, 16);
    await page.clock.setFixedTime(new Date(Date.now() + 30 * 86_400_000));

    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/agents');
    const column = page.locator('nav[aria-label="Application"]:visible').first();
    const list = column.getByRole('navigation', { name: 'Chats' });
    await expect(list.getByRole('link', { name: `${prefix} 1`, exact: true })).toBeAttached();
    const filter = column.getByRole('button', { name: 'Filter chats' });
    // Scrolled to the bottom, the oldest day's heading holds the top of the list.
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const listTop = (await list.boundingBox())?.y ?? Number.NaN;
    await expect
      .poll(
        async () =>
          (await list.getByText('Earlier', { exact: true }).locator('..').boundingBox())?.y ??
          Number.POSITIVE_INFINITY
      )
      .toBeLessThanOrEqual(listTop + 2);

    // The filter sits on the top heading's row, above the list, so it is still
    // there at the bottom: level with the list's top edge.
    await expect(filter).toBeInViewport();
    const control = await filter.boundingBox();
    expect(Math.abs((control?.y ?? Number.NaN) - listTop)).toBeLessThan(4);
  } finally {
    await removeModel(page.request, modelId);
  }
});
