/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The agents' fixed high-risk list (@renkei/agents' ALWAYS_APPROVAL_TOOLS)
 * names tools an agent run always pauses before. A name on it that no
 * module registers would be a guard that guards nothing — misspelled,
 * renamed, or removed — so every entry is held here to the tools the real
 * registration produces, through the same enumeration the tools page and
 * the agent builder use (tool-catalog.ts), with every grant the list's
 * connectors need. Mirth and ADManager have no provider grant; their
 * registration is called directly with every permission, the way their
 * own suites do.
 *
 * The mocks mirror tool-catalog.test.ts: registration performs no I/O,
 * and nothing here runs a query.
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

interface GrantRow {
  requested_scopes: string[];
  granted_scopes: string[] | null;
}

let grants: Record<string, GrantRow | undefined> = {};

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
            execute: async () => [],
          };
          return shareChain;
        }
        let provider = '';
        const chain = {
          select: () => chain,
          where: (column: string, _op: string, value: string) => {
            if (column === 'provider') provider = value;
            return chain;
          },
          limit: () => chain,
          executeTakeFirst: async () => {
            const row = grants[provider];
            return row ? { provider_account_id: 'acct-1', ...row } : undefined;
          },
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

jest.mock('@/lib/mirth/service-client', () => ({ mirthApi: jest.fn() }));
jest.mock('@/lib/admanager/service-client', () => ({ admanagerApi: jest.fn() }));

import type { McpServer } from '@modelcontextprotocol/server';
import { ALWAYS_APPROVAL_TOOLS } from '@renkei/agents';
import { MIRTH_PERMISSION_IDS } from '@renkei/connector-mirth';
import { ADMANAGER_PERMISSION_IDS } from '@renkei/connector-admanager';
import { listAvailableTools, invalidateToolCatalogCache } from './tool-catalog';
import { registerMirthTools } from './mirth';
import { NO_SUCH_INSTANCE as NO_MIRTH_INSTANCE } from './mirth/mirth-auth';
import { registerAdManagerTools } from './admanager';
import { NO_SUCH_INSTANCE as NO_ADMANAGER_INSTANCE } from './admanager/admanager-auth';
import { granularJiraScopes } from './jira/jira-auth';
import { outlookScopeFor } from './outlook';
import { webexScopeFor } from './webex';
import { onedriveScopeFor } from './onedrive/scopes';
import { sharepointScopeFor } from './sharepoint/scopes';
import { githubScopeFor } from './github/scopes';
import { bitbucketScopeFor } from './bitbucket/scopes';
import { entraScopeFor } from './entra-developer/scopes';
import type { MCPToolContext } from './common';

/** Every scope the listed tools of one connector need, as one grant row. */
function grantFor(prefixes: string[], scopeFor: (tool: string) => string[]): GrantRow {
  const scopes = new Set<string>();
  for (const tool of ALWAYS_APPROVAL_TOOLS) {
    if (prefixes.some((prefix) => tool.startsWith(prefix))) {
      for (const scope of scopeFor(tool)) scopes.add(scope);
    }
  }
  return { requested_scopes: [...scopes], granted_scopes: null };
}

const INSTANCE_ID = '11111111-2222-3333-4444-555555555555';
const context = { subject: 'subject-1' } as unknown as MCPToolContext;

function collecting(): { server: McpServer; names: string[] } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
    },
  } as unknown as McpServer;
  return { server, names };
}

/** Mirth's tools with every permission granted somewhere — the widest surface it mounts. */
function mirthToolNames(): string[] {
  const { server, names } = collecting();
  const connection = { username: 'alice', permissions: [...MIRTH_PERMISSION_IDS] };
  registerMirthTools(
    server,
    context,
    {
      kind: 'user',
      target: () => ({ subject: 'subject-1' }),
      listConnected: async () => [
        {
          instance: {
            id: INSTANCE_ID,
            name: 'Prod',
            environment: 'prod',
            baseUrl: 'https://mirth.example:8443',
            tlsVerify: true,
            hasCustomCa: false,
            allowInsecureHttp: false,
            enabled: true,
          },
          connection,
        },
      ],
      connection: async (instanceId: string) =>
        instanceId === INSTANCE_ID ? connection : NO_MIRTH_INSTANCE,
    },
    { permissions: connection.permissions }
  );
  return names;
}

/** ADManager's tools with every permission granted — same arrangement. */
function admanagerToolNames(): string[] {
  const { server, names } = collecting();
  const connection = { technicianName: 'alice', permissions: [...ADMANAGER_PERMISSION_IDS] };
  registerAdManagerTools(
    server,
    context,
    {
      kind: 'user',
      target: () => ({ subject: 'subject-1' }),
      listConnected: async () => [
        {
          instance: {
            id: INSTANCE_ID,
            name: 'Prod',
            environment: 'prod',
            baseUrl: 'https://admp.example:8080',
            tlsVerify: true,
            hasCustomCa: false,
            allowInsecureHttp: false,
            resetPasswordTemplateName: 'Reset Password Template',
            enabled: true,
          },
          connection,
        },
      ],
      connection: async (instanceId: string) =>
        instanceId === INSTANCE_ID ? connection : NO_ADMANAGER_INSTANCE,
    },
    { permissions: connection.permissions }
  );
  return names;
}

beforeEach(() => {
  grants = {
    atlassian: grantFor(['jira_'], (tool) => granularJiraScopes(tool, false)),
    microsoft: grantFor(['outlook_', 'onedrive_', 'sharepoint_'], (tool) =>
      tool.startsWith('outlook_')
        ? outlookScopeFor(tool)
        : tool.startsWith('onedrive_')
          ? onedriveScopeFor(tool)
          : sharepointScopeFor(tool)
    ),
    webex: grantFor(['webex_'], webexScopeFor),
    'atlassian-bitbucket': grantFor(['bitbucket_'], bitbucketScopeFor),
    github: grantFor(['github_'], githubScopeFor),
    'entra-developer': grantFor(['entra_'], entraScopeFor),
  };
  fetchSpy.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
  invalidateToolCatalogCache();
});

describe('the agents’ fixed high-risk tool list', () => {
  it('names only tools the registration actually produces', async () => {
    const granted = await listAvailableTools('subject-1');
    const registered = new Set([
      ...granted.map((tool) => tool.name),
      ...mirthToolNames(),
      ...admanagerToolNames(),
    ]);
    const unknown = ALWAYS_APPROVAL_TOOLS.filter((tool) => !registered.has(tool));
    expect(unknown).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('names only tools that act — a read on the list would pause for nothing', async () => {
    const granted = await listAvailableTools('subject-1');
    const kinds = new Map(granted.map((tool) => [tool.name, tool.kind]));
    const reads = ALWAYS_APPROVAL_TOOLS.filter((tool) => kinds.get(tool) === 'read');
    expect(reads).toEqual([]);
    // And none that only a card may call: a run is never offered those.
    const appOnly = new Set(granted.filter((tool) => tool.appOnly).map((tool) => tool.name));
    expect(ALWAYS_APPROVAL_TOOLS.filter((tool) => appOnly.has(tool))).toEqual([]);
  });
});
