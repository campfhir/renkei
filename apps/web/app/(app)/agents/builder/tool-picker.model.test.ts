import { MAX_AGENT_TOOLS } from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import {
  emptyListMessage,
  groupHeading,
  missingTools,
  offeredTools,
  toggledTools,
  toolCount,
  toolGroups,
  toolKindLabel,
} from './tool-picker.model';

function tool(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name,
    connector: 'agents',
    kind: 'read',
    title: null,
    description: null,
    appOnly: false,
    previewOf: null,
    widgetKind: null,
    outcomes: { success: { label: 'ok' }, failures: [] },
    ...overrides,
  };
}

const AGENT_GET = tool('agent_get', {
  title: 'Get agent',
  description: 'The exact definition, as JSON',
});
const AGENT_LIST = tool('agent_list', { title: 'List agents' });
const CARD_CREATE = tool('card_create', { connector: 'cards', kind: 'act' });
const JIRA = tool('jira_search', { connector: 'mcp-jira' });
const CATALOG = [CARD_CREATE, AGENT_LIST, AGENT_GET, JIRA];

const names = (list: ToolDescriptor[]) => list.map((entry) => entry.name);

describe('the tool picker', () => {
  it('offers neither app-only tools nor a card’s preview twin', () => {
    const offered = offeredTools([
      AGENT_GET,
      tool('widget_resolve', { appOnly: true }),
      tool('card_create_preview', { previewOf: 'card_create' }),
    ]);
    expect(names(offered)).toEqual(['agent_get']);
  });

  it('groups by connector, with groups and tools already selected first', () => {
    const groups = toolGroups(CATALOG, '', ['card_create', 'agent_list']);
    expect(groups.map((group) => [group.connector, names(group.list), group.picked])).toEqual([
      ['agents', ['agent_list', 'agent_get'], 1],
      ['cards', ['card_create'], 1],
      ['mcp-jira', ['jira_search'], 0],
    ]);
  });

  it('with nothing selected, orders groups and tools by name', () => {
    const groups = toolGroups(CATALOG, '', []);
    expect(groups.map((group) => group.connector)).toEqual(['agents', 'cards', 'mcp-jira']);
    expect(names(groups[0].list)).toEqual(['agent_get', 'agent_list']);
  });

  it('a search matches the name, the friendly name, the description or the connector', () => {
    const found = (query: string) =>
      toolGroups(CATALOG, query, []).flatMap((group) => names(group.list));
    expect(found('agent_get')).toEqual(['agent_get']);
    expect(found('  LIST AGENTS ')).toEqual(['agent_list']);
    expect(found('exact definition')).toEqual(['agent_get']);
    expect(found('jira')).toEqual(['jira_search']);
    expect(found('nothing like it')).toEqual([]);
  });

  it('checking a tool adds it at the end; unchecking takes it out', () => {
    expect(toggledTools(['agent_list'], 'agent_get')).toEqual(['agent_list', 'agent_get']);
    expect(toggledTools(['agent_list', 'agent_get'], 'agent_list')).toEqual(['agent_get']);
  });

  it('counts the selection against the limit, red once past it', () => {
    expect(toolCount(['agent_list'])).toEqual({
      text: `1 of at most ${MAX_AGENT_TOOLS} selected`,
      over: false,
    });
    const many = Array.from({ length: MAX_AGENT_TOOLS + 1 }, (_, index) => `t${index}`);
    expect(toolCount(many).over).toBe(true);
    expect(toolCount(many.slice(1)).over).toBe(false);
  });

  it('lists a selected tool the owner no longer has, so it can be removed', () => {
    expect(missingTools(['agent_get', 'gone_tool'], offeredTools(CATALOG))).toEqual(['gone_tool']);
  });

  it('heads an MCP server’s group as one, with how many are picked', () => {
    expect(groupHeading({ connector: 'mcp-jira', picked: 0 })).toBe('jira (MCP server)');
    expect(groupHeading({ connector: 'agents', picked: 2 })).toBe('agents · 2 selected');
  });

  it('says why the list is empty', () => {
    expect(emptyListMessage(0)).toBe('Connect an account to give your agents tools.');
    expect(emptyListMessage(4)).toBe('No tools match.');
  });

  it('says what each tool does to the world', () => {
    expect(toolKindLabel('read')).toBe('reads');
    expect(toolKindLabel('act')).toBe('changes — staged');
  });
});
