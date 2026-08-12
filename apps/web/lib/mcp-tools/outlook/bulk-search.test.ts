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
                executeTakeFirst: async () => ({ provider_account_id: 'acct-1' }),
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
}));
jest.mock('@/lib/microsoft-app', () => ({ getMicrosoftApp: async () => null }));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: async () => null,
  searchKnowledge: async () => ({ ok: true, val: { hits: [], elided: 0 } }),
}));
jest.mock('../knowledge', () => ({ buildKnowledgeVerifiers: async () => new Map() }));
jest.mock('@/lib/logger', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  secure: (value: unknown) => value,
}));

import { registerOutlookTools } from './index';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

let calls: FetchCall[] = [];
/** Pages the fake Graph serves, in order; each is one response body. */
let pages: Record<string, unknown>[] = [];

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
  let pageIndex = 0;
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
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

  await registerOutlookTools(server, {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    subject: 'subject-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
  } as MCPToolContext);

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
