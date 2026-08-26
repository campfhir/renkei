/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression guards for outlook_bulk_search_messages' Graph query
 * construction. These are all rules that fail as an opaque HTTP 400 from
 * Exchange rather than anything type-checkable, and every one of them was
 * a real bug found in live triage — hence real tests rather than the
 * no-coverage precedent the rest of this tool file follows.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

jest.mock('@renkei/provider-grants', () => ({
  getGrant: async () => ({
    ok: true,
    val: {
      accessToken: 'token-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountId: 'acct-1',
      metadata: { upn: 'scott@example.com' },
    },
  }),
  refreshGrantTokens: async () => ({ ok: true, val: { accessToken: 'token-1' } }),
  MICROSOFT: 'microsoft',
  MicrosoftAdapter: class {},
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({
    ok: true,
    val: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            where: () => ({
              where: () => ({
                limit: () => ({
                  executeTakeFirst: async () => ({ provider_account_id: 'acct-1' }),
                }),
              }),
            }),
          }),
        }),
      }),
    },
  }),
}));
jest.mock('@renkei/connector-microsoft', () => ({
  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
  BATCH_CHUNK_SIZE: 20,
  graphBatch: jest.requireActual('@renkei/connector-microsoft/src/mail-batch').graphBatch,
  summarizeBatch: jest.requireActual('@renkei/connector-microsoft/src/mail-batch').summarizeBatch,
  withCategoryChanges: jest.requireActual('@renkei/connector-microsoft/src/mail-batch')
    .withCategoryChanges,
  buildMailQueryPath: jest.requireActual('@renkei/connector-microsoft/src/mail-filter')
    .buildMailQueryPath,
  clientSideSelect: jest.requireActual('@renkei/connector-microsoft/src/mail-filter')
    .clientSideSelect,
  hasClientSideFilter: jest.requireActual('@renkei/connector-microsoft/src/mail-filter')
    .hasClientSideFilter,
  matchesClientSide: jest.requireActual('@renkei/connector-microsoft/src/mail-filter')
    .matchesClientSide,
}));
jest.mock('@/lib/microsoft-app', () => ({ getMicrosoftApp: async () => null }));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: async () => null,
  searchKnowledge: async () => ({ ok: true, val: { hits: [], elided: 0 } }),
}));
jest.mock('../knowledge', () => ({ buildKnowledgeVerifiers: async () => new Map() }));
jest.mock('@/lib/logger', () => ({
  logger: {
    info: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  secure: (value: unknown) => value,
}));

import { registerOutlookTools } from './index';
// oauthGraphAuth, not a stub: this file already mocks provider-grants/
// crypto/db/microsoft-app to serve a fake grant, so the real resolution
// path is exercised the same way the rest of this suite's fetch mocking is.
import { oauthGraphAuth } from '../graph/graph-auth';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

let calls: FetchCall[] = [];
/** Pages the fake Graph serves, in order; each is one response body. */
let pages: Record<string, unknown>[] = [];
/** When set, every call answers this status with this body instead. */
let failWith: { status: number; body: unknown } | null = null;

function message(id: string, subject: string, from: string): Record<string, unknown> {
  return {
    id,
    subject,
    receivedDateTime: '2026-08-01T00:00:00Z',
    isRead: false,
    from: { emailAddress: { name: from, address: `${from}@example.com` } },
  };
}

beforeEach(() => {
  calls = [];
  pages = [{ value: [] }];
  failWith = null;
  let pageIndex = 0;
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (failWith) {
      const text = JSON.stringify(failWith.body);
      return {
        ok: false,
        status: failWith.status,
        text: async () => text,
        json: async () => failWith?.body,
      };
    }
    const body = pages[Math.min(pageIndex, pages.length - 1)] ?? { value: [] };
    pageIndex += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof fetch;
});

async function bulkSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;

  const context = {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    subject: 'subject-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
  } as MCPToolContext;

  await registerOutlookTools(server, context, oauthGraphAuth(context));

  const handler = registered.get('outlook_bulk_search_messages');
  if (!handler) throw new Error('outlook_bulk_search_messages was not registered');
  return handler(args);
}

/** The $filter clause of the first Graph call, decoded. */
function firstFilter(): string {
  const url = new URL(calls[0]?.url ?? 'https://example.com');
  return url.searchParams.get('$filter') ?? '';
}

describe('outlook_bulk_search_messages query construction', () => {
  it('puts receivedDateTime clauses before every other clause', async () => {
    // Graph documents that when $filter and $orderby are combined on
    // messages, the $orderby property must appear in $filter BEFORE any
    // property that is not in the $orderby — otherwise Exchange answers
    // 400 InefficientFilter. We always order by receivedDateTime.
    await bulkSearch({ isRead: false, receivedAfter: '2026-01-01T00:00:00Z', from: 'a@b.com' });
    const filter = firstFilter();
    expect(filter).toContain('receivedDateTime ge 2026-01-01T00:00:00Z');
    expect(filter.indexOf('receivedDateTime')).toBeLessThan(filter.indexOf('isRead'));
    expect(filter.indexOf('receivedDateTime')).toBeLessThan(filter.indexOf('from/emailAddress'));
  });

  it('never sends contains() — Graph mail $filter has no working subject contains', async () => {
    await bulkSearch({ isRead: false, subjectContains: 'Planned Maintenance' });
    expect(firstFilter()).not.toContain('contains(');
    for (const call of calls) expect(call.url).not.toContain('contains%28');
  });

  it('never sends the ConsistencyLevel header on a mail query', async () => {
    // That header is a directory-objects-only feature; it is noise on mail.
    await bulkSearch({ isRead: false });
    for (const call of calls) {
      expect(Object.keys(call.headers)).not.toContain('ConsistencyLevel');
    }
  });

  it('still asks Graph to filter what it genuinely can', async () => {
    await bulkSearch({ isRead: false, flagStatus: 'flagged', hasAttachments: true });
    const filter = firstFilter();
    expect(filter).toContain('isRead eq false');
    expect(filter).toContain("flag/flagStatus eq 'flagged'");
    expect(filter).toContain('hasAttachments eq true');
  });

  it('escapes single quotes in filter values', async () => {
    await bulkSearch({ from: "o'brien@example.com" });
    expect(firstFilter()).toContain("o''brien@example.com");
  });
});

/**
 * The shapes that were reported broken, as queries.
 *
 * Live reproduction on 2026-08-26: `{from}`, `{from, hasAttachments}` and
 * `{flagStatus}` each came back a bare 400, while `{isRead}` alone and
 * `{subjectContains}` alone worked. What separates them is that the failing
 * three restrict on a COMPLEX path — from/…, flag/… — and the query carried
 * `$orderby=receivedDateTime desc` over a $filter that never mentioned
 * receivedDateTime.
 *
 * Exchange is the only thing that can actually reject a query, so these
 * cannot assert the 400 is gone. What they can do is pin the shape that
 * caused it, which is the part this repo controls.
 */
describe('outlook_bulk_search_messages filters that used to 400', () => {
  it.each([
    ['from alone', { from: 'scott.eremia-roden@nems.org' }],
    ['from with attachments', { from: 'a@example.com', hasAttachments: true }],
    ['flagStatus alone', { flagStatus: 'flagged' as const, max: 10 }],
    ['categories alone', { categories: ['Newsletters'] }],
  ])('names receivedDateTime first in the filter for %s', async (_name, args) => {
    await bulkSearch(args);
    const filter = firstFilter();
    expect(filter).toContain('receivedDateTime ge');
    expect(filter.indexOf('receivedDateTime ge')).toBe(0);
  });

  it('keeps the caller’s own date range rather than stacking a second one', async () => {
    await bulkSearch({ from: 'a@example.com', receivedAfter: '2026-08-01T00:00:00Z' });
    const filter = firstFilter();
    expect(filter.match(/receivedDateTime ge/g)).toHaveLength(1);
    expect(filter).toContain('receivedDateTime ge 2026-08-01T00:00:00Z');
  });

  it('leaves an unfiltered search unfiltered', async () => {
    // subjectContains is matched client-side, so it contributes no clause —
    // and a bare $orderby is not a combination Exchange objects to.
    await bulkSearch({ subjectContains: 'Salesforce', max: 5 });
    expect(firstFilter()).toBe('');
  });
});

/**
 * Recipient filters, which Exchange cannot answer.
 *
 * There is no $filter form of "who was this addressed to" on mail — not
 * equality, not a toRecipients/any lambda. Compiling one would recreate the
 * 400 the rest of this file exists to prevent, so the whole value of these
 * cases is the negative one: the clause must never appear.
 */
describe('outlook_bulk_search_messages to/cc', () => {
  const addressed = (id: string, to: string[], cc: string[] = []) => ({
    ...message(id, `message ${id}`, 'dana'),
    toRecipients: to.map((address) => ({ emailAddress: { name: address, address } })),
    ccRecipients: cc.map((address) => ({ emailAddress: { name: address, address } })),
  });

  const selectOf = () => new URL(calls[0]?.url ?? 'https://x.test').searchParams.get('$select');

  it('never compiles a recipient clause into $filter', async () => {
    await bulkSearch({ to: 'dana@example.com', cc: 'ops@example.com' });
    // $filter only — the names DO belong in $select, which is how the
    // client-side match gets something to read.
    for (const call of calls) {
      const filter = new URL(call.url).searchParams.get('$filter') ?? '';
      expect(filter).not.toContain('toRecipients');
      expect(filter).not.toContain('ccRecipients');
    }
    expect(firstFilter()).not.toContain('Recipients');
  });

  it('asks Graph for the recipient collections it has to match on', async () => {
    // Without these in $select the match reads undefined and silently
    // returns nothing — the exact silent-empty this is meant to avoid.
    await bulkSearch({ to: 'dana@example.com' });
    expect(selectOf()).toContain('toRecipients');

    calls = [];
    await bulkSearch({ cc: 'ops@example.com' });
    expect(selectOf()).toContain('ccRecipients');
  });

  it('leaves the projection alone when no recipient filter is set', async () => {
    await bulkSearch({ isRead: false });
    expect(selectOf()).not.toContain('toRecipients');
    expect(selectOf()).not.toContain('ccRecipients');
  });

  it('returns only the messages actually addressed to that person', async () => {
    pages = [
      {
        value: [
          addressed('1', ['dana@example.com']),
          addressed('2', ['someone@example.com']),
          addressed('3', ['ops@example.com', 'dana@example.com']),
        ],
      },
    ];
    const result = await bulkSearch({ to: 'DANA@example.com' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('id: 1');
    expect(text).toContain('id: 3');
    expect(text).not.toContain('id: 2');
  });

  it('does not treat a Cc as a To', async () => {
    pages = [{ value: [addressed('1', ['ops@example.com'], ['dana@example.com'])] }];
    expect((await bulkSearch({ to: 'dana@example.com' })).content[0]?.text).toContain(
      'No messages'
    );

    calls = [];
    pages = [{ value: [addressed('1', ['ops@example.com'], ['dana@example.com'])] }];
    expect((await bulkSearch({ cc: 'dana@example.com' })).content[0]?.text).toContain('id: 1');
  });

  it('scans several pages for a recipient, as it does for a subject', async () => {
    // A recipient filter thins a page exactly as a subject filter does, so
    // it has to earn the same scan budget rather than giving up after one.
    pages = [
      {
        value: [addressed('1', ['someone@example.com'])],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=p2',
      },
      { value: [addressed('2', ['dana@example.com'])] },
    ];
    const result = await bulkSearch({ to: 'dana@example.com' });
    expect(calls.length).toBeGreaterThan(1);
    expect(result.content[0]?.text ?? '').toContain('id: 2');
  });
});

describe('outlook_bulk_search_messages error reporting', () => {
  it('repeats what Graph said, not just the status', async () => {
    // The bug above took a session of bisecting parameters because the
    // reply was "Microsoft Graph answered 400" and nothing else — Graph had
    // named the problem and the tool dropped it on the floor.
    failWith = {
      status: 400,
      body: {
        error: {
          code: 'InefficientFilter',
          message: 'The restriction or sort order is too complex for this operation.',
        },
      },
    };
    const result = await bulkSearch({ from: 'a@example.com' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('InefficientFilter');
    expect(text).toContain('too complex for this operation');
  });

  it('still says something useful when the body is not Graph-shaped', async () => {
    failWith = { status: 400, body: 'not json at all' };
    const result = await bulkSearch({ from: 'a@example.com' });
    expect(result.content[0]?.text ?? '').toContain('400');
  });

  it('keeps the reconnect advice on a 403 and adds the reason', async () => {
    failWith = {
      status: 403,
      body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } },
    };
    const result = await bulkSearch({ isRead: false });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Reconnect Microsoft');
    expect(text).toContain('ErrorAccessDenied');
  });
});

describe('outlook_bulk_search_messages subject filtering', () => {
  it('matches subjects case-insensitively as a true substring', async () => {
    pages = [
      {
        value: [
          message('1', 'RE: Planned Maintenance Window', 'ops'),
          message('2', 'Lunch tomorrow?', 'dana'),
          message('3', 'unplanned maintenance follow-up', 'ops'),
        ],
      },
    ];
    const result = await bulkSearch({ subjectContains: 'MAINTENANCE' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Planned Maintenance Window');
    expect(text).toContain('unplanned maintenance follow-up');
    expect(text).not.toContain('Lunch tomorrow?');
  });

  it('reports how many were scanned so a thin match rate is visible', async () => {
    pages = [{ value: [message('1', 'keep me', 'dana'), message('2', 'drop me', 'dana')] }];
    const result = await bulkSearch({ subjectContains: 'keep' });
    expect(result.content[0]?.text ?? '').toContain('out of 2 scanned');
  });

  it('keeps every match in a scanned page rather than truncating to max', async () => {
    // The continuation token advances a WHOLE page, so a match dropped for
    // being over `max` was unreachable by any later call — it is not on the
    // page just returned and not on the next one either. Over-returning is
    // the lesser evil, and the only one that loses nothing.
    pages = [
      {
        value: [
          message('1', 'invoice one', 'ap'),
          message('2', 'invoice two', 'ap'),
          message('3', 'invoice three', 'ap'),
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next',
      },
    ];
    const result = await bulkSearch({ subjectContains: 'invoice', max: 1 });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('id: 1');
    expect(text).toContain('id: 2');
    expect(text).toContain('id: 3');
  });

  it('still stops fetching further pages once max is met', async () => {
    // Keeping a whole page is not licence to keep scanning: one page that
    // satisfies `max` ends the loop.
    pages = [
      {
        value: [message('1', 'invoice one', 'ap'), message('2', 'invoice two', 'ap')],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next',
      },
      { value: [message('3', 'invoice three', 'ap')] },
    ];
    await bulkSearch({ subjectContains: 'invoice', max: 1 });
    expect(calls).toHaveLength(1);
  });
});

describe('outlook_bulk_search_messages groupBySender', () => {
  it('groups by sender address, collapsing per-message display-name drift', async () => {
    pages = [
      {
        value: [
          {
            ...message('1', 'PROJ-1 updated', 'jira'),
            from: { emailAddress: { name: 'Jira (PROJ-1)', address: 'jira@example.com' } },
          },
          {
            ...message('2', 'PROJ-2 updated', 'jira'),
            from: { emailAddress: { name: 'Jira (PROJ-2)', address: 'jira@example.com' } },
          },
          message('3', 'Lunch?', 'dana'),
        ],
      },
    ];
    const result = await bulkSearch({ isRead: false, groupBySender: true });
    const text = result.content[0]?.text ?? '';
    // Both Jira messages land in one group despite differing display names.
    expect(text).toContain('<jira@example.com> (2)');
    expect(text).toContain('<dana@example.com> (1)');
  });
});

describe('outlook_bulk_search_messages countOnly', () => {
  it('reports the server total without listing message ids', async () => {
    pages = [{ '@odata.count': 439, value: [message('1', 'anything', 'dana')] }];
    const result = await bulkSearch({ isRead: false, countOnly: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('439 message(s) match.');
    expect(text).not.toContain('id: 1');
  });

  it('breaks the total down by sender', async () => {
    pages = [
      {
        '@odata.count': 3,
        value: [message('1', 'a', 'jira'), message('2', 'b', 'jira'), message('3', 'c', 'dana')],
      },
    ];
    const result = await bulkSearch({ isRead: false, countOnly: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Top senders');
    expect(text).toContain('2 — jira <jira@example.com>');
    expect(text).toContain('1 — dana <dana@example.com>');
  });
});
