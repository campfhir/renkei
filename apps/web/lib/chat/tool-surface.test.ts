import { partitionChatTools, readOnlyToolNames } from './tool-surface';
import {
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
    // tools are discoverable even though the chat has it turned on.
    expect(eager.map((tool) => tool.name)).toEqual(['search_knowledge', 'whoami']);
    expect(discoverable.map((entry) => entry.def.name)).toEqual(['jira_search_issues']);
    expect(discoverable[0].connector).toBe('jira');
    expect(discoverable[0].def.description).toBe('live jira_search_issues');
    expect(discoverable[0].def.inputSchema).toEqual({ type: 'object' });
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

  it('gives a code project’s chat the code default, and never the personal one', () => {
    const personal = { connectors: ['webex'] };
    expect(effectiveToolConfig(null, null, personal)).toEqual(personal);
    expect(effectiveToolConfig(null, null, personal, 'code')).toEqual({
      connectors: [...CODE_PROJECT_DEFAULT_CONNECTORS],
    });
    expect(CODE_PROJECT_DEFAULT_CONNECTORS).toEqual([...CODE_PROJECT_DEFAULT_CONNECTORS].sort());
    expect(CODE_PROJECT_DEFAULT_CONNECTORS).toContain('atlassian-bitbucket');
    expect(CODE_PROJECT_DEFAULT_CONNECTORS).toContain('jira');
    expect(CODE_PROJECT_DEFAULT_CONNECTORS).not.toContain('agents');
    // The chat's and the project's own choice still win.
    expect(effectiveToolConfig(null, { connectors: ['b'] }, personal, 'code')).toEqual({
      connectors: ['b'],
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
  it('always carries Bitbucket in a code project, whatever the chat chose', () => {
    expect(CODE_PROJECT_CONNECTORS).toContain('atlassian-bitbucket');
    // The code default, when nothing was chosen — Bitbucket already in it.
    expect(
      projectToolConfig(effectiveToolConfig(null, null, null, 'code'), 'code').connectors
    ).toEqual([...CODE_PROJECT_DEFAULT_CONNECTORS]);
    // A chat that chose without it still gets it.
    expect(projectToolConfig({ connectors: ['jira'] }, 'code').connectors).toEqual([
      'atlassian-bitbucket',
      'jira',
    ]);
    // A chat that turned everything off still gets it.
    expect(projectToolConfig({ connectors: [] }, 'code').connectors).toEqual([
      'atlassian-bitbucket',
    ]);
  });

  it('leaves a chat project, or no project, alone', () => {
    const chosen = { connectors: ['jira'] };
    expect(projectToolConfig(chosen, 'chat')).toBe(chosen);
    expect(projectToolConfig(chosen, null)).toBe(chosen);
    expect(projectToolConfig(chosen, undefined)).toBe(chosen);
  });
});
