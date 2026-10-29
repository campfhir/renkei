/**
 * Waits on what the page itself says, instead of a fixed pause.
 *
 *   await settled(page);  // before a screenshot: painted, and every
 *                         // transition and animation that will end, ended
 *   await painted(page);  // after a key that should do nothing: its
 *                         // handlers ran and React committed what they set
 *   await pointerReaches(page, target);  // before pressing on something
 *                         // that just appeared over, or inside, an iframe
 */

import { expect, type Locator, type Page } from '@playwright/test';

/** Two frames from now: whatever an event just set has been committed and drawn. */
export async function painted(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/**
 * Painted, then every running CSS transition and animation with an end
 * (a spinner's endless one is left alone) has finished: a spotlight that
 * slides to its target, a card that fades in.
 */
export async function settled(page: Page): Promise<void> {
  await painted(page);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' &&
            animation.effect?.getComputedTiming().iterations !== Infinity
        )
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );
}

/**
 * The value `read` gives once it has held for `frames` painted frames in a
 * row: an iframe that grows to its content, a list that fills in. Throws
 * when it is still moving after `timeout`.
 */
export async function steady<T>(
  page: Page,
  read: () => Promise<T>,
  { frames = 5, timeout = 10_000 } = {}
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();
  let held = 0;
  while (held < frames) {
    if (Date.now() > deadline) throw new Error(`still changing after ${timeout}ms`);
    await painted(page);
    const next = await read();
    held = JSON.stringify(next) === JSON.stringify(value) ? held + 1 : 0;
    value = next;
  }
  return value;
}

/**
 * Moves the mouse over `target` (at `at`, in page coordinates, or its
 * middle) until the element itself hears it. The browser routes a mouse
 * event by the layers the compositor last drew, not by the DOM: an element
 * that has just appeared over an iframe (the mockup viewer's pan layer), or
 * one inside an iframe that has just opened, can for a few frames have its
 * presses sent to whatever was there before, and Playwright's own checks,
 * which read the DOM, cannot tell. Mockup iframes are sandboxed, so Chrome
 * puts them in a process of their own, where that routing lags most.
 */
export async function pointerReaches(
  page: Page,
  target: Locator,
  at?: { x: number; y: number }
): Promise<void> {
  await target.evaluate((element) => {
    element.removeAttribute('data-e2e-pointer');
    element.addEventListener('pointermove', () => element.setAttribute('data-e2e-pointer', ''), {
      once: true,
    });
  });
  let point = at;
  if (!point) {
    const box = await target.boundingBox();
    if (!box) throw new Error('pointerReaches: the target is not on screen');
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  const { x, y } = point;
  let nudge = 0;
  await expect
    .poll(async () => {
      // A move to a new point each time: the same point twice sends nothing.
      nudge = nudge === 0 ? 1 : 0;
      await page.mouse.move(x + nudge, y);
      return target.evaluate((element) => element.hasAttribute('data-e2e-pointer'));
    })
    .toBe(true);
  await target.evaluate((element) => element.removeAttribute('data-e2e-pointer'));
}
