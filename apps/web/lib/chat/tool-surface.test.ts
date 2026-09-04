import { partitionChatTools, readOnlyToolNames } from './tool-surface';
import { effectiveToolConfig, parseToolConfig } from './tool-config';
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
    expect(effectiveToolConfig(null, null)).toEqual({ connectors: ['knowledge', 'sandbox'] });
  });
});
