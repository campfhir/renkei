/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for a tool that never touches it */
import { createLocalToolSet, type LocalToolContext } from './local-tools';
import { findToolsTool, FIND_TOOLS_NAME } from './tool-discovery';
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
});
