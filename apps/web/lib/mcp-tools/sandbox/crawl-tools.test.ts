/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The crawl tools against a scripted worker client: which are reads and
 * which acts, learning a scope from examples, starting / re-crawling /
 * resuming, the status list, and reads rendered as Markdown tables and
 * bounded by maxChars.
 */

jest.mock('@/lib/sandbox/service-client', () => ({
  clientFailure: jest.fn((error: { message?: string; type?: string }) => ({
    status: 400,
    message: error.message ?? `failed: ${error.type}`,
  })),
  sbCrawlStart: jest.fn(),
  sbCrawlResume: jest.fn(),
  sbCrawlStop: jest.fn(),
  sbCrawlStatus: jest.fn(),
  sbCrawlList: jest.fn(),
  sbCrawlPages: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { pageMarkdown, planFromArgs, registerSandboxCrawlTools, tableMarkdown } from './crawl';

const client = jest.requireMock<Record<string, jest.Mock>>('@/lib/sandbox/service-client');

type Handler = (
  args: Record<string, unknown>
) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface Registered {
  config: { annotations?: { readOnlyHint?: boolean } };
  handler: Handler;
}

const ORIGIN = 'https://hl7-definition.caristix.com';
const SEGMENTS = `${ORIGIN}/v2/HL7v2.3/Segments`;
const CRAWL_ID = '0b5f7c1e-2c1a-4c55-9a3e-2d3c4b5a6f70';

/** Only the subject matters to these tools. */
function asContext(fields: { subject?: string }): MCPToolContext {
  return fields as unknown as MCPToolContext;
}

function tools(
  context: MCPToolContext = asContext({ subject: 'auth0|alice' })
): Map<string, Registered> {
  const registered = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Handler) => {
      registered.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerSandboxCrawlTools(server, context);
  return registered;
}

function crawl(overrides: Record<string, unknown> = {}) {
  return {
    id: CRAWL_ID,
    status: 'completed',
    recipeName: null,
    recipe: { origin: ORIGIN, pattern: '/v2/HL7v2.3/Segments/*', region: 'auto', maxPages: 3 },
    pagesDone: 3,
    pagesFailed: 0,
    pagesQueued: 0,
    nextUrls: [],
    error: null,
    createdAt: '2026-10-19T06:00:00Z',
    updatedAt: '2026-10-19T06:00:10Z',
    finishedAt: '2026-10-19T06:00:10Z',
    ...overrides,
  };
}

function page(seq: number, code: string, rows: string[][]) {
  return {
    url: `${SEGMENTS}/${code}`,
    seq,
    depth: 0,
    status: 'ok',
    title: `${code} segment`,
    textChars: 40,
    tableCount: 1,
    error: null,
    content: {
      title: `${code} segment`,
      region: 'main',
      text: `The ${code} segment.`,
      textTruncated: false,
      tables: [{ headers: ['Field', 'Length'], rows }],
    },
  };
}

beforeEach(() => jest.clearAllMocks());

describe('crawl tools', () => {
  it('registers the plan, status and read as reads, the crawl and stop as acts', () => {
    const registered = tools();
    expect(
      [...registered].map(([name, entry]) => [
        name,
        entry.config.annotations?.readOnlyHint === true,
      ])
    ).toEqual([
      ['sandbox_crawl_plan', true],
      ['sandbox_browser_crawl', false],
      ['sandbox_crawl_status', true],
      ['sandbox_crawl_read', true],
      ['sandbox_crawl_stop', false],
    ]);
  });

  it('learns a template from examples, and plans without fetching', async () => {
    const plan = planFromArgs({ examples: [`${SEGMENTS}/AIG`, `${SEGMENTS}/ACC`] });
    expect(plan.ok && plan.recipe.template).toEqual({
      url: `${SEGMENTS}/{value}`,
      values: ['AIG', 'ACC'],
    });
    // Named pages win over the learned template; the learned pattern still applies.
    const follow = planFromArgs({
      examples: [`${SEGMENTS}/AIG`, `${SEGMENTS}/ACC`],
      follow: { from: [SEGMENTS] },
    });
    expect(follow.ok && follow.recipe.pattern).toBe('/v2/HL7v2.3/Segments/*');
    expect(follow.ok && follow.recipe.template).toBeUndefined();

    const answer = await tools()
      .get('sandbox_crawl_plan')!
      .handler({ examples: [`${SEGMENTS}/AIG`, `${SEGMENTS}/ACC`] });
    expect(answer.isError).toBeUndefined();
    expect(answer.content[0].text).toContain('Learned from the examples');
    expect(answer.content[0].text).toContain(`- ${SEGMENTS}/ACC`);
    expect(Object.values(client).every((mock) => mock.mock.calls.length === 0)).toBe(true);

    const refused = await tools()
      .get('sandbox_crawl_plan')!
      .handler({ origin: ORIGIN, pattern: '/*', urls: ['https://elsewhere.example/a'] });
    expect(refused.isError).toBe(true);
  });

  it('starts from a plan, re-crawls a recipe, and resumes by id or by name', async () => {
    const crawlTool = tools().get('sandbox_browser_crawl')!;
    client.sbCrawlStart.mockResolvedValue({
      ok: true,
      val: { crawl: crawl({ status: 'queued', recipeName: 'segments' }), seeds: 2 },
    });
    const started = await crawlTool.handler({
      examples: [`${SEGMENTS}/AIG`, `${SEGMENTS}/ACC`],
      saveAs: 'segments',
    });
    expect(client.sbCrawlStart).toHaveBeenCalledWith(
      { subject: 'auth0|alice' },
      expect.objectContaining({
        saveAs: 'segments',
        plan: expect.objectContaining({ origin: ORIGIN, pattern: '/v2/HL7v2.3/Segments/*' }),
      })
    );
    expect(started.content[0].text).toContain(`Started. Crawl ${CRAWL_ID} "segments"`);
    expect(started.content[0].text).toContain('sandbox_crawl_status');

    await crawlTool.handler({ recipe: 'segments', maxPages: 50 });
    expect(client.sbCrawlStart).toHaveBeenLastCalledWith(
      { subject: 'auth0|alice' },
      { recipe: 'segments', maxPages: 50 }
    );

    client.sbCrawlResume.mockResolvedValue({ ok: true, val: crawl({ status: 'queued' }) });
    await crawlTool.handler({ resume: CRAWL_ID });
    expect(client.sbCrawlResume).toHaveBeenLastCalledWith(
      { subject: 'auth0|alice' },
      { crawlId: CRAWL_ID }
    );
    await crawlTool.handler({ resume: 'segments' });
    expect(client.sbCrawlResume).toHaveBeenLastCalledWith(
      { subject: 'auth0|alice' },
      { recipe: 'segments' }
    );

    client.sbCrawlStart.mockResolvedValueOnce({
      ok: false,
      err: { kind: 'op', type: 'crawl_unavailable', message: 'The crawler is not available.' },
    });
    const refused = await crawlTool.handler({
      origin: ORIGIN,
      pattern: '/*',
      urls: [`${ORIGIN}/a`],
    });
    expect(refused).toEqual({
      content: [{ type: 'text', text: 'The crawler is not available.' }],
      isError: true,
    });
  });

  it('reports status with the page list, and lists crawls and recipes when nothing is named', async () => {
    client.sbCrawlStatus.mockResolvedValue({
      ok: true,
      val: {
        crawl: crawl({ status: 'stopped', pagesQueued: 7, error: 'Reached its page budget (3).' }),
        pages: [
          page(1, 'AIG', [['AIG.1', '4']]),
          { ...page(2, 'AIL', []), status: 'failed', error: 'Could not load the page' },
        ],
      },
    });
    const status = await tools()
      .get('sandbox_crawl_status')!
      .handler({ crawlId: CRAWL_ID, waitSeconds: 30 });
    expect(client.sbCrawlStatus).toHaveBeenCalledWith(
      { subject: 'auth0|alice' },
      { crawlId: CRAWL_ID, waitMs: 30_000, pageOffset: 0, pageLimit: 200 }
    );
    const text = status.content[0].text;
    expect(text).toContain(`"resume":"${CRAWL_ID}"`);
    expect(text).toContain(`1. AIG segment — ${SEGMENTS}/AIG — 40 chars, 1 table(s)`);
    expect(text).toContain(`2. FAILED ${SEGMENTS}/AIL — Could not load the page`);

    client.sbCrawlList.mockResolvedValue({
      ok: true,
      val: {
        crawls: [crawl()],
        recipes: [
          {
            name: 'segments',
            recipe: crawl().recipe,
            lastCrawlId: CRAWL_ID,
            updatedAt: '2026-10-19T06:00:10Z',
          },
        ],
      },
    });
    const listed = await tools().get('sandbox_crawl_status')!.handler({});
    expect(listed.content[0].text).toContain('Saved recipes:');
    expect(listed.content[0].text).toContain('"segments"');
  });

  it('reads pages as Markdown tables, bounded, and says where to continue', async () => {
    const rows = Array.from({ length: 14 }, (_, index) => [
      `AIG.${index + 1} - Field | name`,
      '200',
    ]);
    client.sbCrawlPages.mockResolvedValue({
      ok: true,
      val: { crawl: crawl({ pagesDone: 3 }), pages: [page(1, 'AIG', rows), page(2, 'AIL', rows)] },
    });
    const read = tools().get('sandbox_crawl_read')!;
    const both = await read.handler({ crawlId: CRAWL_ID, limit: 2, include: 'tables' });
    const text = both.content[0].text;
    expect(client.sbCrawlPages).toHaveBeenCalledWith(
      { subject: 'auth0|alice' },
      { crawlId: CRAWL_ID, offset: 0, limit: 2 }
    );
    expect(text).toContain('| Field | Length |');
    expect(text).toContain('| AIG.14 - Field \\| name | 200 |');
    expect(text).not.toContain('The AIG segment.');
    expect(text).toContain('1 more page(s) — continue with offset 2.');

    const tight = await read.handler({ crawlId: CRAWL_ID, limit: 2, maxChars: 1_000 });
    expect(tight.content[0].text).toContain('## 1. AIG segment');
    expect(tight.content[0].text).not.toContain('## 2. AIL segment');
    expect(tight.content[0].text).toContain('continue with offset 1');
  });

  it('renders tables without headers and refuses a caller with no identity', async () => {
    expect(tableMarkdown({ headers: [], rows: [['a', 'b']] })).toBe(
      '| Column 1 | Column 2 |\n| --- | --- |\n| a | b |'
    );
    expect(
      pageMarkdown({ ...page(1, 'X', []), status: 'failed', error: 'nope', content: null }, 'all')
    ).toContain('Not read: nope');
    const anonymous = await tools(asContext({}))
      .get('sandbox_browser_crawl')!
      .handler({ recipe: 'x' });
    expect(anonymous.isError).toBe(true);
    expect(client.sbCrawlStart).not.toHaveBeenCalled();
  });
});
