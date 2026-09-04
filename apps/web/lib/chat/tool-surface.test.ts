import { selectChatTools } from './tool-surface';
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

describe('selectChatTools', () => {
  it('keeps always-on tools, the chosen connectors, and nothing app-only or preview', () => {
    const tools = selectChatTools(
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
    expect(tools.map((tool) => tool.name)).toEqual([
      'jira_search_issues',
      'search_knowledge',
      'whoami',
    ]);
    expect(tools[0].description).toBe('live jira_search_issues');
    expect(tools[0].inputSchema).toEqual({ type: 'object' });
  });

  it('offers only whoami for an empty toolset', () => {
    const tools = selectChatTools(
      [descriptor({ name: 'whoami' }), descriptor({ name: 'jira_search_issues' })],
      [live('whoami'), live('jira_search_issues')],
      { connectors: [] }
    );
    expect(tools.map((tool) => tool.name)).toEqual(['whoami']);
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
