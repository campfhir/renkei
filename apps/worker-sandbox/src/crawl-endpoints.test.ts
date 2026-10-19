/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- a test reads loose JSON answers */
/**
 * The crawl verbs over HTTP, against a real Crawler on an in-memory store
 * and a scripted browser: start (from a plan, and from a saved recipe),
 * status (with waiting), pages, stop/resume, the per-subject scope, and
 * the gates.
 */

jest.mock('./disk', () => ({
  newStorageKey: jest.fn(),
  writeStream: jest.fn(),
  readFile: jest.fn(),
  deleteFile: jest.fn(),
  ensureDataRoot: jest.fn(),
}));
jest.mock('./secrets-store', () => ({
  listExpiredSecrets: jest.fn(async () => []),
  deleteSecretById: jest.fn(),
}));
jest.mock('./store', () => ({ listExpired: jest.fn(async () => []), deleteById: jest.fn() }));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSandboxServer } from './server';
import { ALL_ORG_FEATURES } from './features';
import { Crawler, type CrawlContext } from './crawler';
import type { CrawlPageExtract } from './crawl-page-script';
import { memoryCrawlStore } from './test-support/memory-crawl-store';

const API_KEY = 'test-worker-key';
const ME = { subject: 'auth0|alice' };
const ORIGIN = 'https://hl7.example';

function openContext(): Promise<CrawlContext> {
  let current = '';
  return Promise.resolve({
    async newPage() {
      return {
        async goto(url: string) {
          current = url;
        },
        async waitForLoadState() {},
        url: () => current,
        async call<T>(): Promise<T> {
          const extract: CrawlPageExtract = {
            title: current.split('/').pop() ?? '',
            region: 'main',
            text: `About ${current}`,
            textTruncated: false,
            tables: [
              { headers: ['Field', 'Length'], rows: [[`${current.split('/').pop()}.1`, '4']] },
            ],
            links: [],
          };
          return extract as T;
        },
        async close() {},
      };
    },
    async close() {},
  });
}

const store = memoryCrawlStore();
const crawler = new Crawler({ store, openContext, guard: async () => {}, sleep: async () => {} });
let browserEnabled = true;
let server: Server;
let base: string;

beforeAll(async () => {
  server = createSandboxServer({
    db: {} as Kysely<DB>,
    apiKeys: [API_KEY],
    crawler,
    crawlStore: store,
    orgFeatures: async () => ({ ...ALL_ORG_FEATURES, browser: browserEnabled }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}/v1/crawls/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

describe('crawl endpoints', () => {
  it('starts a crawl, waits for it, and hands back its pages', async () => {
    const started = await post('start', {
      ...ME,
      plan: {
        origin: ORIGIN,
        pattern: '/Segments/*',
        template: { url: `${ORIGIN}/Segments/{value}`, values: ['AIG', 'AIL', 'AIP'] },
      },
      saveAs: 'HL7 v2.3 segments',
    });
    expect(started.status).toBe(200);
    expect(started.json.seeds).toBe(3);
    const id: string = started.json.crawl.id;

    const status = await post('status', { ...ME, crawlId: id, waitMs: 5_000 });
    expect(status.json.crawl.status).toBe('completed');
    expect(status.json.crawl.pagesDone).toBe(3);
    expect(status.json.pages.map((page: { url: string }) => page.url)).toEqual([
      `${ORIGIN}/Segments/AIG`,
      `${ORIGIN}/Segments/AIL`,
      `${ORIGIN}/Segments/AIP`,
    ]);
    expect(status.json.pages[0].content).toBeUndefined();

    const pages = await post('pages', { ...ME, crawlId: id, offset: 1, limit: 1 });
    expect(pages.json.pages).toHaveLength(1);
    expect(pages.json.pages[0].content.tables[0].rows).toEqual([['AIL.1', '4']]);

    // The status list, with the recipe saved by name.
    const listed = await post('status', ME);
    expect(listed.json.recipes.map((recipe: { name: string }) => recipe.name)).toEqual([
      'HL7 v2.3 segments',
    ]);
    // By recipe name, the same crawl.
    expect((await post('status', { ...ME, recipe: 'HL7 v2.3 segments' })).json.crawl.id).toBe(id);
    // Someone else sees nothing.
    expect((await post('status', { subject: 'auth0|bob', crawlId: id })).status).toBe(404);
    expect((await post('pages', { subject: 'auth0|bob', crawlId: id })).status).toBe(404);
  });

  it('re-crawls a saved recipe, and resumes a crawl its budget stopped', async () => {
    const rerun = await post('start', { ...ME, recipe: 'HL7 v2.3 segments', maxPages: 1 });
    expect(rerun.status).toBe(200);
    const id: string = rerun.json.crawl.id;
    let status = await post('status', { ...ME, crawlId: id, waitMs: 5_000 });
    expect(status.json.crawl.status).toBe('stopped');
    expect(status.json.crawl.pagesQueued).toBe(2);

    expect((await post('resume', { ...ME, recipe: 'HL7 v2.3 segments' })).status).toBe(200);
    status = await post('status', { ...ME, crawlId: id, waitMs: 5_000 });
    expect(status.json.crawl.status).toBe('completed');
    expect(status.json.crawl.pagesDone).toBe(3);
    expect((await post('resume', { ...ME, crawlId: id })).status).toBe(400);
  });

  it('refuses a plan outside its origin, a bad name, and an unknown recipe', async () => {
    const offOrigin = await post('start', {
      ...ME,
      plan: { origin: ORIGIN, pattern: '/*', urls: ['https://elsewhere.example/a'] },
    });
    expect(offOrigin.status).toBe(400);
    expect(offOrigin.json.error.message).toContain('is not a URL on');
    expect(
      (
        await post('start', {
          ...ME,
          plan: { origin: ORIGIN, pattern: '/*', urls: [`${ORIGIN}/a`] },
          saveAs: 'x'.repeat(101),
        })
      ).status
    ).toBe(400);
    expect((await post('start', { ...ME, recipe: 'nope' })).status).toBe(404);
    expect((await post('nonsense', ME)).status).toBe(404);
  });

  it('is closed when the organization has the browser off', async () => {
    browserEnabled = false;
    try {
      const closed = await post('status', ME);
      expect(closed.status).toBe(503);
      expect(closed.json.error.type).toBe('crawl_unavailable');
    } finally {
      browserEnabled = true;
    }
  });
});
