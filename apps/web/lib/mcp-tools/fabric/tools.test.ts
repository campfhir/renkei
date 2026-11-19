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

// The code project side: a GitHub project the person edits, and what a
// pull request would carry (lib/fabric/repo.ts is tested on its own).
const proposed: { files: { path: string; text: string }[]; base: string; title: string }[] = [];
const pipelineWrites: unknown[] = [];
jest.mock('@/lib/fabric/repo', () => ({
  resolveRepoProject: jest.fn(async (_subject: string, ref: string) =>
    ref === 'Sales repo' || ref === '99999999-9999-4999-8999-999999999999'
      ? {
          host: 'github',
          project: {
            id: '99999999-9999-4999-8999-999999999999',
            name: 'Sales repo',
            repo: { provider: 'github', fullName: 'acme/sales', branch: 'main' },
          },
        }
      : `No code project named "${ref}" that you can open.`
  ),
  proposalBase: jest.fn(async (_project: unknown, asked?: string) => asked ?? 'develop'),
  proposalBranch: () => 'renkei/fabric/test',
  existingLogicalId: jest.fn(async (_c: unknown, _r: unknown, _b: string, path: string) =>
    path === 'fabric/Load orders.Notebook/.platform' ? 'kept-logical-id' : null
  ),
  proposeFiles: jest.fn(
    async (_caller: unknown, _repo: unknown, proposal: (typeof proposed)[number]) => {
      proposed.push(proposal);
      return {
        ok: true,
        url: 'https://github.com/acme/sales/pull/7',
        branch: 'renkei/fabric/test',
      };
    }
  ),
}));
jest.mock('@/lib/fabric/pipeline', () => ({
  ...jest.requireActual('@/lib/fabric/pipeline'),
  fabricBlockVersions: jest.fn(async () => ({ validate: 1, deploy: 1 })),
  savedSpec: jest.fn(async () => ({
    checks: [],
    environments: [{ name: 'dev', branch: 'develop', steps: [] }],
  })),
  writeFabricPipeline: jest.fn(async (_c: unknown, _r: unknown, plan: unknown) => {
    pipelineWrites.push(plan);
    return {
      ok: true,
      url: 'https://github.com/acme/sales/pull/8',
      branch: 'renkei/pipeline',
      updated: false,
      text: '',
    };
  }),
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
  it('a browse-only grant gets the reads and the pull-request tools, no definitions', async () => {
    const names = [...(await tools(['Workspace.Read.All', 'Item.Read.All'])).keys()].sort();
    expect(names).toEqual([
      'fabric_check_access',
      'fabric_export_items_confirm',
      'fabric_export_items_preview',
      'fabric_get_operation',
      'fabric_get_workspace',
      'fabric_list_items',
      'fabric_list_workspaces',
      'fabric_propose_items_confirm',
      'fabric_propose_items_preview',
      'fabric_setup_pipeline_confirm',
      'fabric_setup_pipeline_preview',
    ]);
  });

  it('the full grant gets every read and definition, and nothing writes to Fabric directly', async () => {
    const names = [...(await tools()).keys()];
    expect(names).toEqual(
      expect.arrayContaining([
        'fabric_list_tables',
        'fabric_list_capacities',
        'fabric_get_notebook_definition',
        'fabric_get_pipeline_definition',
      ])
    );
    expect(names.filter((name) => /^fabric_(create|update)_/.test(name))).toEqual([]);
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

describe('changes are pull requests', () => {
  beforeEach(() => {
    proposed.length = 0;
    pipelineWrites.length = 0;
  });

  it('a new notebook is previewed as the folder it becomes, and refused when it is not a notebook', async () => {
    const preview = await call('fabric_propose_items_preview', {
      project: 'Sales repo',
      items: [{ type: 'Notebook', displayName: 'Daily load', content: IPYNB }],
    });
    expect(preview.structuredContent).toMatchObject({
      action: 'Propose Fabric change',
      confirmTool: 'fabric_propose_items_confirm',
      groupLists: [
        {
          label: 'Items',
          groups: ['New fabric/Daily load.Notebook/ — notebook, 2 cell(s), 1 code'],
        },
      ],
      confirmArgs: { projectId: '99999999-9999-4999-8999-999999999999', base: 'develop' },
    });
    expect(requests).toEqual([]);
    expect(proposed).toEqual([]);

    const refused = await call('fabric_propose_items_preview', {
      project: 'Sales repo',
      items: [{ type: 'Notebook', displayName: 'Broken', content: '{"cells": "no"}' }],
    });
    expect(refused.isError).toBe(true);
  });

  it('the confirm commits Fabric’s git format, keeping a replaced item’s logical id, and never calls Fabric', async () => {
    const result = await call('fabric_propose_items_confirm', {
      projectId: '99999999-9999-4999-8999-999999999999',
      base: 'develop',
      itemsDirectory: 'fabric',
      items: [{ type: 'Notebook', displayName: 'Load orders', content: IPYNB }],
    });
    expect(text(result)).toMatch(
      /^Opened a pull request into develop with Load orders: https:\/\/github.com\/acme\/sales\/pull\/7/
    );
    expect(proposed).toHaveLength(1);
    const files = proposed[0].files;
    expect(files.map((f) => f.path)).toEqual([
      'fabric/Load orders.Notebook/notebook-content.py',
      'fabric/Load orders.Notebook/.platform',
    ]);
    expect(files[0].text.startsWith('# Fabric notebook source')).toBe(true);
    expect(JSON.parse(files[1].text).config.logicalId).toBe('kept-logical-id');
    expect(requests).toEqual([]);
  });

  it('exporting reads each definition in Fabric’s git format and proposes it', async () => {
    fabric[`POST /workspaces/${WS}/notebooks/${NB}/getDefinition?format=fabricGitSource`] = [
      {
        status: 200,
        body: {
          definition: {
            parts: [
              {
                path: 'notebook-content.py',
                payload: b64('# Fabric notebook source\n'),
                payloadType: 'InlineBase64',
              },
              {
                path: '.platform',
                payload: b64('{"config":{"logicalId":"from-fabric"}}'),
                payloadType: 'InlineBase64',
              },
            ],
          },
        },
      },
    ];
    const preview = await call('fabric_export_items_preview', {
      workspace: 'Sales',
      items: [{ type: 'Notebook', item: 'Load orders' }],
      project: 'Sales repo',
    });
    expect(preview.structuredContent).toMatchObject({
      groupLists: [{ groups: ['Replaces fabric/Load orders.Notebook/ — from “Sales”'] }],
    });
    const confirmArgs = preview.structuredContent?.confirmArgs as Record<string, unknown>;
    const result = await call('fabric_export_items_confirm', confirmArgs);
    expect(text(result)).toMatch(
      /^Opened a pull request into develop with Load orders from “Sales”/
    );
    expect(proposed[0].files.map((f) => f.path)).toEqual([
      'fabric/Load orders.Notebook/notebook-content.py',
      'fabric/Load orders.Notebook/.platform',
    ]);
  });

  it('workspaces go through the pipeline: an environment’s workspace and capacity become its deploy step', async () => {
    fabric['GET /capacities'] = [
      {
        status: 200,
        body: { value: [{ id: CAP, displayName: 'F64 West', sku: 'F64', region: 'West US' }] },
      },
    ];
    const preview = await call('fabric_setup_pipeline_preview', {
      project: 'Sales repo',
      environments: [
        { name: 'dev', workspaceName: 'Sales (dev)', capacity: 'F64 West' },
        { name: 'production', branch: 'main', workspaceName: 'Sales', existingWorkspace: 'Sales' },
      ],
    });
    expect(preview.structuredContent).toMatchObject({
      action: 'Set up Fabric deployment',
      confirmArgs: {
        environments: [
          { name: 'dev', workspaceName: 'Sales (dev)', capacityId: CAP },
          { name: 'production', branch: 'main', workspaceName: 'Sales', workspaceId: WS },
        ],
      },
    });
    const confirmArgs = preview.structuredContent?.confirmArgs as Record<string, unknown>;
    const result = await call('fabric_setup_pipeline_confirm', confirmArgs);
    expect(text(result)).toMatch(
      /^Opened the pipeline’s pull request: https:\/\/github.com\/acme\/sales\/pull\/8/
    );
    const plan = pipelineWrites[0] as {
      spec: { checks: unknown[]; environments: { name: string; steps: unknown[] }[] };
    };
    expect(plan.spec.checks).toEqual([
      { block: 'fabric-validate', version: 1, inputs: { items_directory: 'fabric' } },
    ]);
    expect(plan.spec.environments.map((e) => [e.name, e.steps])).toEqual([
      [
        'dev',
        [
          {
            block: 'fabric-deploy',
            version: 1,
            inputs: { workspace_name: 'Sales (dev)', items_directory: 'fabric', capacity_id: CAP },
          },
        ],
      ],
      [
        'production',
        [
          {
            block: 'fabric-deploy',
            version: 1,
            inputs: { workspace_name: 'Sales', items_directory: 'fabric', workspace_id: WS },
          },
        ],
      ],
    ]);
    // Workspaces were only read: nothing was created or renamed in Fabric.
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('a project the person cannot change is refused before any card', async () => {
    const result = await call('fabric_propose_items_preview', {
      project: 'Someone else’s',
      items: [{ type: 'Notebook', displayName: 'X', content: IPYNB }],
    });
    expect(result.isError).toBe(true);
  });
});
