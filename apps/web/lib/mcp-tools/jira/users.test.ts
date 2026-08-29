/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

// `../common` reaches the Kysely client, which is ESM and cannot be required
// here — the same fake the sibling suites use.
const jiraFetchMock = jest.fn();
jest.mock('../common', () => ({
  cacheUserDisplayName: () => undefined,
  getCachedDisplayName: () => 'Tester',
  withPresentationHint: (body: string, suggestion: string) =>
    `${body}\n\n(Presentation hint: ${suggestion})`,
}));

import { registerUserTools } from './users';
import type { JiraAuth } from './jira-auth';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

async function registerTools(payload: unknown): Promise<Map<string, ToolHandler>> {
  jiraFetchMock.mockReset();
  jiraFetchMock.mockImplementation(
    async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
  );
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  const auth = {
    kind: 'oauth',
    fetch: (_scopes: unknown, path: string) => jiraFetchMock(path),
  } as unknown as JiraAuth;
  await registerUserTools(server, { tenantId: 'tenant-1' } as unknown as MCPToolContext, auth);
  return tools;
}

describe('jira_list_groups', () => {
  it('carries the groupId the picker returned', async () => {
    // The hint promised an id column, and Jira's newer group APIs take the
    // groupId rather than the name — which is not unique across directories.
    const tools = await registerTools({
      groups: [
        { name: 'jira-administrators', groupId: '276f955c-6b0f' },
        { name: 'site-admins', groupId: 'aa4d8a1e-9c2b' },
      ],
    });

    const text = (await tools.get('jira_list_groups')!({})).content[0].text ?? '';

    expect(text).toContain('• jira-administrators — groupId: 276f955c-6b0f');
    expect(text).toContain('• site-admins — groupId: aa4d8a1e-9c2b');
  });

  it('still lists a group on a site that sends no groupId', async () => {
    const tools = await registerTools({ groups: [{ name: 'jira-users' }] });

    const text = (await tools.get('jira_list_groups')!({})).content[0].text ?? '';

    expect(text).toContain('• jira-users');
    expect(text).not.toContain('groupId');
  });
});
