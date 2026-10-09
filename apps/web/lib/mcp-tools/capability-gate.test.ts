/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression tests for the capability gate — and for READ_ONLY, which
 * .env.example documented for a long time while nothing enforced it. Under
 * org read-only policy, mutating tools must not be registered at all: they
 * never appear in tools/list.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { createProjection, OPEN_ORG_POLICY } from '@renkei/capability-registry';
import {
  APP_ONLY_REFUSAL,
  isAppOnlyTool,
  withAppOnlyCallGuard,
  withAppOnlyGate,
  withCapabilityGate,
  withToolAllowList,
  JIRA_CONNECTOR,
} from './capability-gate';
import { APP_ONLY_META, confirmGuard, previewToolMeta } from './widgets';

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
  it('registers none of a restricted connector for a caller outside its audience', () => {
    // The assertion that separates a real restriction from a hidden card:
    // outside the audience, the connector's tools never reach tools/list.
    const outside = fakeServer();
    registerSampleTools(
      withCapabilityGate(
        outside.server,
        createProjection(
          { ...OPEN_ORG_POLICY, restrictedConnectors: [JIRA_CONNECTOR] },
          { ...PROVISIONED, allowedConnectors: [] }
        )
      )
    );
    expect(outside.registered).toEqual([]);

    const inside = fakeServer();
    registerSampleTools(
      withCapabilityGate(
        inside.server,
        createProjection(
          { ...OPEN_ORG_POLICY, restrictedConnectors: [JIRA_CONNECTOR] },
          { ...PROVISIONED, allowedConnectors: [JIRA_CONNECTOR] }
        )
      )
    );
    expect(inside.registered).toEqual([
      'jira_search_issues',
      'jira_create_issue',
      'jira_delete_issue',
    ]);
  });

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

  it('a requiredRole gates the whole module for a caller without that role', () => {
    const { server, registered } = fakeServer();
    const gated = withCapabilityGate(
      server,
      createProjection(OPEN_ORG_POLICY, { ...PROVISIONED, roles: ['renkei-user'] }),
      JIRA_CONNECTOR,
      'renkei-operator'
    );

    registerSampleTools(gated);

    expect(registered).toEqual([]);
  });

  it('a requiredRole registers normally for a caller holding that role', () => {
    const { server, registered } = fakeServer();
    const gated = withCapabilityGate(
      server,
      createProjection(OPEN_ORG_POLICY, {
        ...PROVISIONED,
        roles: ['renkei-user', 'renkei-operator'],
      }),
      JIRA_CONNECTOR,
      'renkei-operator'
    );

    registerSampleTools(gated);

    expect(registered).toEqual(['jira_search_issues', 'jira_create_issue', 'jira_delete_issue']);
  });
});

describe('withToolAllowList', () => {
  it('registers only the named tools, in registration order', () => {
    const { server, registered } = fakeServer();
    const gated = withToolAllowList(server, new Set(['jira_delete_issue', 'jira_search_issues']));

    registerSampleTools(gated);

    expect(registered).toEqual(['jira_search_issues', 'jira_delete_issue']);
  });

  it('registers nothing for an empty list — a run whose steps name no tool', () => {
    const { server, registered } = fakeServer();

    registerSampleTools(withToolAllowList(server, new Set()));

    expect(registered).toEqual([]);
  });

  it('composes under the capability gate: a listed tool the policy refuses stays out', () => {
    const { server, registered } = fakeServer();
    const gated = withCapabilityGate(
      withToolAllowList(server, new Set(['jira_search_issues', 'jira_create_issue'])),
      createProjection({ ...OPEN_ORG_POLICY, readOnly: true }, PROVISIONED)
    );

    registerSampleTools(gated);

    expect(registered).toEqual(['jira_search_issues']);
  });
});

/**
 * The confirm half of a preview pair is a card button, not a tool for a
 * model or an MCP client: it must register for the chat's widget-confirm
 * token and for nothing else — an external client's token, an agent run's,
 * a chat turn's. The visibility used to be metadata only (Renkei's own
 * chat filtered on it; the gateway never looked), so a client holding an
 * OAuth token could call `entra_assign_app_role_confirm` directly and skip
 * the card.
 */
describe('app-only tools at the gateway', () => {
  type Handler = () => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;

  function recordingServer(): { server: McpServer; handlers: Map<string, Handler> } {
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    return { server, handlers };
  }

  const ran = async () => ({ content: [{ type: 'text' as const, text: 'assigned' }] });

  function registerEntraPair(server: McpServer): void {
    server.registerTool(
      'entra_assign_app_role_preview',
      {
        description: 'Preview assigning an app role.',
        annotations: { readOnlyHint: false },
        _meta: previewToolMeta('ui://widget/directory-action-preview.test.html'),
      },
      ran
    );
    server.registerTool(
      'entra_assign_app_role_confirm',
      {
        description: 'Assign the role.' + confirmGuard('entra_assign_app_role_preview'),
        annotations: { readOnlyHint: false },
        _meta: APP_ONLY_META,
      },
      ran
    );
    server.registerTool(
      'entra_get_application',
      { description: 'read', annotations: { readOnlyHint: true } },
      ran
    );
  }

  it('reads APP_ONLY_META as app-only and a preview or plain tool as model-facing', () => {
    expect(isAppOnlyTool({ _meta: APP_ONLY_META })).toBe(true);
    expect(isAppOnlyTool({ _meta: previewToolMeta('ui://widget/x.html') })).toBe(false);
    expect(isAppOnlyTool({ _meta: { ui: { visibility: ['model', 'app'] } } })).toBe(false);
    expect(isAppOnlyTool({ description: 'plain' })).toBe(false);
  });

  it('an external client never lists a confirm tool, and cannot call it even if one registers', async () => {
    // Registration: the confirm half is dropped for a 'jira' (OAuth-client)
    // or 'agent' token alike — anything that is not the widget class.
    const listing = recordingServer();
    registerEntraPair(withAppOnlyGate(listing.server, false));
    expect([...listing.handlers.keys()]).toEqual([
      'entra_assign_app_role_preview',
      'entra_get_application',
    ]);

    // Call time: a confirm tool that slipped past registration (a module
    // registering on the raw server, say) answers a refusal, never runs.
    const calling = recordingServer();
    registerEntraPair(withAppOnlyCallGuard(calling.server, false));
    const confirm = calling.handlers.get('entra_assign_app_role_confirm');
    expect(confirm).toBeDefined();
    const result = await confirm!();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(APP_ONLY_REFUSAL);
    // The guard touches nothing else.
    expect(
      (await calling.handlers.get('entra_assign_app_role_preview')!()).isError
    ).toBeUndefined();
  });

  it('the widget-confirm token lists and calls exactly its one tool', async () => {
    // confirmWidgetTool mints application 'widget' allow-listed to the one
    // confirm tool; the gates compose so that token sees that tool and
    // nothing beside it.
    const { server, handlers } = recordingServer();
    registerEntraPair(
      withAppOnlyGate(
        withToolAllowList(
          withAppOnlyCallGuard(server, true),
          new Set(['entra_assign_app_role_confirm'])
        ),
        true
      )
    );
    expect([...handlers.keys()]).toEqual(['entra_assign_app_role_confirm']);
    const result = await handlers.get('entra_assign_app_role_confirm')!();
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('assigned');
  });

  it('an agent run token allow-listed to a confirm tool still gets nothing', () => {
    // A step cannot name a confirm tool past validation, but the gateway
    // does not rely on that: the allow-list says yes, the class says no.
    const { server, handlers } = recordingServer();
    registerEntraPair(
      withAppOnlyGate(withToolAllowList(server, new Set(['entra_assign_app_role_confirm'])), false)
    );
    expect([...handlers.keys()]).toEqual([]);
  });
});
