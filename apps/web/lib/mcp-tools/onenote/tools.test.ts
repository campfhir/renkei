/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The OneNote tool surface, against a stubbed Graph. Same harness as
 * sharepoint/tools.test.ts: the delegate client is mocked so the grant's
 * fetcher sends through global fetch, which each test answers.
 */

jest.mock('@renkei/provider-grants', () => ({ MICROSOFT: 'microsoft' }));
jest.mock('@renkei/delegate-client', () => {
  const actual =
    jest.requireActual<typeof import('@renkei/delegate-client')>('@renkei/delegate-client');
  return {
    ...actual,
    delegateGrants: () => ({
      describe: jest.fn(async () => ({
        ok: true,
        val: { accountId: 'acct-1', metadata: { upn: 'alice@example.com' } },
      })),
    }),
    grantFetch: jest.fn((ref: Parameters<typeof actual.grantKeyOf>[0]) =>
      actual.authedFetch(
        jest.fn((url: string, init?: RequestInit) => fetch(url, init)),
        actual.grantKeyOf(ref)
      )
    ),
  };
});
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@renkei/db', () => ({ getDataStore: () => ({}) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerOneNoteTools } from './index';
import { oauthGraphAuth } from '../graph/graph-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

interface Route {
  match: string;
  method?: string;
  body?: unknown;
  /** A raw (non-JSON) answer, for page content. */
  text?: string;
  status?: number;
}

let routes: Route[] = [];
let requests: { url: string; method: string; body: string | null; contentType: string | null }[] =
  [];

beforeEach(() => {
  jest.clearAllMocks();
  routes = [];
  requests = [];
  global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({
      url,
      method,
      body: typeof init?.body === 'string' ? init.body : null,
      contentType: new Headers(init?.headers).get('content-type'),
    });
    const route = routes.find(
      (candidate) => url.includes(candidate.match) && (candidate.method ?? 'GET') === method
    );
    if (!route) {
      return new Response(JSON.stringify({ error: `no stub for ${method} ${url}` }), {
        status: 404,
      });
    }
    if (route.text !== undefined) {
      return new Response(route.text, {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    // A 204 may not carry a body at all, not even an empty string.
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const context = (): MCPToolContext =>
  ({
    accountId: 'acct-1',
    subject: 'subject-1',
    origin: 'https://renkei.example',
    siteUrl: '',
    apiBaseUrl: '',
    maxJqlResults: 100,
  }) as unknown as MCPToolContext;

async function tools(): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const ctx = context();
  await registerOneNoteTools(server, ctx, oauthGraphAuth(ctx));
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

describe('onenote reads', () => {
  it('lists the caller’s notebooks by default, with links and ids', async () => {
    routes = [
      {
        match: '/me/onenote/notebooks?',
        body: {
          value: [
            {
              id: 'nb-1',
              displayName: 'Work',
              isDefault: true,
              lastModifiedDateTime: '2026-10-20T10:00:00Z',
              links: { oneNoteWebUrl: { href: 'https://onenote/work' } },
            },
          ],
        },
      },
    ];

    const result = await (await tools()).get('onenote_list_notebooks')!({});

    const text = textOf(result);
    expect(text).toContain('📓 Work (default), modified 2026-10-20');
    expect(text).toContain('https://onenote/work');
    expect(text).toContain('notebookId: nb-1');
  });

  it('reads a site’s notebooks when a site is given', async () => {
    routes = [
      { match: '/sites/contoso.sharepoint.com:', body: { id: 'site-1', displayName: 'Eng' } },
      { match: '/sites/site-1/onenote/notebooks', body: { value: [] } },
    ];

    const result = await (await tools()).get('onenote_list_notebooks')!({
      site: 'https://contoso.sharepoint.com/sites/eng',
    });

    expect(textOf(result)).toBe('No notebooks in site Eng.');
    expect(requests[1]!.url).toContain('/sites/site-1/onenote/notebooks');
  });

  it('refuses both a site and a group at once', async () => {
    const result = await (await tools()).get('onenote_list_notebooks')!({
      site: 'x',
      groupId: 'y',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not both');
  });

  it('filters sections to one notebook and names where each lives', async () => {
    routes = [
      {
        match: '/me/onenote/sections?',
        body: {
          value: [
            {
              id: 'sec-1',
              displayName: 'Meetings',
              parentNotebook: { displayName: 'Work' },
              parentSectionGroup: { displayName: '2026' },
            },
          ],
        },
      },
    ];

    const result = await (await tools()).get('onenote_list_sections')!({ notebookId: 'nb-1' });

    expect(textOf(result)).toContain('§ Meetings — in Work › 2026');
    expect(decodeURIComponent(requests[0]!.url)).toContain("$filter=parentNotebook/id eq 'nb-1'");
  });

  it('finds pages by title words within a section', async () => {
    routes = [
      {
        match: '/me/onenote/sections/sec-1/pages?',
        body: {
          value: [
            {
              id: 'p-1',
              title: 'Standup 29 Oct',
              lastModifiedDateTime: '2026-10-29T09:00:00Z',
              parentSection: { displayName: 'Meetings' },
            },
          ],
        },
      },
    ];

    const result = await (await tools()).get('onenote_list_pages')!({
      sectionId: 'sec-1',
      title: 'Standup',
    });

    expect(textOf(result)).toContain('📄 Standup 29 Oct — in Meetings, modified 2026-10-29');
    expect(textOf(result)).toContain('pageId: p-1');
    expect(decodeURIComponent(requests[0]!.url)).toContain("contains(title,'Standup')");
  });

  it('reads a page’s HTML as its title and text, naming images and files', async () => {
    routes = [
      {
        match: '/me/onenote/pages/p-1/content',
        text:
          '<html><head><title>Standup</title></head><body><div><p>Blocked on <b>auth</b></p>' +
          '<ul><li>Alice: done</li></ul><img alt="whiteboard" src="x"/>' +
          '<object data-attachment="plan.pdf" data="y" type="application/pdf"></object>' +
          '</div></body></html>',
      },
    ];

    const result = await (await tools()).get('onenote_read_page')!({ pageId: 'p-1' });

    const text = textOf(result);
    expect(text).toContain('# Standup');
    expect(text).toContain('Blocked on auth');
    expect(text).toContain('Alice: done');
    expect(text).toContain('[image: whiteboard]');
    expect(text).toContain('[file: plan.pdf]');
  });
});

describe('onenote writes', () => {
  it('creates a page from a title and Markdown as an HTML document', async () => {
    routes = [
      {
        match: '/me/onenote/sections/sec-1/pages',
        method: 'POST',
        body: { id: 'p-new', links: { oneNoteWebUrl: { href: 'https://onenote/p-new' } } },
      },
    ];

    const result = await (await tools()).get('onenote_create_page')!({
      sectionId: 'sec-1',
      title: 'Retro <notes>',
      markdown: '# Went well\n\n- Shipped',
    });

    expect(textOf(result)).toContain('Created the page “Retro <notes>” (pageId: p-new)');
    expect(textOf(result)).toContain('https://onenote/p-new');
    const sent = requests[0]!;
    expect(sent.contentType).toBe('text/html');
    expect(sent.body).toContain('<title>Retro &lt;notes&gt;</title>');
    expect(sent.body).toContain('<h1>Went well</h1>');
    expect(sent.body).toContain('<li>Shipped</li>');
  });

  it('appends to a page with a OneNote PATCH against the body', async () => {
    routes = [{ match: '/me/onenote/pages/p-1/content', method: 'PATCH', status: 204 }];

    const result = await (await tools()).get('onenote_append_to_page')!({
      pageId: 'p-1',
      markdown: 'Follow-up: **call Bob**',
    });

    expect(textOf(result)).toBe('Added to the page (at the end).');
    const patch = JSON.parse(requests[0]!.body ?? '[]');
    expect(patch[0].target).toBe('body');
    expect(patch[0].action).toBe('append');
    expect(patch[0].content).toContain('<strong>call Bob</strong>');
  });

  it('prepends when asked for the top', async () => {
    routes = [{ match: '/me/onenote/pages/p-1/content', method: 'PATCH', status: 204 }];

    await (await tools()).get('onenote_append_to_page')!({
      pageId: 'p-1',
      markdown: 'TL;DR',
      position: 'top',
    });

    expect(JSON.parse(requests[0]!.body ?? '[]')[0].action).toBe('prepend');
  });

  it('creates a section in a notebook', async () => {
    routes = [
      { match: '/me/onenote/notebooks/nb-1/sections', method: 'POST', body: { id: 'sec-9' } },
    ];

    const result = await (await tools()).get('onenote_create_section')!({
      notebookId: 'nb-1',
      name: 'Ideas',
    });

    expect(textOf(result)).toBe('Created the section “Ideas” (sectionId: sec-9).');
    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({ displayName: 'Ideas' });
  });

  it('deletes a page, in a group’s notebook when a group is named', async () => {
    routes = [{ match: '/groups/g-1/onenote/pages/p-1', method: 'DELETE', status: 204 }];

    const result = await (await tools()).get('onenote_delete_page')!({
      pageId: 'p-1',
      groupId: 'g-1',
    });

    expect(textOf(result)).toBe('Deleted the page.');
    expect(requests[0]!.method).toBe('DELETE');
  });

  it('names the missing scope on a 403 instead of a bare status', async () => {
    routes = [{ match: '/me/onenote/pages/p-1', method: 'DELETE', status: 403 }];

    const result = await (await tools()).get('onenote_delete_page')!({ pageId: 'p-1' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('403');
    expect(textOf(result)).toContain('scope');
  });
});
