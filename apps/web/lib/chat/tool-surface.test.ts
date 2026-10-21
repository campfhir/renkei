import { partitionChatTools, previewRouting, readOnlyToolNames } from './tool-surface';
import {
  AUTO_DIRECT_CONNECTORS,
  CODE_PROJECT_CONNECTORS,
  CODE_PROJECT_DEFAULT_CONNECTORS,
  effectiveToolConfig,
  parseToolConfig,
  projectToolConfig,
  withRequiredConnectors,
} from './tool-config';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';

function descriptor(
  partial: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name'>
): ToolDescriptor {
  return {
    connector: 'jira',
    kind: 'read',
    title: null,
    description: 'd',
    appOnly: false,
    previewOf: null,
    widgetKind: null,
    outcomes: { success: { label: 'ok' }, failures: [] },
    ...partial,
  };
}

const live = (name: string) => ({
  name,
  description: `live ${name}`,
  inputSchema: { type: 'object' },
});

describe('partitionChatTools', () => {
  it('keeps always-on and core-connector tools eager; a non-core connector becomes discoverable', () => {
    const { eager, discoverable } = partitionChatTools(
      [
        descriptor({ name: 'whoami', connector: 'jira' }),
        descriptor({ name: 'jira_search_issues', connector: 'jira' }),
        descriptor({ name: 'jira_create_issue_preview', connector: 'jira' }),
        descriptor({ name: 'search_knowledge', connector: 'knowledge' }),
        descriptor({ name: 'card_action', connector: 'jira', appOnly: true }),
        descriptor({ name: 'outlook_send_mail', connector: 'outlook' }),
        descriptor({ name: 'ghost_tool', connector: 'knowledge' }),
      ],
      [
        live('whoami'),
        live('jira_search_issues'),
        live('jira_create_issue_preview'),
        live('search_knowledge'),
        live('card_action'),
        live('outlook_send_mail'),
      ],
      { connectors: ['knowledge', 'jira'] }
    );
    // knowledge is a core connector (always eager); jira is not, so its
    // tools are discoverable even though the chat has it turned on. A
    // preview tool is offered like any other tool now that the thread can
    // render the card its result binds to (widget-card.tsx) — only an
    // app-only tool (card_action) stays excluded.
    expect(eager.map((tool) => tool.name)).toEqual(['search_knowledge', 'whoami']);
    expect(discoverable.map((entry) => entry.def.name)).toEqual([
      'jira_create_issue_preview',
      'jira_search_issues',
    ]);
    expect(discoverable[0].connector).toBe('jira');
    expect(discoverable[0].def.description).toBe('live jira_create_issue_preview');
    expect(discoverable[1].def.description).toBe('live jira_search_issues');
    expect(discoverable[1].def.inputSchema).toEqual({ type: 'object' });
  });

  it('makes a connected MCP server’s tools discoverable whatever the chat’s toolset says', () => {
    const { eager, discoverable } = partitionChatTools(
      [
        descriptor({ name: 'whoami', connector: 'jira' }),
        descriptor({ name: 'acme__lookup', connector: 'mcp-acme' }),
      ],
      [live('whoami'), live('acme__lookup')],
      { connectors: [] }
    );
    expect(eager.map((tool) => tool.name)).toEqual(['whoami']);
    expect(discoverable.map((entry) => entry.def.name)).toEqual(['acme__lookup']);
    expect(discoverable[0].connector).toBe('mcp-acme');
  });

  it('offers only whoami for an empty toolset', () => {
    const { eager, discoverable } = partitionChatTools(
      [descriptor({ name: 'whoami' }), descriptor({ name: 'jira_search_issues' })],
      [live('whoami'), live('jira_search_issues')],
      { connectors: [] }
    );
    expect(eager.map((tool) => tool.name)).toEqual(['whoami']);
    expect(discoverable).toEqual([]);
  });

  it('offers tools named as eager extras up front, and the rest of their connector behind find_tools', () => {
    const { eager, discoverable } = partitionChatTools(
      [
        descriptor({ name: 'bitbucket_create_pull_request', connector: 'atlassian-bitbucket' }),
        descriptor({ name: 'bitbucket_list_workspaces', connector: 'atlassian-bitbucket' }),
        descriptor({ name: 'jira_search_issues', connector: 'jira' }),
      ],
      [
        { name: 'bitbucket_create_pull_request', description: '', inputSchema: {} },
        { name: 'bitbucket_list_workspaces', description: '', inputSchema: {} },
        { name: 'jira_search_issues', description: '', inputSchema: {} },
      ],
      { connectors: ['atlassian-bitbucket', 'jira'] },
      { tools: ['bitbucket_create_pull_request'] }
    );
    expect(eager.map((tool) => tool.name)).toEqual(['bitbucket_create_pull_request']);
    expect(discoverable.map((entry) => entry.def.name)).toEqual([
      'bitbucket_list_workspaces',
      'jira_search_issues',
    ]);
  });

  it('keeps a core connector eager even when it is not sandbox/knowledge by name coincidence', () => {
    const { eager, discoverable } = partitionChatTools(
      [descriptor({ name: 'sandbox_run', connector: 'sandbox' })],
      [live('sandbox_run')],
      { connectors: ['sandbox'] }
    );
    expect(eager.map((tool) => tool.name)).toEqual(['sandbox_run']);
    expect(discoverable).toEqual([]);
  });
});

describe('previewRouting', () => {
  const act = (name: string, connector: string) => descriptor({ name, connector, kind: 'act' });
  const catalog = [
    act('outlook_send_mail', 'microsoft'),
    act('outlook_send_mail_preview', 'microsoft'),
    // The reply family's preview is not named after its direct tool.
    act('outlook_reply_message', 'microsoft'),
    act('outlook_reply_preview', 'microsoft'),
    // Generated previews are in the catalog like hand-written ones.
    act('confluence_create_page', 'atlassian-confluence'),
    act('confluence_create_page_preview', 'atlassian-confluence'),
    act('bitbucket_create_pull_request', 'atlassian-bitbucket'),
    act('bitbucket_create_pull_request_preview', 'atlassian-bitbucket'),
    // No preview in the catalog: a platform-internal act, left as it is.
    act('card_create', 'cards'),
    // A preview with no plain tool at all (a directory write) is never hidden.
    act('entra_create_application_preview', 'entra-developer'),
    act('outlook_send_draft_confirm', 'microsoft'),
    descriptor({ name: 'outlook_list_messages', connector: 'microsoft' }),
  ];

  it('hides every plain act tool that has a preview, and says which preview replaces it', () => {
    const { hidden, previewOnly } = previewRouting(catalog);
    expect([...hidden].sort()).toEqual([
      'bitbucket_create_pull_request',
      'confluence_create_page',
      'outlook_reply_message',
      'outlook_send_mail',
    ]);
    expect(Object.fromEntries(previewOnly)).toEqual({
      bitbucket_create_pull_request: 'bitbucket_create_pull_request_preview',
      confluence_create_page: 'confluence_create_page_preview',
      outlook_reply_message: 'outlook_reply_preview',
      outlook_send_mail: 'outlook_send_mail_preview',
    });
  });

  it('keeps the plain tools of a direct connector, and drops their previews instead', () => {
    const { hidden, previewOnly } = previewRouting(catalog, new Set(AUTO_DIRECT_CONNECTORS));
    // Auto mode in a code project: the repository's host and the wiki act
    // unasked; mail is not code development, so it is still previewed.
    expect([...hidden].sort()).toEqual([
      'bitbucket_create_pull_request_preview',
      'confluence_create_page_preview',
      'outlook_reply_message',
      'outlook_send_mail',
    ]);
    expect([...previewOnly.keys()].sort()).toEqual(['outlook_reply_message', 'outlook_send_mail']);
  });

  it('closes the preview of a tool the person blocked along with the tool', () => {
    const { blockedPreviews } = previewRouting(
      catalog,
      new Set(),
      new Set(['outlook_reply_message', 'confluence_create_page', 'card_create', 'no_such_tool'])
    );
    expect([...blockedPreviews].sort()).toEqual([
      'confluence_create_page_preview',
      'outlook_reply_preview',
    ]);
  });

  it('never treats mail, chat, meetings or directories as code development', () => {
    for (const connector of ['microsoft', 'webex', 'zoom', 'onedrive', 'sharepoint', 'admanager']) {
      expect(AUTO_DIRECT_CONNECTORS).not.toContain(connector);
    }
  });

  it('offers the preview of a previewed tool up front when the tool itself was an eager extra', () => {
    const everything = [
      act('bitbucket_create_pull_request', 'atlassian-bitbucket'),
      act('bitbucket_create_pull_request_preview', 'atlassian-bitbucket'),
      act('bitbucket_update_pull_request_preview', 'atlassian-bitbucket'),
    ];
    const { hidden } = previewRouting(everything);
    const { eager, discoverable } = partitionChatTools(
      everything.filter((tool) => !hidden.has(tool.name)),
      everything.map((tool) => live(tool.name)),
      { connectors: ['atlassian-bitbucket'] },
      { tools: ['bitbucket_create_pull_request'] }
    );
    expect(eager.map((tool) => tool.name)).toEqual(['bitbucket_create_pull_request_preview']);
    expect(discoverable.map((entry) => entry.def.name)).toEqual([
      'bitbucket_update_pull_request_preview',
    ]);
  });
});

describe('readOnlyToolNames', () => {
  it('names the offered tools the catalog calls reads, and nothing else', () => {
    const catalog = [
      descriptor({ name: 'search_knowledge', connector: 'knowledge', kind: 'read' }),
      descriptor({ name: 'jira_search_issues', connector: 'jira', kind: 'read' }),
      descriptor({ name: 'jira_create_issue', connector: 'jira', kind: 'act' }),
      descriptor({ name: 'not_offered', connector: 'jira', kind: 'read' }),
    ];
    const tools = [
      { name: 'search_knowledge', description: '', inputSchema: {} },
      { name: 'jira_search_issues', description: '', inputSchema: {} },
      { name: 'jira_create_issue', description: '', inputSchema: {} },
      { name: 'unknown_tool', description: '', inputSchema: {} },
    ];
    expect([...readOnlyToolNames(catalog, tools)].sort()).toEqual([
      'jira_search_issues',
      'search_knowledge',
    ]);
  });
});

describe('tool config', () => {
  it('parses, dedupes and sorts connector keys, refusing junk', () => {
    expect(parseToolConfig({ connectors: ['jira', 'knowledge', 'jira', 7, 'Bad Key'] })).toEqual({
      connectors: ['jira', 'knowledge'],
    });
    expect(parseToolConfig('{"connectors":["sandbox"]}')).toEqual({ connectors: ['sandbox'] });
    expect(parseToolConfig({ nope: true })).toBeNull();
    expect(parseToolConfig('not json')).toBeNull();
  });

  it('prefers the chat, then the project, then the core set', () => {
    expect(effectiveToolConfig({ connectors: ['a'] }, { connectors: ['b'] })).toEqual({
      connectors: ['a'],
    });
    expect(effectiveToolConfig(null, { connectors: ['b'] })).toEqual({ connectors: ['b'] });
    expect(effectiveToolConfig(null, null)).toEqual({
      connectors: ['agents', 'cards', 'knowledge', 'sandbox'],
    });
  });

  it('gives a code project’s chat the code default when no default of its own kind is saved', () => {
    const personal = { connectors: ['webex'] };
    expect(effectiveToolConfig(null, null, personal)).toEqual(personal);
    // The caller passes the code-kind default; none saved falls to the built-in.
    expect(effectiveToolConfig(null, null, null, 'code')).toEqual({
      connectors: [...CODE_PROJECT_DEFAULT_CONNECTORS],
    });
    expect(effectiveToolConfig(null, null, personal, 'code')).toEqual(personal);
    expect(CODE_PROJECT_DEFAULT_CONNECTORS).toEqual([...CODE_PROJECT_DEFAULT_CONNECTORS].sort());
    expect(CODE_PROJECT_DEFAULT_CONNECTORS).toContain('atlassian-bitbucket');
    expect(CODE_PROJECT_DEFAULT_CONNECTORS).toContain('jira');
    expect(CODE_PROJECT_DEFAULT_CONNECTORS).not.toContain('agents');
    // The chat's and the project's own choice still win.
    expect(effectiveToolConfig(null, { connectors: ['b'] }, personal, 'code')).toEqual({
      connectors: ['b'],
    });
    expect(effectiveToolConfig(null, null, null)).toEqual({
      connectors: ['agents', 'cards', 'knowledge', 'sandbox'],
    });
  });
});

describe('withRequiredConnectors', () => {
  it('adds what is required, once, sorted, without touching the input', () => {
    const chosen = { connectors: ['jira', 'atlassian-bitbucket'] };
    expect(withRequiredConnectors(chosen, ['atlassian-bitbucket', 'agents'])).toEqual({
      connectors: ['agents', 'atlassian-bitbucket', 'jira'],
    });
    expect(chosen).toEqual({ connectors: ['jira', 'atlassian-bitbucket'] });
  });

  it('turns an empty toolset into just the required set', () => {
    expect(withRequiredConnectors({ connectors: [] }, ['atlassian-bitbucket'])).toEqual({
      connectors: ['atlassian-bitbucket'],
    });
  });
});

describe('projectToolConfig', () => {
  it('always carries Bitbucket and GitHub in a code project, whatever the chat chose', () => {
    expect(CODE_PROJECT_CONNECTORS).toContain('atlassian-bitbucket');
    expect(CODE_PROJECT_CONNECTORS).toContain('github');
    // The code default, when nothing was chosen — both already in it.
    expect(
      projectToolConfig(effectiveToolConfig(null, null, null, 'code'), 'code').connectors
    ).toEqual([...CODE_PROJECT_DEFAULT_CONNECTORS]);
    // A chat that chose without them still gets them.
    expect(projectToolConfig({ connectors: ['jira'] }, 'code').connectors).toEqual([
      'atlassian-bitbucket',
      'github',
      'jira',
    ]);
    // A chat that turned everything off still gets them.
    expect(projectToolConfig({ connectors: [] }, 'code').connectors).toEqual([
      'atlassian-bitbucket',
      'github',
    ]);
  });

  it('leaves a chat project, or no project, alone', () => {
    const chosen = { connectors: ['jira'] };
    expect(projectToolConfig(chosen, 'chat')).toBe(chosen);
    expect(projectToolConfig(chosen, null)).toBe(chosen);
    expect(projectToolConfig(chosen, undefined)).toBe(chosen);
  });
});
