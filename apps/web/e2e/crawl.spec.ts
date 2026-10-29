/**
 * Every page renders on the in-memory data store alone: for each page in
 * ./crawl/, stage its data through the routes the UI itself calls, load
 * it (its client components' own requests included), and require it
 * answered, showed no error page and showed what its data — or its empty
 * state — should put on screen. Nothing outside @renkei/db can reach the
 * database (packages/db/src/store/seam.test.ts), so a page that needs a
 * row the store does not answer for fails here.
 */

import { randomUUID } from 'node:crypto';
import { CRAWL_PAGES } from './crawl';
import { test, expect } from './fixtures';

// An operator sees every page, the console included.
test.use({ roles: ['renkei-user', 'renkei-operator'] });
// The pages spread over the workers (and CI's shards) like any other
// test, and a failing page doesn't stop the rest (every offender is
// reported): each stages its own rows under a tag of its own.
// Whether a page renders from the store doesn't depend on the colour scheme.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'one project is enough');
});

for (const crawl of CRAWL_PAGES) {
  test(`${crawl.path} renders from the data store alone`, async ({ page, request, person }) => {
    const undo: (() => Promise<void>)[] = [];
    try {
      const staged = crawl.stage
        ? await crawl.stage({
            person,
            api: page.request,
            request,
            tag: `crawl-${randomUUID().slice(0, 8)}`,
            cleanup: (step) => undo.push(step),
          })
        : undefined;
      const url = staged ?? crawl.path;

      const response = await page.goto(url);
      expect(response?.status() ?? 0, `${url} answered`).toBeLessThan(500);
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { name: 'This page hit an error' })).toHaveCount(0);
      if (crawl.expectText) {
        await expect(page.getByRole('main').getByText(crawl.expectText).first()).toBeVisible();
      }
    } finally {
      for (const step of undo.reverse()) await step();
    }
  });
}
