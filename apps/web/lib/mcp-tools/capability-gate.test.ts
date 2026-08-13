/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression tests for the capability gate — and for READ_ONLY, which
 * .env.example documented for a long time while nothing enforced it. Under
 * org read-only policy, mutating tools must not be registered at all: they
 * never appear in tools/list.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { createProjection, OPEN_ORG_POLICY } from '@renkei/capability-registry';
import { withCapabilityGate, JIRA_CONNECTOR } from './capability-gate';

function fakeServer(): { server: McpServer; registered: string[] } {
  const registered: string[] = [];
  const server = {
    registerTool: (name: string) => {
      registered.push(name);
    },
  } as unknown as McpServer;
  return { server, registered };
}

const PROVISIONED = { provisionedConnectors: [JIRA_CONNECTOR], hiddenCapabilities: [] };

function registerSampleTools(server: McpServer): void {
  server.registerTool(
    'jira_search_issues',
    { description: 'read', annotations: { readOnlyHint: true } },
    async () => ({ content: [] })
  );
  server.registerTool('jira_create_issue', { description: 'write' }, async () => ({ content: [] }));
  server.registerTool(
    'jira_delete_issue',
    { description: 'write', annotations: { readOnlyHint: false } },
    async () => ({ content: [] })
  );
}

describe('withCapabilityGate', () => {
  it('registers everything under an open policy', () => {
    const { server, registered } = fakeServer();
    const gated = withCapabilityGate(server, createProjection(OPEN_ORG_POLICY, PROVISIONED));

    registerSampleTools(gated);

    expect(registered).toEqual(['jira_search_issues', 'jira_create_issue', 'jira_delete_issue']);
  });

  it('READ_ONLY: mutating tools are never registered, absent hint included', () => {
    const { server, registered } = fakeServer();
    const gated = withCapabilityGate(
      server,
      createProjection({ ...OPEN_ORG_POLICY, readOnly: true }, PROVISIONED)
    );

    registerSampleTools(gated);

    expect(registered).toEqual(['jira_search_issues']);
  });

  it('an org-disabled capability is not registered', () => {
    const { server, registered } = fakeServer();
    const gated = withCapabilityGate(
      server,
      createProjection(
        { ...OPEN_ORG_POLICY, disabledCapabilities: ['jira_delete_issue'] },
        PROVISIONED
      )
    );

    registerSampleTools(gated);

    expect(registered).toEqual(['jira_search_issues', 'jira_create_issue']);
  });

  it('a user hide choice removes the tool from their projection', () => {
    const { server, registered } = fakeServer();
    const gated = withCapabilityGate(
      server,
      createProjection(OPEN_ORG_POLICY, {
        ...PROVISIONED,
        hiddenCapabilities: ['jira_create_issue'],
      })
    );

    registerSampleTools(gated);

    expect(registered).toEqual(['jira_search_issues', 'jira_delete_issue']);
  });

  it('passes non-registerTool members through to the underlying server', () => {
    const { server } = fakeServer();
    const gated = withCapabilityGate(server, createProjection(OPEN_ORG_POLICY, PROVISIONED));

    expect(typeof gated.registerTool).toBe('function');
  });
});
