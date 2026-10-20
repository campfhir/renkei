/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Chat is offered a preview card in place of every act tool of an external
 * system (tool-surface.ts's previewRouting). That is only true if every such
 * tool HAS one, so this runs the real registration for every connector —
 * through the same enumeration the tools page uses, with every scope
 * granted, plus Mirth and ADManager registered directly like their own
 * suites do — and fails naming any act tool that has neither a hand-written
 * preview nor a builder in this directory.
 *
 * A new act tool therefore arrives with its card, or this test says which
 * one is missing. The reverse holds too: a builder for a tool that no
 * longer exists is dead code, and is named.
 */

const fetchSpy = jest.fn();

jest.mock('kysely', () => ({
  sql: Object.assign(() => ({ as: () => ({}) }), {
    raw: () => ({}),
    join: () => ({}),
    ref: () => ({}),
    lit: () => ({}),
  }),
}));

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  },
  secure: (value: unknown) => value,
}));

// Every provider has a grant with every scope the file-and-mail tools need;
// the scope gates are bypassed below so the whole surface registers.
const GRANT = {
  provider_account_id: 'acct-1',
  requested_scopes: ['x', 'Mail.ReadWrite', 'Sites.ReadWrite.All', 'Files.ReadWrite.All'],
  granted_scopes: null,
};

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({
    ok: true,
    val: {
      selectFrom: (table: string) => {
        if (table === 'file_share_connections') {
          const shareChain = {
            innerJoin: () => shareChain,
            select: () => shareChain,
            where: () => shareChain,
            execute: async () => [{ tool_access: 'read_write', allow_delete: true }],
          };
          return shareChain;
        }
        const chain = {
          select: () => chain,
          where: () => chain,
          limit: () => chain,
          executeTakeFirst: async () => GRANT,
        };
        return chain;
      },
    },
  }),
}));

jest.mock('@renkei/settings', () => ({
  getOrgSettings: async () => ({
    ok: true,
    val: {
      readOnly: false,
      disabledConnectors: [],
      maxJqlResults: 50,
      maxAttachmentBytes: 1_000_000,
    },
  }),
}));

jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: async () => null,
  searchKnowledge: jest.fn(),
  listRecentKnowledge: jest.fn(),
}));

jest.mock('@/lib/mcp-tools/web-search', () => ({
  ...jest.requireActual('@/lib/mcp-tools/web-search'),
  webSearchConfigured: async () => false,
}));

jest.mock('@/lib/mcp-tools/capability-gate', () => ({
  ...jest.requireActual('@/lib/mcp-tools/capability-gate'),
  withScopeGate: (server: unknown) => server,
}));

jest.mock('@/lib/mirth/service-client', () => ({ mirthApi: jest.fn() }));
jest.mock('@/lib/admanager/service-client', () => ({ admanagerApi: jest.fn() }));

import type { McpServer } from '@modelcontextprotocol/server';
import { MIRTH_PERMISSION_IDS } from '@renkei/connector-mirth';
import { ADMANAGER_PERMISSION_IDS } from '@renkei/connector-admanager';
import { listAvailableTools, invalidateToolCatalogCache } from '../tool-catalog';
import { needsPreview, previewTwinOf } from '../act-preview';
import { registerMirthTools } from '../mirth';
import { NO_SUCH_INSTANCE as NO_MIRTH_INSTANCE } from '../mirth/mirth-auth';
import { registerAdManagerTools } from '../admanager';
import { NO_SUCH_INSTANCE as NO_ADMANAGER_INSTANCE } from '../admanager/admanager-auth';
import type { MCPToolContext } from '../common';
import { PREVIEW_BUILDERS } from '.';

type Config = Parameters<McpServer['registerTool']>[1];

const INSTANCE_ID = '11111111-2222-3333-4444-555555555555';
const context = { subject: 'subject-1' } as unknown as MCPToolContext;

function collecting() {
  const tools = new Map<string, Config>();
  const server = {
    registerTool: (name: string, config: Config) => {
      tools.set(name, config);
    },
  } as unknown as McpServer;
  return { server, tools };
}

function instanceFor(extra: Record<string, unknown>, connection: Record<string, unknown>) {
  return {
    kind: 'user' as const,
    target: () => ({ subject: 'subject-1' }),
    listConnected: async () => [
      {
        instance: {
          id: INSTANCE_ID,
          name: 'Prod',
          environment: 'prod',
          baseUrl: 'https://example:8443',
          tlsVerify: true,
          hasCustomCa: false,
          allowInsecureHttp: false,
          enabled: true,
          ...extra,
        },
        connection,
      },
    ],
  };
}

function mirthTools(): Map<string, Config> {
  const { server, tools } = collecting();
  const connection = { username: 'alice', permissions: [...MIRTH_PERMISSION_IDS] };
  registerMirthTools(
    server,
    context,
    {
      ...instanceFor({}, connection),
      connection: async (id: string) => (id === INSTANCE_ID ? connection : NO_MIRTH_INSTANCE),
    } as never,
    { permissions: connection.permissions }
  );
  return tools;
}

function admanagerTools(): Map<string, Config> {
  const { server, tools } = collecting();
  const connection = { technicianName: 'alice', permissions: [...ADMANAGER_PERMISSION_IDS] };
  registerAdManagerTools(
    server,
    context,
    {
      ...instanceFor({ resetPasswordTemplateName: 'Reset Password Template' }, connection),
      connection: async (id: string) => (id === INSTANCE_ID ? connection : NO_ADMANAGER_INSTANCE),
    } as never,
    { permissions: connection.permissions }
  );
  return tools;
}

beforeEach(() => {
  fetchSpy.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
  invalidateToolCatalogCache();
});

/**
 * Every tool of the real registration, minus the preview/confirm pairs this
 * layer itself generated — those would make "has a preview" true of
 * everything with a builder, which is the thing under test.
 */
async function surface() {
  const catalog = await listAvailableTools('subject-1');
  const generated = new Set(
    catalog.flatMap((tool) => (tool.previewOf ? [tool.name, `${tool.previewOf}_confirm`] : []))
  );
  const configs = new Map<string, Config>();
  for (const tool of catalog) {
    if (generated.has(tool.name)) continue;
    configs.set(tool.name, {
      title: tool.title ?? undefined,
      annotations: { readOnlyHint: tool.kind === 'read' },
      ...(tool.appOnly ? { _meta: { ui: { visibility: ['app'] } } } : {}),
    });
  }
  for (const [name, config] of [...mirthTools(), ...admanagerTools()]) configs.set(name, config);
  return configs;
}

describe('act tool preview coverage', () => {
  it('registers the connectors this test exists to cover', async () => {
    const configs = await surface();
    const names = [...configs.keys()];
    for (const prefix of [
      'jira_',
      'jsm_',
      'confluence_',
      'bitbucket_',
      'github_',
      'outlook_',
      'onedrive_',
      'sharepoint_',
      'zoom_',
      'webex_',
      'onbase_',
      'mirth_',
      'admanager_',
      'entra_',
      'fileshare_',
    ]) {
      expect(names.some((name) => name.startsWith(prefix))).toBe(true);
    }
  });

  it('gives every act tool of an external system a preview — a hand-written one or a builder here', async () => {
    const configs = await surface();
    const names = new Set(configs.keys());
    const missing = [...configs]
      .filter(([name, config]) => needsPreview(name, config))
      .map(([name]) => name)
      .filter(
        (name) => previewTwinOf(name, names) === null && PREVIEW_BUILDERS[name] === undefined
      );
    expect(missing).toEqual([]);
  });

  it('has no builder for a tool that does not exist', async () => {
    const configs = await surface();
    const dead = Object.keys(PREVIEW_BUILDERS).filter((name) => !configs.has(name));
    expect(dead).toEqual([]);
  });

  it('has no builder for a tool that already has a hand-written preview', async () => {
    const configs = await surface();
    const names = new Set(
      [...configs.keys()].filter((name) => !(name in PREVIEW_BUILDERS) || name.endsWith('_preview'))
    );
    const shadowed = Object.keys(PREVIEW_BUILDERS).filter(
      (name) => previewTwinOf(name, names) !== null
    );
    expect(shadowed).toEqual([]);
  });
});
