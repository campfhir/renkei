/**
 * Every page renders on the in-memory data store alone: for each page in
 * ./crawl/, seed its rows, load it (its client components' own requests
 * included), and require it answered, showed no error page and showed
 * what its rows should put on screen. Nothing outside @renkei/db can reach
 * the database (packages/db/src/store/seam.test.ts), so a page that needs
 * a row the store does not answer for fails here.
 */

import { CRAWL_PAGES } from './crawl';
import { test, expect } from './fixtures';

// An operator sees every page, the console included.
test.use({ roles: ['renkei-user', 'renkei-operator'] });
// The pages take turns, in one worker, and a failing page doesn't stop
// the rest (every offender is reported).
test.describe.configure({ mode: 'default' });
// Whether a page renders from the store doesn't depend on the colour scheme.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'one project is enough');
});

for (const crawl of CRAWL_PAGES) {
  test(`${crawl.path} renders from the data store alone`, async ({ page, person }) => {
    // Replace: a reused server may still hold an earlier run's org-wide rows.
    if (crawl.seed) {
      await person.seed(crawl.seed(person.subject, person.sessionId), { replace: true });
    }

    const response = await page.goto(crawl.path);
    expect(response?.status() ?? 0, `${crawl.path} answered`).toBeLessThan(500);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'This page hit an error' })).toHaveCount(0);
    if (crawl.expectText) {
      await expect(page.getByRole('main').getByText(crawl.expectText).first()).toBeVisible();
    }
  });
}
