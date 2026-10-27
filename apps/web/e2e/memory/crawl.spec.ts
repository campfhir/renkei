/**
 * Every page, on the in-memory data store, reaching for nothing else: for
 * each page in ./crawl/, seed its rows, load it (its client components'
 * own requests included), and require that no code reached past the data
 * store to the database directly — the memory store records every such
 * call (packages/db/src/client.ts) and the test seed route reports them.
 *
 * A failure names the caller: move that read behind getDataStore()
 * (AGENTS.md, "The data store seam").
 */

import { CRAWL_PAGES } from './crawl';
import { MEMORY_BASE_URL, MEMORY_SEED_TOKEN } from './constants';
import { test, expect } from './fixtures';

const SEED_URL = `${MEMORY_BASE_URL}/api/test/data-store`;
const HEADERS = { 'x-renkei-seed-token': MEMORY_SEED_TOKEN };

// An operator sees every page, the console included.
test.use({ roles: ['renkei-user', 'renkei-operator'] });
// One call log for the whole server: the pages take turns, in one worker,
// and a failing page doesn't stop the rest (every offender is reported).
test.describe.configure({ mode: 'default' });
// Which code reaches the database doesn't depend on the colour scheme.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'one project is enough');
});

for (const crawl of CRAWL_PAGES) {
  test(`${crawl.path} renders from the data store alone`, async ({ page, person, request }) => {
    // Replace: a reused server may still hold an earlier run's org-wide rows.
    if (crawl.seed) {
      await person.seed(crawl.seed(person.subject, person.sessionId), { replace: true });
    }
    await request.delete(SEED_URL, { headers: HEADERS, data: { calls: true } });

    const response = await page.goto(crawl.path);
    expect(response?.status() ?? 0, `${crawl.path} answered`).toBeLessThan(500);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'This page hit an error' })).toHaveCount(0);
    if (crawl.expectText) {
      await expect(page.getByRole('main').getByText(crawl.expectText).first()).toBeVisible();
    }

    const calls = await request.get(SEED_URL, { headers: HEADERS });
    expect(await calls.json(), `direct database calls while rendering ${crawl.path}`).toEqual({
      directDatabaseCalls: [],
    });
  });
}
