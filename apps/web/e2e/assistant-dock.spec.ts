/**
 * The assistant dock (components/assistant-dock), in a browser, where a
 * page puts an assistant in it (a code project's Pipeline tab): its
 * button floats above the page in the bottom-right corner and opens the
 * dock above it; the dock's free corner resizes it, an outline
 * following the pointer until it lets go; dragged with the dock open,
 * the button carries the dock and anchors to the top-left corner,
 * where the dock opens below it; Shift+an arrow key moves it corner to
 * corner; Escape collapses it; the corner is remembered across a reload;
 * and on a phone the dock fits the screen.
 *
 * Where the rules went — the corners, which side the dock opens, the
 * sizes kept and fitted, a click versus a drag — is
 * assistant-dock.model.test.ts; this spec shows the pointer, the layout
 * and the stacking only a browser has. The pipeline's assistant itself is
 * pipeline-assistant.spec.ts.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';

const EDGE = 16;
const CTA = 56;
const GAP = 12;

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
  });
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error('not drawn');
  return found;
}

test('assistant dock: floats above the page, resizes with an outline, drags to a corner', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  await page.setViewportSize({ width: 1280, height: 860 });
  await prepareCodeHost(request);
  await connectBitbucket(page);
  const projectId = await createCodeProject(page.request, {
    name: `Dock demo (${tag})`,
    repository: `acme/pipeline-dock-${tag}`,
    branch: 'main',
  });

  await page.goto(`/deployments/${projectId}/pipeline`);
  await expect(
    page.getByRole('main').getByRole('region', { name: 'Found in this repository' })
  ).toBeVisible({ timeout: 30_000 });

  // --- In the bottom-right corner, above everything. ---
  const viewport = page.viewportSize()!;
  const open = page.getByRole('button', { name: 'Open the Pipeline assistant' });
  const collapse = page.getByRole('button', { name: 'Collapse the Pipeline assistant' }).last();
  const dock = page.getByRole('dialog', { name: 'Pipeline assistant' });
  let cta = await box(open);
  expect(cta).toMatchObject({
    x: viewport.width - EDGE - CTA,
    y: viewport.height - EDGE - CTA,
  });
  const onTop = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="assistant-dock"]') !== null,
    [cta.x + CTA / 2, cta.y + CTA / 2]
  );
  expect(onTop).toBe(true);

  // --- A click opens the dock above it, lined up with its right edge. ---
  await open.click();
  await expect(dock).toBeVisible();
  await expect(open).toHaveCount(0);
  let frame = await box(dock);
  expect(Math.round(frame.x + frame.width)).toBe(cta.x + CTA);
  expect(Math.round(frame.y + frame.height)).toBe(cta.y - GAP);

  // --- Its free corner resizes it: an outline follows, and the dock takes it. ---
  const handle = await box(page.getByTestId('assistant-dock-resize-corner'));
  await page.mouse.move(handle.x + 4, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + 4 - 80, handle.y + 4 - 50, { steps: 6 });
  const outline = page.getByTestId('assistant-dock-outline');
  await expect(outline).toBeVisible();
  // Pointer moves paint at the next frame: wait for the outline to get there.
  await expect
    .poll(async () => {
      const drawn = await box(outline);
      return [Math.round(drawn.width), Math.round(drawn.height)];
    })
    .toEqual([Math.round(frame.width + 80), Math.round(frame.height + 50)]);
  // The dock waits for the pointer to let go.
  expect((await box(dock)).width).toBe(frame.width);
  await shot(page, testInfo, 'assistant-dock-00-resizing');
  await page.mouse.up();
  await expect(outline).toHaveCount(0);
  await expect
    .poll(async () => {
      const resized = await box(dock);
      return [Math.round(resized.width), Math.round(resized.height)];
    })
    .toEqual([Math.round(frame.width + 80), Math.round(frame.height + 50)]);

  // --- Dragged with the dock open, the button carries it, then anchors top-left. ---
  cta = await box(collapse);
  await page.mouse.move(cta.x + CTA / 2, cta.y + CTA / 2);
  await page.mouse.down();
  await page.mouse.move(260, 200, { steps: 10 });
  await expect.poll(async () => Math.round((await box(collapse)).x + CTA / 2)).toBe(260);
  const midway = await box(collapse);
  frame = await box(dock);
  // In the top half, the dock turns to open below the button.
  expect(Math.round(frame.y)).toBe(Math.round(midway.y + CTA + GAP));
  expect(Math.round(frame.x)).toBe(Math.round(midway.x));
  await page.mouse.up();
  await expect(dock).toBeVisible(); // a drag is not a click
  await expect
    .poll(async () => {
      const at = await box(collapse);
      return [Math.round(at.x), Math.round(at.y)];
    })
    .toEqual([EDGE, EDGE]);
  frame = await box(dock);
  expect(Math.round(frame.x)).toBe(EDGE);
  expect(Math.round(frame.y)).toBe(EDGE + CTA + GAP);
  // Never past the bottom of the viewport.
  expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.height - EDGE + 1);
  await shot(page, testInfo, 'assistant-dock-01-top-left');

  // --- From the keyboard: Shift+→ moves it to the top-right; Escape collapses it. ---
  await collapse.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect
    .poll(async () => Math.round((await box(collapse)).x))
    .toBe(viewport.width - EDGE - CTA);
  await dock.getByLabel('Ask the assistant').focus();
  await page.keyboard.press('Escape');
  await expect(dock).toBeHidden();
  await expect(open).toBeFocused();

  // --- This browser remembers the corner. ---
  await page.reload();
  await expect
    .poll(async () => {
      const at = await box(page.getByRole('button', { name: 'Open the Pipeline assistant' }));
      return [Math.round(at.x), Math.round(at.y)];
    })
    .toEqual([viewport.width - EDGE - CTA, EDGE]);

  // --- On a phone, the dock fits the screen below the button. ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open the Pipeline assistant' }).click();
  await expect(dock).toBeInViewport({ ratio: 1 });
  frame = await box(dock);
  expect(Math.round(frame.x)).toBeGreaterThanOrEqual(EDGE);
  expect(Math.round(frame.x + frame.width)).toBeLessThanOrEqual(390 - EDGE);
  expect(Math.round(frame.y)).toBe(EDGE + CTA + GAP);
  await shot(page, testInfo, 'assistant-dock-02-phone');
});
