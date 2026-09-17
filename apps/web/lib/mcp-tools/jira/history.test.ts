/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_get_issue_history: the changelog rendered as who changed what and
 * when, paged fully before filtering (Jira serves oldest first, 100 a page),
 * narrowed by field or date window, and capped with a "showing N" note.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  issueUrl: (siteUrl: string, issueKey: string) => `${siteUrl}/browse/${issueKey}`,
  getCachedDisplayName: () => 'Tester',
  withPresentationHint: (body: string, suggestion: string) =>
    `${body}\n\n(Presentation hint: ${suggestion})`,
}));

import { registerHistoryTools, parseHistoryEntry, HISTORY_CEILING } from './history';
import type { JiraAuth } from './jira-auth';

const apiBaseUrl = 'https://api.atlassian.com/ex/jira/cloud-1';

function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: (_requiredScopes, path, init) => jiraFetchMock(`${apiBaseUrl}${path}`, init),
  } as JiraAuth;
}

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

async function historyTool(): Promise<ToolHandler> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;

  await registerHistoryTools(
    server,
    {
      tenantId: 'tenant-1',
      accountId: 'acct-1',
      siteUrl: 'https://example.atlassian.net',
      apiBaseUrl,
      accessToken: 'token-1',
      maxJqlResults: 100,
    } as MCPToolContext,
    stubAuth()
  );

  return registered.get('jira_get_issue_history')!;
}

let requestedUrls: string[] = [];

interface RawChange {
  id: string;
  created: string;
  author?: { displayName?: string; accountId?: string };
  historyMetadata?: Record<string, unknown>;
  items: Record<string, unknown>[];
}

/** Serve `entries` as Jira would: oldest first, `pageSize` per page, with total/isLast. */
function serve(entries: RawChange[], pageSize = 100): void {
  requestedUrls = [];
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(async (url: string) => {
    requestedUrls.push(url);
    const startAt = Number(new URL(url).searchParams.get('startAt') ?? '0');
    const values = entries.slice(startAt, startAt + pageSize);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        startAt,
        maxResults: pageSize,
        total: entries.length,
        isLast: startAt + values.length >= entries.length,
        values,
      }),
    };
  });
}

const textOf = (result: ToolResult): string => result.content[0]?.text ?? '';

const statusChange = (id: string, created: string, who: string, from: string, to: string) => ({
  id,
  created,
  author: { displayName: who, accountId: `acct-${who.toLowerCase()}` },
  items: [
    { field: 'status', fieldId: 'status', from: '1', fromString: from, to: '2', toString: to },
  ],
});

const history: RawChange[] = [
  {
    id: '100',
    created: '2026-09-01T09:00:00.000+0000',
    author: { displayName: 'Alice' },
    items: [
      {
        field: 'assignee',
        fieldId: 'assignee',
        from: null,
        fromString: null,
        to: 'acct-bob',
        toString: 'Bob',
      },
      {
        field: 'priority',
        fieldId: 'priority',
        from: '3',
        fromString: 'Medium',
        to: '2',
        toString: 'High',
      },
    ],
  },
  statusChange('101', '2026-09-02T10:30:00.000+0000', 'Bob', 'To Do', 'In Progress'),
  {
    id: '102',
    created: '2026-09-05T15:45:00.000+0000',
    author: { displayName: 'Bob' },
    items: [
      {
        field: 'Sprint',
        fieldId: 'customfield_10020',
        from: '41',
        fromString: 'Sprint 41',
        to: '42',
        toString: 'Sprint 42',
      },
    ],
  },
  statusChange('103', '2026-09-10T08:00:00.000+0000', 'Carol', 'In Progress', 'Done'),
];

describe('jira_get_issue_history', () => {
  it('lists every change with its timestamp, author, and before/after values', async () => {
    serve(history);
    const result = await (await historyTool())({ issueKey: 'PROJ-7' });
    const text = textOf(result);

    expect(requestedUrls[0]).toBe(
      `${apiBaseUrl}/rest/api/3/issue/PROJ-7/changelog?startAt=0&maxResults=100`
    );
    expect(text).toContain('PROJ-7 has 4 changes, oldest first:');
    expect(text).toContain('• 2026-09-01T09:00:00.000Z — Alice');
    expect(text).toContain('    assignee: (none) → Bob');
    expect(text).toContain('    priority: Medium → High');
    expect(text).toContain('• 2026-09-02T10:30:00.000Z — Bob');
    expect(text).toContain('    status: To Do → In Progress');
    expect(text).toContain('• 2026-09-10T08:00:00.000Z — Carol');
    expect(text).toContain('    status: In Progress → Done');
    expect(text).toContain('Issue: https://example.atlassian.net/browse/PROJ-7');
    // Oldest first, as Jira serves it.
    expect(text.indexOf('Alice')).toBeLessThan(text.indexOf('Carol'));
  });

  it('narrows to one field by name or id, case-insensitively', async () => {
    serve(history);
    const tool = await historyTool();

    const byName = textOf(await tool({ issueKey: 'PROJ-7', field: 'Status' }));
    expect(byName).toContain('PROJ-7 has 2 changes to Status (4 in the full history)');
    expect(byName).toContain('To Do → In Progress');
    expect(byName).toContain('In Progress → Done');
    expect(byName).not.toContain('priority');

    const byId = textOf(await tool({ issueKey: 'PROJ-7', field: 'customfield_10020' }));
    expect(byId).toContain('has 1 change to customfield_10020');
    expect(byId).toContain('Sprint: Sprint 41 → Sprint 42');
  });

  it('keeps only changes inside the since/until window', async () => {
    serve(history);
    const tool = await historyTool();

    const text = textOf(
      await tool({ issueKey: 'PROJ-7', since: '2026-09-02', until: '2026-09-06T00:00:00Z' })
    );
    expect(text).toContain(
      'has 2 changes since 2026-09-02T00:00:00.000Z, until 2026-09-06T00:00:00.000Z (4 in the full history)'
    );
    expect(text).toContain('Bob');
    expect(text).not.toContain('Alice');
    expect(text).not.toContain('Carol');
  });

  it('rejects a date it cannot parse instead of silently ignoring it', async () => {
    serve(history);
    const result = await (await historyTool())({ issueKey: 'PROJ-7', since: 'last tuesday' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('since is not a date');
  });

  it('puts the newest change first on request and caps at maxResults', async () => {
    serve(history);
    const text = textOf(
      await (
        await historyTool()
      )({ issueKey: 'PROJ-7', newestFirst: true, maxResults: 2 })
    );

    expect(text).toContain('PROJ-7 has 4 changes; showing the newest 2, newest first:');
    expect(text).toContain('Carol');
    expect(text).toContain('Sprint 41 → Sprint 42');
    expect(text).not.toContain('Alice');
    expect(text.indexOf('Carol')).toBeLessThan(text.indexOf('Sprint 42'));
  });

  it('reads every page before filtering, so the newest entries are really the newest', async () => {
    const long = Array.from({ length: 250 }, (_unused, index) =>
      statusChange(
        String(index),
        new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
        'Alice',
        `S${index}`,
        `S${index + 1}`
      )
    );
    serve(long);
    const text = textOf(
      await (
        await historyTool()
      )({ issueKey: 'PROJ-9', newestFirst: true, maxResults: 1 })
    );

    expect(requestedUrls).toHaveLength(3);
    expect(requestedUrls.map((url) => new URL(url).searchParams.get('startAt'))).toEqual([
      '0',
      '100',
      '200',
    ]);
    expect(text).toContain('status: S249 → S250');
  });

  it('says so when the history runs past the ceiling it reads', async () => {
    serve(
      Array.from({ length: HISTORY_CEILING + 1 }, (_unused, index) =>
        statusChange(String(index), '2026-01-01T00:00:00.000Z', 'Alice', 'a', 'b')
      )
    );
    const text = textOf(await (await historyTool())({ issueKey: 'PROJ-9' }));
    expect(requestedUrls).toHaveLength(HISTORY_CEILING / 100);
    expect(text).toContain(`longer than the ${HISTORY_CEILING} entries this tool reads`);
  });

  it('reports an empty history plainly', async () => {
    serve([]);
    const result = await (await historyTool())({ issueKey: 'PROJ-1' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('PROJ-1 has 0 changes.');
    expect(textOf(result)).not.toContain('Presentation hint');
  });

  it('surfaces the Jira error message on a failed call', async () => {
    requestedUrls = [];
    jiraFetchMock.mockReset();
    jiraFetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        message: 'Issue does not exist or you do not have permission to see it.',
      }),
    });
    const result = await (await historyTool())({ issueKey: 'NOPE-1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Issue does not exist');
  });

  it('requires an issue key', async () => {
    serve(history);
    const result = await (await historyTool())({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('issueKey is required');
  });
});

describe('parseHistoryEntry', () => {
  it('names an automation actor when there is no author', () => {
    const entry = parseHistoryEntry({
      id: '9',
      created: '2026-09-01T09:00:00.000+0000',
      historyMetadata: { type: 'automation', actor: { displayName: 'Automation for Jira' } },
      items: [{ field: 'labels', fieldId: 'labels', from: null, to: null, toString: 'triaged' }],
    });
    expect(entry?.author).toBe('Automation for Jira');
    expect(entry?.changes[0]).toEqual({
      field: 'labels',
      fieldId: 'labels',
      from: '(none)',
      to: 'triaged',
    });
  });

  it('flattens and clips a long multi-line value', () => {
    const entry = parseHistoryEntry({
      id: '10',
      created: '2026-09-01T09:00:00.000+0000',
      author: { displayName: 'Alice' },
      items: [
        {
          field: 'description',
          fieldId: 'description',
          fromString: 'first line\nsecond line',
          toString: 'x'.repeat(300),
        },
      ],
    });
    expect(entry?.changes[0].from).toBe('first line ⏎ second line');
    expect(entry?.changes[0].to).toHaveLength(201);
    expect(entry?.changes[0].to.endsWith('…')).toBe(true);
  });

  it('keeps an unparseable timestamp rather than inventing one', () => {
    const entry = parseHistoryEntry({ id: '11', created: 'whenever', items: [] });
    expect(entry?.at).toBe('whenever');
    expect(Number.isNaN(entry?.atMillis)).toBe(true);
    expect(entry?.author).toBe('Unknown');
  });
});
