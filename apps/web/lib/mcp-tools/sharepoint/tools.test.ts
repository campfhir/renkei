/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The SharePoint and OneDrive tool surface, against a stubbed Graph.
 *
 * The scope-map test at the bottom is the important one: withScopeGate
 * filters at REGISTRATION, so a write tool missing from its scopes.ts switch
 * falls to the read default and gets registered for users who should not
 * have it — a silent under-gating with no error anywhere.
 */

jest.mock('@renkei/provider-grants', () => ({ MICROSOFT: 'microsoft' }));
// The delegate, standing in: `describe` answers the one grant these suites
// need, and the fetcher it hands out sends through global fetch (the Graph
// stub each test installs) — with no Authorization of its own, since the
// real delegate attaches that on its side of the wire.
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
jest.mock('@renkei/db', () => ({
  ...jest.requireActual('@renkei/db'),
  // The upload-slot write a *_request_*_upload tool makes.
  getDataStore: () => ({ uploadSlots: { create: async () => undefined } }),
}));
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
import { oauthGraphAuth, type GraphAuth } from '../graph/graph-auth';
import type { MCPToolContext } from '../common';

const { grantFetch: mockGrantFetch } = jest.requireMock<{ grantFetch: jest.Mock }>(
  '@renkei/delegate-client'
);

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

interface Route {
  match: string;
  body?: unknown;
  status?: number;
}

let routes: Route[] = [];
let requests: {
  url: string;
  method: string;
  body: string | null;
  authorization: string | null;
}[] = [];

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
      authorization: new Headers(init?.headers).get('authorization'),
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
    accountId: 'acct-1',
    subject: 'subject-1',
    origin: 'https://renkei.example',
    siteUrl: '',
    apiBaseUrl: '',
    maxJqlResults: 100,
  }) as unknown as MCPToolContext;

async function toolsOf(
  register: (server: McpServer, context: MCPToolContext, auth: GraphAuth) => Promise<void>
): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const ctx = context();
  // oauthGraphAuth, not a stub: this file already mocks the delegate client
  // to make resolveGraphAccess resolve deterministically (see the top of this
  // file), so the real auth wrapper is exactly what that mock was built to
  // exercise.
  await register(server, ctx, oauthGraphAuth(ctx));
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

describe('sharepoint tools', () => {
  it('sends every Graph call through the delegate fetcher, never with its own bearer', async () => {
    routes = [
      { match: '/sites/contoso.sharepoint.com:', body: { id: 'site-1', displayName: 'Eng' } },
      { match: '/drives', body: { value: [] } },
    ];
    const tools = await toolsOf(registerSharePointTools);

    await tools.get('sharepoint_list_libraries')!({
      site: 'https://contoso.sharepoint.com/sites/eng',
    });

    // The grant is named by the caller's subject; the fetcher it yields is
    // what carried the requests, and this process attached no credential.
    expect(mockGrantFetch).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'microsoft', subject: 'subject-1' })
    );
    const fetcher: jest.Mock = mockGrantFetch.mock.results[0]?.value;
    expect(fetcher).toHaveBeenCalledTimes(requests.length);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.authorization === null)).toBe(true);
  });

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

describe('reading document text', () => {
  it('extracts a Word document’s text through the pipeline', async () => {
    const { buildDocx, paragraph } = await import('@renkei/document-text/src/test-support');
    const docx = buildDocx(paragraph('The vendor agreement renews in March.'));

    routes = [
      {
        match: '/items/item-1?$select=id,name,size,file,cTag',
        body: { id: 'item-1', name: 'contract.docx', size: docx.byteLength },
      },
      {
        match: '/items/item-1?',
        body: { id: 'item-1', name: 'contract.docx', parentReference: { driveId: 'drive-1' } },
      },
    ];
    // graphDownload fetches metadata then the pre-authenticated URL; without
    // a downloadUrl it falls back to /content, which this stub answers.
    const tools = await toolsOf(registerSharePointTools);
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/content')) {
        // Buffer, not the raw Uint8Array: TS will not accept a
        // Uint8Array<ArrayBufferLike> as a BodyInit.
        return new Response(Buffer.from(docx), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      if (url.includes('$select=id,name,size,file,cTag')) {
        return new Response(
          JSON.stringify({ id: 'item-1', name: 'contract.docx', size: docx.byteLength }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          id: 'item-1',
          name: 'contract.docx',
          parentReference: { driveId: 'drive-1' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const result = await tools.get('sharepoint_read_document')!({
      driveId: 'drive-1',
      itemId: 'item-1',
    });

    expect(textOf(result)).toContain('The vendor agreement renews in March.');
  });

  it('says why a document cannot be read rather than failing opaquely', async () => {
    const tools = await toolsOf(registerSharePointTools);
    // A CFB container with the encrypted marker: a password-protected file.
    const encrypted = new Uint8Array(9000);
    encrypted.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
    encrypted.set(new TextEncoder().encode('EncryptedPackage'), 600);

    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/content')) {
        return new Response(Buffer.from(encrypted), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: 'item-1',
          name: 'secret.docx',
          size: encrypted.byteLength,
          parentReference: { driveId: 'drive-1' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const result = await tools.get('sharepoint_read_document')!({
      driveId: 'drive-1',
      itemId: 'item-1',
    });

    expect(textOf(result)).toContain('password protected');
  });
});

describe('downloading the raw file', () => {
  it('returns the pre-authenticated download link with the ids restated', async () => {
    routes = [
      {
        match: 'downloadUrl',
        body: {
          id: 'item-1',
          name: 'deck.pptx',
          size: 2048,
          file: {
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          },
          '@microsoft.graph.downloadUrl': 'https://cdn.example.test/preauth?tempauth=abc',
        },
      },
      {
        match: '/items/item-1?',
        body: { id: 'item-1', name: 'deck.pptx', parentReference: { driveId: 'drive-1' } },
      },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_download_document')!({
      driveId: 'drive-1',
      itemId: 'item-1',
    });

    const text = textOf(result);
    expect(text).toContain('https://cdn.example.test/preauth?tempauth=abc');
    // The ids come back with the link so the next call needs no re-resolve.
    expect(text).toContain('driveId: drive-1');
    expect(text).toContain('itemId: item-1');
  });

  it('falls back to /content’s redirect when Graph omits the annotation', async () => {
    // Seen on items shared from another drive: the metadata answer carries
    // no @microsoft.graph.downloadUrl even though the file downloads fine.
    const tools = await toolsOf(registerSharePointTools);
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/content')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example.test/preauth?tempauth=xyz' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'item-1',
          name: 'shared.xlsx',
          size: 4096,
          parentReference: { driveId: 'drive-1' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const result = await tools.get('sharepoint_download_document')!({
      driveId: 'drive-1',
      itemId: 'item-1',
    });

    const text = textOf(result);
    expect(text).toContain('https://cdn.example.test/preauth?tempauth=xyz');
    expect(text).toContain('driveId: drive-1');
  });

  it('refuses a folder and points at listing it instead', async () => {
    routes = [
      { match: 'downloadUrl', body: { id: 'item-2', name: 'Specs', folder: {} } },
      {
        match: '/items/item-2?',
        body: { id: 'item-2', name: 'Specs', folder: {}, parentReference: { driveId: 'drive-1' } },
      },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = await tools.get('sharepoint_download_document')!({
      driveId: 'drive-1',
      itemId: 'item-2',
    });
    expect(textOf(result)).toContain('sharepoint_list_folder');
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

  it('labels listing entries with the exact parameter names the tools take', async () => {
    routes = [
      { match: '/me/drive?', body: { id: 'my-drive' } },
      { match: '/root?', body: { id: 'root-1', name: 'root', parentReference: {} } },
      { match: '/children', body: { value: [{ id: 'f1', name: 'notes.txt', size: 12 }] } },
    ];
    const tools = await toolsOf(registerOneDriveTools);

    const text = textOf(await tools.get('onedrive_list_folder')!({}));
    // `itemId:` and a header `driveId:`, matching the input schema — a listing
    // labelled `id:` leaves the follow-up call guessing which id goes where.
    expect(text).toContain('driveId: my-drive');
    expect(text).toContain('itemId: f1');
    expect(text).not.toContain('\n    id:');
  });

  it('hands out the REMOTE ids for shared items, not the local pointer', async () => {
    routes = [
      {
        match: '/sharedWithMe',
        body: {
          value: [
            {
              id: 'pointer-1',
              name: 'roadmap.xlsx',
              remoteItem: { id: 'remote-1', parentReference: { driveId: 'their-drive' } },
              createdBy: { user: { displayName: 'Casey' } },
            },
          ],
        },
      },
    ];
    const tools = await toolsOf(registerOneDriveTools);

    const text = textOf(await tools.get('onedrive_list_shared_with_me')!({}));
    // The shared entry is a pointer; only remoteItem's ids work against the
    // owner's drive. Handing out pointer-1 sends every follow-up call to 404.
    expect(text).toContain('driveId: their-drive');
    expect(text).toContain('itemId: remote-1');
    expect(text).not.toContain('pointer-1');
  });

  it('mints an out-of-band upload endpoint once the parent folder resolves', async () => {
    routes = [
      { match: '/me/drive?', body: { id: 'my-drive' } },
      { match: '/root?', body: { id: 'root-1', name: 'root', parentReference: {} } },
    ];
    const tools = await toolsOf(registerOneDriveTools);

    const result = await tools.get('onedrive_request_document_upload')!({
      filename: 'big.bin',
    });

    const text = textOf(result);
    // Both byte paths, neither of them base64 through the model: curl with
    // the bearer in the Authorization header, and the fragment-token page.
    expect(text).toContain('https://renkei.example/api/upload/');
    expect(text).toContain("-H 'Authorization: Bearer ");
    expect(text).toContain('check_file_upload');
  });

  it('fails a request against a bad parent folder before any bytes move', async () => {
    routes = [
      { match: '/me/drive?', body: { id: 'my-drive' } },
      // No stub for the folder itself → resolveDriveItem sees a 404.
    ];
    const tools = await toolsOf(registerOneDriveTools);

    const result = (await tools.get('onedrive_request_document_upload')!({
      filename: 'big.bin',
      itemId: 'missing-folder',
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('/api/upload/');
  });
});

describe('sharepoint list tools', () => {
  const SITE = 'https://contoso.sharepoint.com/sites/eng';
  const LIST_ID = '11111111-2222-4333-8444-555555555555';
  const siteRoute = {
    match: '/sites/contoso.sharepoint.com:',
    body: { id: 'site-1', displayName: 'Eng' },
  };
  const listsRoute = {
    match: '/sites/site-1/lists?',
    body: {
      value: [
        {
          id: LIST_ID,
          displayName: 'Project Tracker',
          webUrl: `${SITE}/Lists/Project Tracker`,
          list: { template: 'genericList' },
        },
        {
          id: 'lib-1',
          displayName: 'Documents',
          webUrl: `${SITE}/Shared Documents`,
          list: { template: 'documentLibrary' },
        },
        { id: 'hidden-1', displayName: 'Workflow Tasks', list: { hidden: true } },
      ],
    },
  };

  it('lists a site’s lists, marking libraries and leaving hidden ones out', async () => {
    routes = [siteRoute, listsRoute];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(await tools.get('sharepoint_list_lists')!({ site: SITE }));

    expect(text).toContain('Project Tracker (genericList)');
    expect(text).toContain('Documents (document library)');
    expect(text).not.toContain('Workflow Tasks');
  });

  it('finds a list by the title a person uses, whatever its case', async () => {
    routes = [
      siteRoute,
      {
        match: `/lists/${LIST_ID}/columns`,
        body: {
          value: [
            { name: 'Title', displayName: 'Title', text: {}, required: true },
            {
              name: 'Due_x0020_Date',
              displayName: 'Due Date',
              dateTime: {},
              indexed: true,
            },
            { name: 'Status', displayName: 'Status', choice: { choices: ['Open', 'Done'] } },
            { name: '_ModerationStatus', displayName: 'Approval', text: {} },
          ],
        },
      },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_get_list')!({ site: SITE, list: 'project tracker' })
    );

    expect(text).toContain('internal name: Due_x0020_Date');
    expect(text).toContain('dateTime, indexed');
    expect(text).toContain('choices: Open, Done');
    expect(text).not.toContain('_ModerationStatus');
  });

  it('names the lists that exist when the one asked for does not', async () => {
    routes = [siteRoute, listsRoute];
    const tools = await toolsOf(registerSharePointTools);

    const result = (await tools.get('sharepoint_get_list')!({ site: SITE, list: 'Risks' })) as {
      content: { text: string }[];
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Project Tracker');
    expect(textOf(result)).not.toContain('Workflow Tasks');
  });

  it('resolves a pasted list view URL to its list without a separate site', async () => {
    routes = [siteRoute, { match: `/lists/${LIST_ID}/items?`, body: { value: [] } }, listsRoute];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_list_items')!({
        list: `${SITE}/Lists/Project%20Tracker/AllItems.aspx`,
      })
    );

    expect(text).toBe('Project Tracker is empty.');
  });

  it('queries items with the filter as given, allowing non-indexed columns, and pages by token', async () => {
    routes = [
      siteRoute,
      {
        match: `/lists/${LIST_ID}/items?`,
        body: {
          value: [
            {
              id: '7',
              fields: {
                '@odata.etag': 'x',
                Title: 'Fix login',
                Status: 'Open',
                ContentType: 'Item',
                _UIVersionString: '1.0',
              },
            },
          ],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/sites/site-1/lists/x/items?$skiptoken=Paged%3dTRUE%26p_ID%3d7',
        },
      },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_list_items')!({
        site: SITE,
        list: 'Project Tracker',
        filter: "fields/Status eq 'Open'",
        columns: ['Status'],
        max: 10,
      })
    );

    const call = requests.find((request) => request.url.includes('/items?'))!;
    const query = new URL(call.url).searchParams;
    expect(query.get('$filter')).toBe("fields/Status eq 'Open'");
    expect(query.get('$expand')).toBe('fields($select=Title,Status)');
    expect(query.get('$top')).toBe('10');

    expect(text).toContain('Fix login');
    expect(text).toContain('itemId: 7');
    expect(text).toContain('Status: Open');
    // System fields bury what the list is for.
    expect(text).not.toContain('ContentType');
    expect(text).not.toContain('_UIVersionString');
    expect(text).not.toContain('@odata');
    // A token, never a URL a later call could be pointed elsewhere with.
    expect(text).toMatch(/pageToken: [A-Za-z0-9_-]+\n/);
    expect(text).not.toContain('graph.microsoft.com');
  });

  it('fetches the next page as Graph described it, whatever else the follow-up call says', async () => {
    routes = [
      siteRoute,
      {
        match: `/lists/${LIST_ID}/items?`,
        body: {
          value: [{ id: '7', fields: { Title: 'Fix login' } }],
          '@odata.nextLink':
            `https://graph.microsoft.com/v1.0/sites/site-1/lists/${LIST_ID}/items` +
            "?%24expand=fields&%24filter=fields%2FStatus+eq+'Open'&%24top=1&%24skiptoken=Paged%3dTRUE%26p_ID%3d7",
        },
      },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);
    const first = textOf(
      await tools.get('sharepoint_list_items')!({
        site: SITE,
        list: 'Project Tracker',
        filter: "fields/Status eq 'Open'",
        max: 1,
      })
    );
    const token = /pageToken: (\S+)/.exec(first)![1];
    requests = [];

    // The follow-up drops the filter and asks for a different page size: the
    // token alone decides, so the page stays the one Graph pointed at.
    await tools.get('sharepoint_list_items')!({
      site: SITE,
      list: 'Project Tracker',
      max: 50,
      pageToken: token,
    });

    const call = requests.find((request) => request.url.includes('/items?'))!;
    const url = new URL(call.url);
    expect(url.pathname).toBe(`/v1.0/sites/site-1/lists/${LIST_ID}/items`);
    expect(url.searchParams.get('$filter')).toBe("fields/Status eq 'Open'");
    expect(url.searchParams.get('$top')).toBe('1');
    expect(url.searchParams.get('$skiptoken')).toBe('Paged=TRUE&p_ID=7');
  });

  it('refuses another list’s pageToken, or a made-up one, and sends nothing for it', async () => {
    routes = [siteRoute, listsRoute];
    const tools = await toolsOf(registerSharePointTools);
    const otherList = Buffer.from(
      JSON.stringify({ l: 'some-other-list', q: '%24skiptoken=x' })
    ).toString('base64url');

    for (const pageToken of [otherList, 'Paged=TRUE&p_ID=7']) {
      const result = (await tools.get('sharepoint_list_items')!({
        site: SITE,
        list: 'Project Tracker',
        pageToken,
      })) as { content: { text: string }[]; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('does not belong to Project Tracker');
    }
    expect(requests.some((request) => request.url.includes('/items'))).toBe(false);
  });

  it('adds an item with its fields under `fields`, as Graph requires', async () => {
    routes = [
      siteRoute,
      {
        match: `/lists/${LIST_ID}/items`,
        body: { id: '42', fields: { Title: 'Fix login' }, webUrl: `${SITE}/Lists/x/42` },
      },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_create_list_item')!({
        site: SITE,
        list: 'Project Tracker',
        fields: { Title: 'Fix login', Status: 'Open' },
      })
    );

    const post = requests.find((request) => request.method === 'POST')!;
    expect(post.url).toContain(`/sites/site-1/lists/${LIST_ID}/items`);
    expect(JSON.parse(post.body!)).toEqual({ fields: { Title: 'Fix login', Status: 'Open' } });
    expect(text).toContain('Added "Fix login" to Project Tracker.');
    expect(text).toContain('itemId: 42');
  });

  it('refuses to add a row to a document library and sends nothing', async () => {
    routes = [siteRoute, listsRoute];
    const tools = await toolsOf(registerSharePointTools);

    const result = (await tools.get('sharepoint_create_list_item')!({
      site: SITE,
      list: 'Documents',
      fields: { Title: 'x' },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('document library');
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('changes only the named columns of an item', async () => {
    routes = [
      siteRoute,
      { match: `/lists/${LIST_ID}/items/7/fields`, body: { Title: 'Fix login', Status: 'Done' } },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_update_list_item')!({
        site: SITE,
        list: 'Project Tracker',
        itemId: '7',
        fields: { Status: 'Done' },
      })
    );

    const patch = requests.find((request) => request.method === 'PATCH')!;
    expect(JSON.parse(patch.body!)).toEqual({ Status: 'Done' });
    expect(text).toContain('Updated 1 field(s) on "Fix login" in Project Tracker: Status.');
  });

  it('refuses an update with no fields before calling Graph', async () => {
    const tools = await toolsOf(registerSharePointTools);

    const result = (await tools.get('sharepoint_update_list_item')!({
      site: SITE,
      list: 'Project Tracker',
      itemId: '7',
      fields: {},
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it('deletes an item and says when Graph refused it', async () => {
    routes = [
      siteRoute,
      { match: `/lists/${LIST_ID}/items/7`, status: 403, body: { error: 'denied' } },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);

    const result = (await tools.get('sharepoint_delete_list_item')!({
      site: SITE,
      list: 'Project Tracker',
      itemId: '7',
    })) as { content: { text: string }[]; isError?: boolean };

    expect(requests.find((request) => request.method === 'DELETE')!.url).toContain(
      `/lists/${LIST_ID}/items/7`
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The item was not deleted.');
  });
});

describe('sharepoint list schema tools', () => {
  const SITE = 'https://contoso.sharepoint.com/sites/eng';
  const LIST_ID = '11111111-2222-4333-8444-555555555555';
  const siteRoute = {
    match: '/sites/contoso.sharepoint.com:',
    body: { id: 'site-1', displayName: 'Eng' },
  };
  const listsRoute = {
    match: '/sites/site-1/lists?',
    body: {
      value: [
        {
          id: LIST_ID,
          displayName: 'Project Tracker',
          webUrl: `${SITE}/Lists/Project Tracker`,
          list: { template: 'genericList' },
        },
      ],
    },
  };
  const columnsRoute = {
    match: `/lists/${LIST_ID}/columns`,
    body: {
      value: [
        { id: 'c-title', name: 'Title', displayName: 'Title', text: {} },
        { id: 'c-created', name: 'Created', displayName: 'Created', readOnly: true },
        { id: 'c-status', name: 'Status', displayName: 'Status', choice: { choices: ['Open'] } },
        { id: 'c-due', name: 'Due_x0020_Date', displayName: 'Due Date', dateTime: {} },
      ],
    },
  };

  it('creates a list with its columns built as Graph’s type facets', async () => {
    routes = [
      siteRoute,
      {
        match: '/sites/site-1/lists',
        body: { id: 'new-list', displayName: 'Risks', webUrl: `${SITE}/Lists/Risks` },
      },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_create_list')!({
        site: SITE,
        displayName: 'Risks',
        columns: [
          { displayName: 'Severity', type: 'choice', choices: ['Low', 'High'], required: true },
          { displayName: 'Due Date', type: 'dateOnly' },
        ],
      })
    );

    const post = requests.find((request) => request.method === 'POST')!;
    expect(post.url).toContain('/sites/site-1/lists');
    expect(JSON.parse(post.body!)).toEqual({
      displayName: 'Risks',
      list: { template: 'genericList' },
      columns: [
        {
          name: 'Severity',
          displayName: 'Severity',
          required: true,
          choice: { choices: ['Low', 'High'], displayAs: 'dropDownMenu', allowTextEntry: false },
        },
        { name: 'DueDate', displayName: 'Due Date', dateTime: { format: 'dateOnly' } },
      ],
    });
    expect(text).toContain('Created the list "Risks" on Eng.');
    expect(text).toContain('internal name: DueDate');
  });

  it('refuses a half-formed column before creating anything', async () => {
    const tools = await toolsOf(registerSharePointTools);

    const result = (await tools.get('sharepoint_create_list')!({
      site: SITE,
      displayName: 'Risks',
      columns: [{ displayName: 'Severity', type: 'choice' }],
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('needs choices');
    expect(requests).toEqual([]);
  });

  it('says a name clash is the likely cause when Graph answers 409', async () => {
    routes = [siteRoute, { match: '/sites/site-1/lists', status: 409, body: {} }];
    const tools = await toolsOf(registerSharePointTools);

    const result = (await tools.get('sharepoint_create_list')!({
      site: SITE,
      displayName: 'Risks',
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('may already have a list with that name');
  });

  it('adds a column to a list found by title', async () => {
    routes = [
      siteRoute,
      { match: `/lists/${LIST_ID}/columns`, body: { id: 'c-owner', name: 'Owner' } },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_add_list_column')!({
        site: SITE,
        list: 'Project Tracker',
        column: { displayName: 'Owner', type: 'person' },
      })
    );

    const post = requests.find((request) => request.method === 'POST')!;
    expect(post.url).toContain(`/sites/site-1/lists/${LIST_ID}/columns`);
    expect(JSON.parse(post.body!)).toEqual({
      name: 'Owner',
      displayName: 'Owner',
      personOrGroup: { allowMultipleSelection: false, chooseFromType: 'peopleOnly' },
    });
    expect(text).toContain('Added a column to Project Tracker: Owner (person)');
  });

  it('removes a column named by its display name, by its id', async () => {
    routes = [siteRoute, columnsRoute, listsRoute];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_remove_list_column')!({
        site: SITE,
        list: 'Project Tracker',
        column: 'due date',
      })
    );

    const remove = requests.find((request) => request.method === 'DELETE')!;
    expect(remove.url).toContain(`/lists/${LIST_ID}/columns/c-due`);
    expect(text).toContain('Removed the column "Due Date" (internal name Due_x0020_Date)');
  });

  it('refuses to remove a built-in column, and names the ones that can go when none matches', async () => {
    routes = [siteRoute, columnsRoute, listsRoute];
    const tools = await toolsOf(registerSharePointTools);

    for (const column of ['Title', 'Created']) {
      const result = (await tools.get('sharepoint_remove_list_column')!({
        site: SITE,
        list: 'Project Tracker',
        column,
      })) as { content: { text: string }[]; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('built-in column');
    }

    const missing = textOf(
      await tools.get('sharepoint_remove_list_column')!({
        site: SITE,
        list: 'Project Tracker',
        column: 'Priority',
      })
    );
    expect(missing).toContain('Columns that can be removed: Status, Due Date.');
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
  });
});

describe('people in sharepoint list columns', () => {
  const SITE = 'https://contoso.sharepoint.com/sites/eng';
  const LIST_ID = '11111111-2222-4333-8444-555555555555';
  const USERS = '/lists/User%20Information%20List/items';
  const siteRoute = {
    match: '/sites/contoso.sharepoint.com:',
    body: { id: 'site-1', displayName: 'Eng' },
  };
  const listsRoute = {
    match: '/sites/site-1/lists?',
    body: {
      value: [
        {
          id: LIST_ID,
          displayName: 'Projects',
          webUrl: `${SITE}/Lists/Projects`,
          list: { template: 'genericList' },
        },
      ],
    },
  };
  const columnsRoute = {
    match: `/lists/${LIST_ID}/columns`,
    body: {
      value: [
        { name: 'Title', text: {} },
        { name: 'ProjectManager', displayName: 'Project Manager', personOrGroup: {} },
        { name: 'Author', displayName: 'Created By', personOrGroup: {}, readOnly: true },
        { name: 'Client', displayName: 'Client', lookup: {} },
      ],
    },
  };
  const person = (id: string, name: string, email: string) => ({
    match: `${USERS}/${id}?`,
    body: { id, fields: { Title: name, EMail: email } },
  });

  it('finds the signed-in person’s number on the site from "me"', async () => {
    routes = [
      siteRoute,
      {
        match: USERS,
        body: { value: [{ id: '18', fields: { Title: 'Alice', EMail: 'alice@example.com' } }] },
      },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_find_site_user')!({ site: SITE, person: 'me' })
    );

    // "me" is the grant's own address, looked up by exact email.
    const call = requests.find((request) => request.url.includes(USERS))!;
    expect(new URL(call.url).searchParams.get('$filter')).toBe(
      "fields/EMail eq 'alice@example.com'"
    );
    expect(text).toContain('Alice <alice@example.com>');
    expect(text).toContain('lookupId: 18');
  });

  it('says a person not yet on the site cannot be set, rather than offering another number', async () => {
    routes = [siteRoute, { match: USERS, body: { value: [] } }];
    const tools = await toolsOf(registerSharePointTools);

    const result = (await tools.get('sharepoint_find_site_user')!({
      site: SITE,
      person: "o'brien@example.com",
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not yet in Eng');
    // Exact email first, then the login name, quotes escaped for OData.
    const filters = requests
      .filter((request) => request.url.includes(USERS))
      .map((request) => new URL(request.url).searchParams.get('$filter'));
    expect(filters).toEqual([
      "fields/EMail eq 'o''brien@example.com'",
      "fields/UserName eq 'o''brien@example.com'",
    ]);
  });

  it('asks which person when a name matches several', async () => {
    routes = [
      siteRoute,
      {
        match: USERS,
        body: {
          value: [
            { id: '14', fields: { Title: 'Bryan Smith', EMail: 'bryan@example.com' } },
            { id: '22', fields: { Title: 'Bryan Ortiz', EMail: 'bortiz@example.com' } },
          ],
        },
      },
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_find_site_user')!({ site: SITE, person: 'Bryan' })
    );

    expect(text).toContain('2 people on Eng match "Bryan" — ask which one');
    const call = requests.find((request) => request.url.includes(USERS))!;
    expect(new URL(call.url).searchParams.get('$filter')).toBe("startswith(fields/Title,'Bryan')");
  });

  it('names the person beside every person-column number an item list shows', async () => {
    routes = [
      siteRoute,
      columnsRoute,
      person('14', 'Bryan Smith', 'bryan@example.com'),
      person('18', 'Alice', 'alice@example.com'),
      {
        match: `/lists/${LIST_ID}/items?`,
        body: {
          value: [
            {
              id: '93',
              fields: {
                Title: 'Rollout',
                ProjectManagerLookupId: '14',
                AuthorLookupId: '18',
                ClientLookupId: '5',
              },
            },
          ],
        },
      },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_list_items')!({ site: SITE, list: 'Projects' })
    );

    expect(text).toContain('ProjectManagerLookupId: 14 (Bryan Smith <bryan@example.com>)');
    expect(text).toContain('AuthorLookupId: 18 (Alice <alice@example.com>)');
    // A lookup to another list is not a person, and is left as it is.
    expect(text).toContain('ClientLookupId: 5\n');
    expect(requests.some((request) => request.url.includes(`${USERS}/5`))).toBe(false);
  });

  it('names the people on a single item too', async () => {
    routes = [
      siteRoute,
      columnsRoute,
      person('14', 'Bryan Smith', 'bryan@example.com'),
      {
        match: `/lists/${LIST_ID}/items/93`,
        body: { id: '93', fields: { Title: 'Rollout', ProjectManagerLookupId: '14' } },
      },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(
      await tools.get('sharepoint_get_list_item')!({ site: SITE, list: 'Projects', itemId: '93' })
    );

    expect(text).toContain('ProjectManagerLookupId: 14 (Bryan Smith <bryan@example.com>)');
  });

  it('looks nothing up when no item carries a lookup', async () => {
    routes = [
      siteRoute,
      {
        match: `/lists/${LIST_ID}/items?`,
        body: { value: [{ id: '1', fields: { Title: 'Plain' } }] },
      },
      listsRoute,
    ];
    const tools = await toolsOf(registerSharePointTools);

    await tools.get('sharepoint_list_items')!({ site: SITE, list: 'Projects' });

    expect(requests.some((request) => request.url.includes('/columns'))).toBe(false);
    expect(requests.some((request) => request.url.includes(USERS))).toBe(false);
  });

  it('shows how a person column is written when describing the list', async () => {
    routes = [siteRoute, columnsRoute, listsRoute];
    const tools = await toolsOf(registerSharePointTools);

    const text = textOf(await tools.get('sharepoint_get_list')!({ site: SITE, list: 'Projects' }));

    expect(text).toContain(
      'write as ProjectManagerLookupId: the number sharepoint_find_site_user gives'
    );
    // Created By is read-only: no write hint.
    expect(text).not.toContain('write as AuthorLookupId');
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
      expect(scopes.some((scope) => /ReadWrite|Manage/.test(scope))).toBe(true);
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

  it('puts list item writes on the write scope and list reads on the read scope', () => {
    for (const name of [
      'sharepoint_create_list_item',
      'sharepoint_update_list_item',
      'sharepoint_delete_list_item',
    ]) {
      expect(sharepointScopeFor(name)).toEqual(['Sites.ReadWrite.All']);
    }
    // A list's shape is a permission above its rows: an org can grant one alone.
    for (const name of [
      'sharepoint_create_list',
      'sharepoint_add_list_column',
      'sharepoint_remove_list_column',
    ]) {
      expect(sharepointScopeFor(name)).toEqual(['Sites.Manage.All']);
    }
    for (const name of [
      'sharepoint_list_lists',
      'sharepoint_get_list',
      'sharepoint_list_items',
      'sharepoint_find_site_user',
    ]) {
      expect(sharepointScopeFor(name)).toEqual(['Sites.Read.All']);
    }
  });

  it('keeps cross-drive reads on the broader scope', () => {
    expect(onedriveScopeFor('onedrive_list_shared_with_me')).toEqual(['Files.Read.All']);
    expect(onedriveScopeFor('onedrive_list_folder')).toEqual(['Files.Read']);
  });
});
