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
// One call log for the whole server: pages take turns.
test.describe.configure({ mode: 'serial' });

for (const crawl of CRAWL_PAGES) {
  test(`${crawl.path} renders from the data store alone`, async ({ page, person, request }) => {
    if (crawl.seed) await person.seed(crawl.seed(person.subject));
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
