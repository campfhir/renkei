/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for a tool that never touches it */
import { createLocalToolSet, type LocalToolContext } from './local-tools';
import { findToolsTool, FIND_TOOLS_NAME, recallDiscoveredTools } from './tool-discovery';
import type { LlmMessage } from '@renkei/agent-llm';
import type { DiscoverableTool } from './tool-surface';

const context: LocalToolContext = {
  db: null as unknown as LocalToolContext['db'],
  tenantId: 't1',
  subject: 'u1',
  chatId: 'c1',
  projectId: null,
  readOnly: false,
};

const jiraSearch: DiscoverableTool = {
  connector: 'jira',
  def: {
    name: 'jira_search_issues',
    description: 'Search issues by JQL.',
    inputSchema: { type: 'object', properties: {} },
  },
};
const jiraCreate: DiscoverableTool = {
  connector: 'jira',
  def: {
    name: 'jira_create_issue',
    description: 'Create a new issue.',
    inputSchema: { type: 'object', properties: {} },
  },
};
const sharepointSearch: DiscoverableTool = {
  connector: 'sharepoint',
  def: {
    name: 'sharepoint_search_documents',
    description: 'Search SharePoint files.',
    inputSchema: { type: 'object', properties: {} },
  },
};
const outlookFindMeetingTimes: DiscoverableTool = {
  connector: 'outlook',
  def: {
    name: 'outlook_find_meeting_times',
    description: 'Suggest meeting slots within a window.',
    inputSchema: {
      type: 'object',
      properties: {
        durationMinutes: {
          anyOf: [{ type: 'number' }, { type: 'string' }],
          description: 'Meeting length in minutes, 5-1440',
        },
        requiredAttendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Required attendee email addresses',
        },
        max: { type: 'number', description: 'How many suggestions (default 10)' },
      },
      required: ['durationMinutes'],
    },
  },
};

describe('findToolsTool', () => {
  it('is null when nothing is discoverable — no dead-end tool offered', () => {
    expect(findToolsTool([])).toBeNull();
  });

  it('names the enabled connectors and their counts in its own description', () => {
    const tool = findToolsTool([jiraSearch, jiraCreate, sharepointSearch]);
    expect(tool?.def.description).toContain('jira (2)');
    expect(tool?.def.description).toContain('sharepoint (1)');
  });

  it('is read-only: safe to run beside other reads in the same round', () => {
    expect(findToolsTool([jiraSearch])?.readOnly).toBe(true);
  });

  it('matches by tool name, connector, or description and hands back the schemas as discoveredTools', async () => {
    const tools = createLocalToolSet([findToolsTool([jiraSearch, jiraCreate, sharepointSearch])!]);
    const result = await tools.run(FIND_TOOLS_NAME, { query: 'create' }, context);
    expect(result.isError).toBeFalsy();
    expect(result.meta.discoveredTools).toEqual([jiraCreate.def]);
    expect(result.content[0]?.text).toContain('jira_create_issue');
  });

  it('matching by connector name alone surfaces every tool in it', async () => {
    const tools = createLocalToolSet([findToolsTool([jiraSearch, jiraCreate, sharepointSearch])!]);
    const result = await tools.run(FIND_TOOLS_NAME, { query: 'jira' }, context);
    expect(result.meta.discoveredTools).toEqual(
      expect.arrayContaining([jiraSearch.def, jiraCreate.def])
    );
    expect(result.meta.discoveredTools).toHaveLength(2);
  });

  it('reports no match rather than returning the whole catalog', async () => {
    const tools = createLocalToolSet([findToolsTool([jiraSearch])!]);
    const result = await tools.run(FIND_TOOLS_NAME, { query: 'zzz nothing like this' }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No tools matched');
    expect(result.meta.discoveredTools).toBeUndefined();
  });

  it('refuses an empty query rather than guessing', async () => {
    const tools = createLocalToolSet([findToolsTool([jiraSearch])!]);
    const result = await tools.run(FIND_TOOLS_NAME, { query: '   ' }, context);
    expect(result.isError).toBe(true);
  });

  it('describes each matched tool’s parameters, not just its name and description', async () => {
    const tools = createLocalToolSet([findToolsTool([outlookFindMeetingTimes])!]);
    const result = await tools.run(FIND_TOOLS_NAME, { query: 'meeting times' }, context);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('durationMinutes (number|string)');
    expect(text).toContain('Meeting length in minutes, 5-1440');
    expect(text).toContain('requiredAttendees (string[], optional)');
    expect(text).toContain('max (number, optional)');
  });

  it('adds no parameter line for a tool with an empty schema', async () => {
    const tools = createLocalToolSet([findToolsTool([jiraSearch])!]);
    const result = await tools.run(FIND_TOOLS_NAME, { query: 'search' }, context);

    expect(result.content[0]?.text).not.toContain('Parameters:');
  });
});

describe('recallDiscoveredTools', () => {
  const catalog = [jiraSearch, jiraCreate, sharepointSearch, outlookFindMeetingTimes];

  it('recalls a tool an earlier turn called by name', () => {
    const history: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'find a slot' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'outlook_find_meeting_times',
            input: { durationMinutes: 30 },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'slots' }] },
      { role: 'user', content: [{ type: 'text', text: '11am' }] },
    ];
    expect(recallDiscoveredTools(history, catalog)).toEqual([outlookFindMeetingTimes.def]);
  });

  it('recalls every tool a find_tools result listed, called since or not', async () => {
    // The real result text, so the recall stays in step with the format.
    const tools = createLocalToolSet([findToolsTool(catalog)!]);
    const found = await tools.run(FIND_TOOLS_NAME, { query: 'jira' }, context);
    const history: LlmMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: FIND_TOOLS_NAME, input: { query: 'jira' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tu1', content: found.content[0]!.text! }],
      },
    ];
    expect(recallDiscoveredTools(history, catalog).map((tool) => tool.name)).toEqual([
      'jira_search_issues',
      'jira_create_issue',
    ]);
  });

  it('takes no name on trust from result text: only the discoverable catalog counts', () => {
    const history: LlmMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: FIND_TOOLS_NAME, input: { query: 'x' } },
          { type: 'tool_use', id: 'tu2', name: 'search_knowledge', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu1',
            content:
              'Found 2 tool(s), now callable:\n- jira_delete_everything: gone\n- jira_create_issue: Create',
          },
          // Not a find_tools result — its lines are just text.
          { type: 'tool_result', toolUseId: 'tu2', content: '- sharepoint_search_documents: hi' },
        ],
      },
    ];
    expect(recallDiscoveredTools(history, catalog)).toEqual([jiraCreate.def]);
  });

  it('is empty for a chat with nothing discoverable or nothing discovered', () => {
    const history: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    expect(recallDiscoveredTools(history, catalog)).toEqual([]);
    expect(recallDiscoveredTools(history, [])).toEqual([]);
  });
});
