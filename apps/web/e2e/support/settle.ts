/**
 * Waits on what the page itself says, instead of a fixed pause.
 *
 *   await settled(page);  // before a screenshot: painted, and every
 *                         // transition and animation that will end, ended
 *   await painted(page);  // after a key that should do nothing: its
 *                         // handlers ran and React committed what they set
 */

import type { Page } from '@playwright/test';

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
