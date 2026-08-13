/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The SharePoint and OneDrive tool surface, against a stubbed Graph.
 *
 * The scope-map test at the bottom is the important one: withScopeGate
 * filters at REGISTRATION, so a write tool missing from its scopes.ts switch
 * falls to the read default and gets registered for users who should not
 * have it — a silent under-gating with no error anywhere.
 */

jest.mock('@renkei/provider-grants', () => ({
  getGrant: jest.fn(async () => ({
    ok: true,
    val: {
      accessToken: 'token-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      metadata: { upn: 'alice@example.com', tid: 'tid-1' },
    },
  })),
  refreshGrantTokens: jest.fn(),
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
jest.mock('@/lib/microsoft-app', () => ({ getMicrosoftApp: jest.fn(async () => null) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../content-watches', () => ({
  upsertWatch: jest.fn(async () => ({ ok: true, created: true })),
  disableWatch: jest.fn(async () => ({ ok: true, found: true })),
  listWatches: jest.fn(async () => ({ ok: true, watches: [] })),
  watchLine: () => 'line',
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerSharePointTools } from './index';
import { registerOneDriveTools } from '../onedrive';
import { sharepointScopeFor } from './scopes';
import { onedriveScopeFor } from '../onedrive/scopes';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

interface Route {
  match: string;
  body?: unknown;
  status?: number;
}

let routes: Route[] = [];
let requests: { url: string; method: string; body: string | null }[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  routes = [];
  requests = [];
  global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
    }
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const context = (): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    subject: 'subject-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
  }) as unknown as MCPToolContext;

async function toolsOf(
  register: (server: McpServer, context: MCPToolContext) => Promise<void>
): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await register(server, context());
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

describe('sharepoint tools', () => {
  it('resolves a site URL to its Graph address before listing libraries', async () => {
    routes = [
      { match: '/sites/contoso.sharepoint.com:', body: { id: 'site-1', displayName: 'Eng' } },
      {
        match: '/drives',
        body: { value: [{ id: 'drive-1', name: 'Documents', webUrl: 'https://x/docs' }] },
      },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_list_libraries')!({
      site: 'https://contoso.sharepoint.com/sites/eng/SitePages/Home.aspx',
    });

    // The page path is not part of the site's address; only {host}:{/sites/x}.
    expect(requests[0]!.url).toContain('/sites/contoso.sharepoint.com:/sites/eng');
    expect(textOf(result)).toContain('driveId: drive-1');
  });

  it('resolves a pasted document link without knowing its site', async () => {
    routes = [
      {
        match: '/shares/u!',
        body: {
          id: 'item-1',
          name: 'plan.docx',
          parentReference: { driveId: 'drive-9' },
          webUrl: 'https://x/plan.docx',
        },
      },
      { match: '/items/item-1?', body: { id: 'item-1', name: 'plan.docx', size: 2048 } },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_get_document')!({
      itemUrl: 'https://contoso.sharepoint.com/sites/eng/Shared%20Documents/plan.docx',
    });

    expect(requests[0]!.url).toContain('/shares/u!');
    expect(textOf(result)).toContain('plan.docx');
  });

  it('names the missing scope when a pasted link cannot be resolved', async () => {
    // A bare 403 here reads as a broken tool rather than a missing grant.
    routes = [{ match: '/shares/u!', status: 403 }];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_get_document')!({ itemUrl: 'https://x/y.docx' });
    expect(textOf(result)).toContain('Files.Read.All');
  });

  it('refuses a cross-drive move and points at copy-then-delete', async () => {
    routes = [
      {
        match: '/items/item-1?',
        body: { id: 'item-1', name: 'plan.docx', parentReference: { driveId: 'drive-1' } },
      },
      {
        match: '/items/dest-1?',
        body: { id: 'dest-1', name: 'Archive', parentReference: { driveId: 'drive-2' } },
      },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_move_document')!({
      driveId: 'drive-1',
      itemId: 'item-1',
      destinationFolderId: 'dest-1',
    });

    expect(textOf(result)).toContain('cannot move across drives');
    expect(textOf(result)).toContain('sharepoint_copy_document');
  });

  it('reports a copy as queued rather than finished', async () => {
    routes = [
      {
        match: '/items/item-1?',
        body: { id: 'item-1', name: 'plan.docx', parentReference: { driveId: 'drive-1' } },
      },
      {
        match: '/items/dest-1?',
        body: { id: 'dest-1', name: 'Archive', parentReference: { driveId: 'drive-1' } },
      },
      { match: '/copy', status: 202 },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_copy_document')!({
      driveId: 'drive-1',
      itemId: 'item-1',
      destinationFolderId: 'dest-1',
    });

    // Graph copies asynchronously; claiming success would be a lie.
    expect(textOf(result)).toMatch(/queued/i);
  });

  it('creates a page with the odata type in the BODY and publishes it', async () => {
    routes = [
      { match: '/sites/contoso.sharepoint.com', body: { id: 'site-1', displayName: 'Eng' } },
      { match: '/pages', body: { id: 'page-1', webUrl: 'https://x/page' } },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_create_page')!({
      site: 'https://contoso.sharepoint.com/sites/eng',
      title: 'Release notes',
      contentHtml: '<p>Shipped.</p>',
    });

    const created = requests.find((request) => request.method === 'POST' && request.body);
    // Graph cannot infer the page kind without this and rejects the call.
    expect(JSON.parse(created!.body!)['@odata.type']).toBe('#microsoft.graph.sitePage');
    // A created page is a draft until published — the most likely
    // "it worked but nobody can see it" failure.
    expect(requests.some((request) => request.url.includes('/publish'))).toBe(true);
    expect(textOf(result)).toContain('published');
  });

  it('says plainly when an unpublished page is invisible to others', async () => {
    routes = [
      { match: '/sites/contoso.sharepoint.com', body: { id: 'site-1', displayName: 'Eng' } },
      { match: '/pages', body: { id: 'page-1' } },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_create_page')!({
      site: 'https://contoso.sharepoint.com/sites/eng',
      title: 'Draft',
      publish: false,
    });

    expect(textOf(result)).toContain('NOT visible');
    expect(requests.some((request) => request.url.includes('/publish'))).toBe(false);
  });

  it('reads page text and names the web parts it could not extract', async () => {
    routes = [
      { match: '/sites/contoso.sharepoint.com', body: { id: 'site-1', displayName: 'Eng' } },
      {
        match: '/pages/page-1/microsoft.graph.sitePage',
        body: {
          title: 'Runbook',
          webUrl: 'https://x/runbook',
          canvasLayout: {
            horizontalSections: [
              {
                columns: [
                  {
                    webparts: [
                      { innerHtml: '<p>Restart the <b>worker</b>.</p>' },
                      { webPartType: 'd1d91016-032f-456d-98a4-721247c305e8' },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_read_page')!({
      site: 'https://contoso.sharepoint.com/sites/eng',
      pageId: 'page-1',
    });

    expect(textOf(result)).toContain('Restart the worker.');
    // Silently summarizing half a page is worse than saying what was missed.
    expect(textOf(result)).toContain('Not extracted');
  });

  it('surfaces internal column names, which metadata writes require', async () => {
    routes = [
      {
        match: '/list/columns',
        body: {
          value: [
            { name: 'DocStatus', displayName: 'Document Status', choice: { choices: ['Draft'] } },
            { name: '_Hidden', displayName: 'Hidden' },
          ],
        },
      },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_list_columns')!({ driveId: 'drive-1' });
    expect(textOf(result)).toContain('internal name: DocStatus');
    expect(textOf(result)).not.toContain('_Hidden');
  });

  it('watches a library under its resolved driveId, never the raw input', async () => {
    routes = [
      { match: '/sites/contoso.sharepoint.com', body: { id: 'site-1', displayName: 'Eng' } },
      { match: '/drive?', body: { id: 'drive-1', name: 'Documents' } },
    ];
    const { upsertWatch } = jest.requireMock<{ upsertWatch: jest.Mock }>('../content-watches');
    const tools = await toolsOf(registerSharePointTools);

    await tools.get('sharepoint_watch_library')!({
      site: 'https://contoso.sharepoint.com/sites/eng',
    });

    // An unresolvable scope would otherwise become a watch that fails
    // silently in the background forever.
    expect(upsertWatch).toHaveBeenCalledWith(
      expect.anything(),
      'sharepoint',
      'drive',
      'drive-1',
      'Eng / Documents'
    );
  });
});

describe('onedrive tools', () => {
  it('defaults to the caller’s own drive without being told', async () => {
    routes = [
      { match: '/me/drive?', body: { id: 'my-drive' } },
      { match: '/root?', body: { id: 'root-1', name: 'root', parentReference: {} } },
      { match: '/children', body: { value: [{ id: 'f1', name: 'notes.txt', size: 12 }] } },
    ];
    const tools = await toolsOf(registerOneDriveTools);

    const result = await tools.get('onedrive_list_folder')!({});
    expect(requests[0]!.url).toContain('/me/drive');
    expect(textOf(result)).toContain('notes.txt');
  });

  it('rejects an upload past the simple-upload ceiling instead of truncating', async () => {
    routes = [
      { match: '/me/drive?', body: { id: 'my-drive' } },
      { match: '/root?', body: { id: 'root-1', name: 'root', parentReference: {} } },
    ];
    const tools = await toolsOf(registerOneDriveTools);

    const result = await tools.get('onedrive_upload_document')!({
      filename: 'big.bin',
      contentBase64: Buffer.alloc(5 * 1024 * 1024).toString('base64'),
    });

    expect(textOf(result)).toContain('4 MB');
  });
});

describe('scope maps', () => {
  /**
   * Every registered tool must appear in its namespace's switch. A missing
   * write tool silently inherits the read default and registers for users who
   * should not have it — no error, no 403, just a tool that should not be there.
   */
  it('gates every sharepoint write tool explicitly', async () => {
    const tools = await toolsOf(registerSharePointTools);
    const writeTools = [...tools.keys()].filter((name) =>
      /_(create|update|delete|upload|rename|move|copy|share|add|remove|publish|watch|unwatch)_/.test(
        name
      )
    );
    expect(writeTools.length).toBeGreaterThan(5);
    for (const name of writeTools) {
      const scopes = sharepointScopeFor(name);
      // Watch tools legitimately need only read; everything else must be
      // named in the switch and land on a write or membership scope.
      if (name.includes('watch')) continue;
      expect(scopes.some((scope) => /ReadWrite/.test(scope))).toBe(true);
    }
  });

  it('gates every onedrive write tool explicitly', async () => {
    const tools = await toolsOf(registerOneDriveTools);
    const writeTools = [...tools.keys()].filter((name) =>
      /_(create|update|delete|upload|rename|move|copy|share|add|remove)_/.test(name)
    );
    expect(writeTools.length).toBeGreaterThan(5);
    for (const name of writeTools) {
      expect(onedriveScopeFor(name)).toContain('Files.ReadWrite');
    }
  });

  it('keeps cross-drive reads on the broader scope', () => {
    expect(onedriveScopeFor('onedrive_list_shared_with_me')).toEqual(['Files.Read.All']);
    expect(onedriveScopeFor('onedrive_list_folder')).toEqual(['Files.Read']);
  });
});
