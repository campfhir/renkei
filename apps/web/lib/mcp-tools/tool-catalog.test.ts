/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Enumerating a caller's tools.
 *
 * The page's whole claim is "these are the tools you have", so the properties
 * worth pinning are the ones that would make that claim false: a connector the
 * caller has not connected must not appear, scopes must narrow the list the
 * same way they narrow the real server, org read-only must remove mutating
 * tools, and enumeration must not reach the network — a page render is not
 * allowed to transact with anyone's provider.
 */

const fetchSpy = jest.fn();

// Kysely 0.29 ships ESM only, with no CJS build to map to, and app modules
// pulled in by registration import `sql` at module scope. Registration never
// builds a query — only handlers do — so a stub is enough to let the real
// registration code load.
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
let embeddingProvider: string | null = null;
let readOnly = false;
let disabledConnectors: string[] = [];
let fileshareGranted = false;

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({
    ok: true,
    val: {
      selectFrom: (table: string) => {
        // File shares are grant rows in Renkei's own table, not
        // provider_grants — availability is a joined existence query.
        if (table === 'file_share_grants') {
          const shareChain = {
            innerJoin: () => shareChain,
            select: () => shareChain,
            where: () => shareChain,
            limit: () => shareChain,
            executeTakeFirst: async () => (fileshareGranted ? { share_id: 'share-1' } : undefined),
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
      readOnly,
      disabledConnectors,
      maxJqlResults: 50,
      maxAttachmentBytes: 1_000_000,
    },
  }),
}));

// Stubbed rather than requireActual'd: the real module reaches kysely, whose
// published build is ESM and unparseable under this jest config. Only the
// functions registration touches are needed — handlers never run here.
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: async () => embeddingProvider,
  searchKnowledge: jest.fn(),
  listRecentKnowledge: jest.fn(),
}));

import { listAvailableTools } from './tool-catalog';

// Granular scopes, not the classic `read:jira-work` pair: the Jira tools gate
// on the granular catalog, so classic scopes would register nothing and the
// fixture would be quietly testing an empty list.
const ATLASSIAN_GRANT: GrantRow = {
  requested_scopes: [
    'read:issue:jira',
    'write:issue:jira',
    'read:user:jira',
    'read:board-scope:jira-software',
  ],
  granted_scopes: null,
};

beforeEach(() => {
  grants = { atlassian: ATLASSIAN_GRANT };
  embeddingProvider = null;
  readOnly = false;
  disabledConnectors = [];
  fileshareGranted = false;
  fetchSpy.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

const namesOf = (tools: { name: string }[]) => tools.map((tool) => tool.name);

describe('listAvailableTools', () => {
  it('omits Jira tools — but not other connectors — when Jira is not connected', async () => {
    // The scope gate registers no Jira/JSM tools for an empty scope set, and
    // Outlook's availability is its own question. The old behavior returned
    // [] outright, which would leave the agent builder claiming a Microsoft-
    // only caller has no tools at all.
    grants = {
      microsoft: { requested_scopes: ['Mail.Read', 'Mail.Send'], granted_scopes: null },
    };
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools.some((name) => name.startsWith('jira_'))).toBe(false);
    expect(tools.some((name) => name.startsWith('outlook_'))).toBe(true);
  });

  it('lists the Jira tools for a connected caller', async () => {
    const tools = await listAvailableTools('tenant-1', 'subject-1');
    expect(namesOf(tools)).toContain('jira_search_issues');
    expect(namesOf(tools)).toContain('whoami');
  });

  it('never calls out to a provider while enumerating', async () => {
    // Rendering a page must not transact with anyone's Jira, Graph or Zoom.
    await listAvailableTools('tenant-1', 'subject-1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('omits connectors the caller has not connected', async () => {
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools.some((name) => name.startsWith('outlook_'))).toBe(false);
    expect(tools.some((name) => name.startsWith('zoom_'))).toBe(false);
    expect(tools.some((name) => name.startsWith('confluence_'))).toBe(false);
  });

  it('includes Outlook once Microsoft is connected', async () => {
    grants = {
      atlassian: ATLASSIAN_GRANT,
      microsoft: { requested_scopes: ['Mail.Read', 'Mail.Send'], granted_scopes: null },
    };
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools.some((name) => name.startsWith('outlook_'))).toBe(true);
    // Mail scopes alone are not SharePoint or OneDrive — one grant, three
    // namespaces, separated by scope.
    expect(tools.some((name) => name.startsWith('sharepoint_'))).toBe(false);
    expect(tools.some((name) => name.startsWith('onedrive_'))).toBe(false);
  });

  it('adds SharePoint and OneDrive on the scopes that back them', async () => {
    grants = {
      atlassian: ATLASSIAN_GRANT,
      microsoft: {
        requested_scopes: ['Mail.Read', 'Sites.Read.All', 'Files.Read.All'],
        granted_scopes: null,
      },
    };
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools.some((name) => name.startsWith('sharepoint_'))).toBe(true);
    expect(tools.some((name) => name.startsWith('onedrive_'))).toBe(true);
  });

  it('gates the JSM family on the second Atlassian app grant, like the MCP route', async () => {
    // Post-split, the JSM scopes live on the "Renkei JSM" grant, not the main
    // one. A catalog that only reads the main grant silently drops every
    // jsm_* tool from the agent builder while the live server still serves
    // them — the exact drift this module exists to prevent.
    grants = {
      atlassian: ATLASSIAN_GRANT,
      'atlassian-jsm': {
        requested_scopes: [
          'read:request:jira-service-management',
          'write:request:jira-service-management',
        ],
        granted_scopes: null,
      },
    };
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools).toContain('jsm_list_request_types');
    expect(tools).toContain('jsm_create_request');
  });

  it('omits JSM tools when neither Atlassian grant carries the JSM scopes', async () => {
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools.some((name) => name.startsWith('jsm_'))).toBe(false);
  });

  it('drops mutating tools in org read-only mode', async () => {
    readOnly = true;
    const tools = await listAvailableTools('tenant-1', 'subject-1');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.kind === 'read')).toBe(true);
  });

  it('omits every fileshare tool for a caller holding no share grant', async () => {
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools.some((name) => name.startsWith('fileshare_'))).toBe(false);
  });

  it('mounts the fileshare tools on the first grant row', async () => {
    // No provider_grants involvement: Renkei's own grant table IS the
    // provisioning signal for this connector.
    fileshareGranted = true;
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools).toContain('fileshare_list_shares');
    expect(tools).toContain('fileshare_request_file_upload');
    expect(tools).toContain('fileshare_move_entry');
    expect(tools).toContain('fileshare_rename_entry');
    expect(tools).toContain('fileshare_delete_entry_preview');
  });

  it('marks the fileshare delete confirm app-only, like every card button', async () => {
    fileshareGranted = true;
    const tools = await listAvailableTools('tenant-1', 'subject-1');
    const confirm = tools.find((tool) => tool.name === 'fileshare_delete_entry_confirm');
    expect(confirm?.appOnly).toBe(true);
    const preview = tools.find((tool) => tool.name === 'fileshare_delete_entry_preview');
    expect(preview?.appOnly).toBe(false);
  });

  it('drops the fileshare act tools in org read-only mode, keeps the reads', async () => {
    fileshareGranted = true;
    readOnly = true;
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools).toContain('fileshare_list_folder');
    expect(tools.some((name) => name === 'fileshare_request_file_upload')).toBe(false);
    expect(tools.some((name) => name === 'fileshare_create_folder')).toBe(false);
  });

  it('drops the fileshare tools when the org admin switches the connector off', async () => {
    fileshareGranted = true;
    disabledConnectors = ['fileshares'];
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools.some((name) => name.startsWith('fileshare_'))).toBe(false);
  });

  it('drops a connector the org admin has switched off', async () => {
    grants = {
      atlassian: ATLASSIAN_GRANT,
      microsoft: { requested_scopes: ['Mail.Read'], granted_scopes: null },
    };
    disabledConnectors = ['microsoft'];
    const tools = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(tools.some((name) => name.startsWith('outlook_'))).toBe(false);
    expect(tools.some((name) => name.startsWith('jira_'))).toBe(true);
  });

  it('withdraws a disabled connector’s summary tools too', async () => {
    // The summary tools all register behind the Jira gate, so a Microsoft
    // provider would otherwise survive its own connector being switched off
    // and keep calling Graph.
    grants = {
      atlassian: ATLASSIAN_GRANT,
      microsoft: { requested_scopes: ['Mail.Read'], granted_scopes: null },
    };
    const enabled = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(enabled).toContain('outlook_mail_summary');

    disabledConnectors = ['microsoft'];
    const disabled = namesOf(await listAvailableTools('tenant-1', 'subject-1'));
    expect(disabled).not.toContain('outlook_mail_summary');
    // The orchestrator itself is Jira-gated and stays.
    expect(disabled).toContain('daily_summary');
  });

  it('carries an outcome set on every tool, catch-all included', async () => {
    const tools = await listAvailableTools('tenant-1', 'subject-1');
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.outcomes.success.label.length).toBeGreaterThan(0);
      expect(tool.outcomes.failures.some((f) => f.code === 'other')).toBe(true);
    }
  });

  it('serves curated outcomes for the tools that have them', async () => {
    const tools = await listAvailableTools('tenant-1', 'subject-1');
    const createIssue = tools.find((tool) => tool.name === 'jira_create_issue');
    expect(createIssue?.outcomes.failures.map((f) => f.code)).toContain('project-not-found');
    // A tool with no curated entry still enumerates the generic conditions.
    const listComments = tools.find((tool) => tool.name === 'jira_list_comments');
    expect(listComments?.outcomes.failures.map((f) => f.code)).toContain('not-found');
  });

  it('labels each tool with a catalog connector key, not a name prefix', async () => {
    grants = {
      atlassian: ATLASSIAN_GRANT,
      microsoft: { requested_scopes: ['Mail.Read'], granted_scopes: null },
    };
    const tools = await listAvailableTools('tenant-1', 'subject-1');
    const outlook = tools.find((tool) => tool.name.startsWith('outlook_'));
    // 'microsoft' is what the catalog, the logo and the admin toggle all use.
    expect(outlook?.connector).toBe('microsoft');
  });
});
