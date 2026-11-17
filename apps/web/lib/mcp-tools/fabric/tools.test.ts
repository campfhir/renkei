/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The fabric_ tools against a fake Fabric: which tools the grant's scopes
 * register, what a read tells the model, that a definition Fabric is slow
 * to prepare comes back as an operation to follow (and reads in full once
 * it is done), and that every write is a card first whose confirm sends
 * exactly Fabric's documented shape — on the ids the preview resolved.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../widgets', () => ({
  APP_ONLY_META: { ui: { visibility: ['app'] } },
  DIRECTORY_ACTION_PREVIEW_URI: 'ui://widget/directory-action-preview.test.html',
  confirmGuard: (tool: string) => ` Only the card invokes this; call ${tool} instead.`,
  newPreviewId: () => 'preview-1',
  previewToolMeta: (uri: string) => ({ ui: { resourceUri: uri, kind: 'approval' } }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { MCPToolContext } from '../common';
import { registerFabricTools } from './index';
import type { FabricAuth } from './fabric-auth';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const BASE = 'https://fabric.test/v1';
const ALL_SCOPES = [
  'Workspace.Read.All',
  'Item.Read.All',
  'Lakehouse.Read.All',
  'Capacity.Read.All',
  'Workspace.ReadWrite.All',
  'Notebook.ReadWrite.All',
  'DataPipeline.ReadWrite.All',
];

const WS = '11111111-1111-4111-8111-111111111111';
const WS2 = '22222222-2222-4222-8222-222222222222';
const NB = '33333333-3333-4333-8333-333333333333';
const LH = '44444444-4444-4444-8444-444444444444';
const CAP = '55555555-5555-4555-8555-555555555555';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const IPYNB = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: 'python' } },
  cells: [
    { cell_type: 'markdown', source: ['# Orders'] },
    { cell_type: 'code', source: ['df = spark.read.table("orders")'] },
  ],
});
const definition = {
  definition: {
    format: 'ipynb',
    parts: [{ path: 'notebook-content.ipynb', payload: b64(IPYNB), payloadType: 'InlineBase64' }],
  },
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
/** `METHOD path` → replies in turn (the last repeats); anything unlisted is 404. */
let fabric: Record<string, Reply[]>;
let requests: { method: string; path: string; body: unknown }[];

const stubAuth: FabricAuth = {
  kind: 'oauth',
  resolve: async () => ({
    fetcher: (url, init) => fetch(url, init),
    base: BASE,
    accountId: 'oid-me',
    upn: 'dana@contoso.com',
  }),
};

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  requests = [];
  fabric = {
    'GET /workspaces': [
      {
        status: 200,
        body: {
          value: [
            { id: WS, displayName: 'Sales', type: 'Workspace', capacityId: CAP },
            { id: WS2, displayName: 'Ops', type: 'Workspace' },
          ],
        },
      },
    ],
    [`GET /workspaces/${WS}/items?type=Notebook`]: [
      {
        status: 200,
        body: {
          value: [{ id: NB, displayName: 'Load orders', type: 'Notebook', workspaceId: WS }],
        },
      },
    ],
    [`GET /workspaces/${WS}/items?type=Lakehouse`]: [
      {
        status: 200,
        body: { value: [{ id: LH, displayName: 'Bronze', type: 'Lakehouse', workspaceId: WS }] },
      },
    ],
  };
  global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname.replace(/^\/v1/, '')}${url.search}`;
    const method = init?.method ?? 'GET';
    requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const queue = fabric[`${method} ${path}`];
    const reply = queue?.length ? (queue.length > 1 ? queue.shift() : queue[0]) : undefined;
    if (!reply) return new Response('{"errorCode":"NotFound","message":"Nope"}', { status: 404 });
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  }) as unknown as typeof fetch;
});
afterEach(() => resetDataStore());

async function tools(scopes: string[] = ALL_SCOPES): Promise<Map<string, ToolHandler>> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) =>
      handlers.set(name, handler),
  } as unknown as McpServer;
  await registerFabricTools(
    server,
    { subject: 'subject-1', origin: 'https://renkei.test', fabricScopes: scopes } as MCPToolContext,
    stubAuth
  );
  return handlers;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const handler = (await tools()).get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';

describe('registration', () => {
  it('a browse-only grant gets the reads and none of the writes', async () => {
    const names = [...(await tools(['Workspace.Read.All', 'Item.Read.All'])).keys()].sort();
    expect(names).toEqual([
      'fabric_check_access',
      'fabric_get_operation',
      'fabric_get_workspace',
      'fabric_list_items',
      'fabric_list_workspaces',
    ]);
  });

  it('the full grant gets every read, definition and write', async () => {
    const names = [...(await tools()).keys()];
    expect(names).toEqual(
      expect.arrayContaining([
        'fabric_list_tables',
        'fabric_list_capacities',
        'fabric_get_notebook_definition',
        'fabric_get_pipeline_definition',
        'fabric_create_workspace_confirm',
        'fabric_update_notebook_confirm',
        'fabric_update_pipeline_confirm',
      ])
    );
  });
});

describe('reads', () => {
  it('lists workspaces by name with their ids, narrowed by search', async () => {
    expect(text(await call('fabric_list_workspaces'))).toBe(
      `2 workspace(s):\n- Ops — id ${WS2}, no capacity\n- Sales — id ${WS}, capacity ${CAP}`
    );
    expect(text(await call('fabric_list_workspaces', { search: 'sal' }))).toMatch(/^1 workspace/);
  });

  it('refuses a name two workspaces share, naming both ids', async () => {
    fabric['GET /workspaces'] = [
      {
        status: 200,
        body: {
          value: [
            { id: WS, displayName: 'Sales' },
            { id: WS2, displayName: 'sales' },
          ],
        },
      },
    ];
    const result = await call('fabric_list_items', { workspace: 'Sales' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `More than one workspace is named "Sales"; say which by id: ${WS}, ${WS2}`
    );
  });

  it("lists a lakehouse's tables by name, format and location", async () => {
    fabric[`GET /workspaces/${WS}/lakehouses/${LH}/tables?maxResults=100`] = [
      {
        status: 200,
        body: {
          data: [
            {
              name: 'orders',
              type: 'Managed',
              format: 'Delta',
              location: 'abfss://x/Tables/orders',
            },
          ],
        },
      },
    ];
    expect(
      text(await call('fabric_list_tables', { workspace: 'Sales', lakehouse: 'Bronze' }))
    ).toBe('1 table(s) in "Bronze":\n- orders — Managed, Delta — abfss://x/Tables/orders');
  });
});

describe('reading a notebook', () => {
  const getDefinition = `POST /workspaces/${WS}/notebooks/${NB}/getDefinition?format=ipynb`;

  it('that Fabric answers at once comes back as its cells', async () => {
    fabric[getDefinition] = [{ status: 200, body: definition }];
    const result = await call('fabric_get_notebook_definition', {
      workspace: 'Sales',
      notebook: 'Load orders',
    });
    expect(text(result)).toContain('--- cell 2 (code) ---\ndf = spark.read.table("orders")');
    const [operation] = await getDataStore().fabricOperations.list('subject-1', { limit: 5 });
    expect(operation).toMatchObject({
      status: 'succeeded',
      itemName: 'Load orders',
      workspaceName: 'Sales',
    });
  });

  it('that Fabric is slow to prepare answers with the operation and its page, then reads in full later', async () => {
    fabric[getDefinition] = [
      { status: 202, headers: { 'x-ms-operation-id': 'op-1', 'Retry-After': '60' } },
    ];
    // By id: the workspace and the item are read directly, not listed.
    fabric[`GET /workspaces/${WS}`] = [{ status: 200, body: { id: WS, displayName: 'Sales' } }];
    fabric[`GET /workspaces/${WS}/items/${NB.toUpperCase()}`] = [
      {
        status: 200,
        body: { id: NB, displayName: 'Load orders', type: 'Notebook', workspaceId: WS },
      },
    ];
    const first = await call('fabric_get_notebook_definition', {
      workspace: WS,
      notebook: NB.toUpperCase(),
    });
    expect(first.isError).toBeUndefined();
    const [operation] = await getDataStore().fabricOperations.list('subject-1', { limit: 5 });
    expect(text(first)).toContain(`Operation ${operation.id}`);
    expect(text(first)).toContain(`https://renkei.test/fabric/operations/${operation.id}`);

    // Fabric finishes; the operation is due again (the lease and Retry-After passed).
    fabric['GET /operations/op-1'] = [{ status: 200, body: { status: 'Succeeded' } }];
    fabric['GET /operations/op-1/result'] = [{ status: 200, body: definition }];
    await getDataStore().fabricOperations.progress(
      operation.id,
      { percentComplete: 50, nextPollAt: new Date(Date.now() - 1000) },
      new Date()
    );
    const later = await call('fabric_get_operation', { operationId: operation.id });
    expect(text(later)).toContain('--- cell 1 (markdown) ---\n# Orders');
  });

  it('a definition fetch belongs to the person who started it', async () => {
    const stranger = await getDataStore().fabricOperations.insert({
      id: '66666666-6666-4666-8666-666666666666',
      subject: 'someone-else',
      kind: 'notebook-definition',
      workspaceId: WS,
      workspaceName: 'Sales',
      itemId: NB,
      itemName: 'Load orders',
      format: 'ipynb',
      status: 'running',
      operationId: 'op-9',
      percentComplete: null,
      result: null,
      error: null,
      nextPollAt: null,
      finishedAt: null,
      createdAt: new Date(),
    });
    const result = await call('fabric_get_operation', { operationId: stranger.id });
    expect(result.isError).toBe(true);
    expect(requests.some((r) => r.path.startsWith('/operations'))).toBe(false);
  });
});

describe('writes are cards first', () => {
  it('a new notebook is previewed with what it holds, and refused when it is not Jupyter', async () => {
    const preview = await call('fabric_create_notebook_preview', {
      workspace: 'Sales',
      displayName: 'Daily load',
      ipynb: IPYNB,
    });
    expect(preview.structuredContent).toMatchObject({
      action: 'Create notebook',
      confirmTool: 'fabric_create_notebook_confirm',
      fields: [{ label: 'Content', value: '2 cell(s): 1 code, 1 markdown/raw · python' }],
      confirmArgs: { workspaceId: WS, displayName: 'Daily load', content: IPYNB },
    });
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);

    const refused = await call('fabric_create_notebook_preview', {
      workspace: 'Sales',
      displayName: 'Broken',
      ipynb: '{"cells": "no"}',
    });
    expect(refused.isError).toBe(true);
  });

  it('creating a notebook sends its definition as Fabric takes it and follows the operation', async () => {
    fabric[`POST /workspaces/${WS}/notebooks`] = [
      { status: 202, headers: { 'x-ms-operation-id': 'op-c', 'Retry-After': '1' } },
    ];
    fabric['GET /operations/op-c'] = [{ status: 200, body: { status: 'Succeeded' } }];
    fabric['GET /operations/op-c/result'] = [
      { status: 200, body: { id: NB, displayName: 'Daily load' } },
    ];
    const result = await call('fabric_create_notebook_confirm', {
      workspaceId: WS,
      workspaceName: 'Sales',
      displayName: 'Daily load',
      description: '',
      content: IPYNB,
    });
    expect(text(result)).toMatch(
      new RegExp(`^Created notebook "Daily load" in "Sales" — id ${NB}`)
    );
    const sent = requests.find((r) => r.method === 'POST')?.body;
    expect(sent).toEqual({
      displayName: 'Daily load',
      definition: {
        format: 'ipynb',
        parts: [
          { path: 'notebook-content.ipynb', payload: b64(IPYNB), payloadType: 'InlineBase64' },
        ],
      },
    });
  });

  it('changing a notebook shows old against new and warns the content is replaced whole', async () => {
    const preview = await call('fabric_update_notebook_preview', {
      workspace: 'Sales',
      notebook: 'Load orders',
      displayName: 'Load orders v2',
      ipynb: IPYNB,
    });
    expect(preview.structuredContent).toMatchObject({
      tone: 'caution',
      confirmArgs: { workspaceId: WS, itemId: NB, displayName: 'Load orders v2', content: IPYNB },
    });
    const fields = (preview.structuredContent?.fields ?? []) as {
      label: string;
      oldValue?: string;
    }[];
    expect(fields.map((f) => f.label)).toEqual(['Name', 'Replaces', 'Content']);
    expect(fields[0].oldValue).toBe('Load orders');
  });

  it('the confirm renames, then replaces the content, on the resolved ids', async () => {
    fabric[`PATCH /workspaces/${WS}/notebooks/${NB}`] = [{ status: 200, body: { id: NB } }];
    fabric[`POST /workspaces/${WS}/notebooks/${NB}/updateDefinition`] = [{ status: 200 }];
    const result = await call('fabric_update_notebook_confirm', {
      workspaceId: WS,
      itemId: NB,
      itemName: 'Load orders',
      displayName: 'Load orders v2',
      content: IPYNB,
    });
    expect(text(result)).toMatch(
      /^Notebook "Load orders v2": renamed to "Load orders v2", content replaced\./
    );
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `PATCH /workspaces/${WS}/notebooks/${NB}`,
      `POST /workspaces/${WS}/notebooks/${NB}/updateDefinition`,
    ]);
  });

  it('a pipeline preview lists its activities; the workspace is created on the capacity named', async () => {
    const pipeline = JSON.stringify({
      properties: { activities: [{ name: 'Copy orders', type: 'Copy' }] },
    });
    const preview = await call('fabric_create_pipeline_preview', {
      workspace: 'Sales',
      displayName: 'Nightly',
      pipelineJson: pipeline,
    });
    expect(preview.structuredContent).toMatchObject({
      groupLists: [{ label: 'Activities', groups: ['Copy orders (Copy)'] }],
    });

    fabric['GET /capacities'] = [
      {
        status: 200,
        body: { value: [{ id: CAP, displayName: 'F64 West', sku: 'F64', region: 'West US' }] },
      },
    ];
    const workspacePreview = await call('fabric_create_workspace_preview', {
      displayName: 'Finance',
      capacity: 'F64 West',
    });
    expect(workspacePreview.structuredContent).toMatchObject({
      confirmArgs: { displayName: 'Finance', description: '', capacityId: CAP },
    });
    fabric['POST /workspaces'] = [{ status: 201, body: { id: WS2, displayName: 'Finance' } }];
    await call('fabric_create_workspace_confirm', {
      displayName: 'Finance',
      description: '',
      capacityId: CAP,
    });
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      displayName: 'Finance',
      capacityId: CAP,
    });
  });
});
