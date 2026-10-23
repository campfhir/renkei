/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The automation tools against a fake Automation API (on the token's
 * fetcher) and a fake Jira (on the admin grant's), with a stand-in
 * change-request store. What must hold: reads name scopes by space key
 * and go only to the Automation base; proposals write nothing; a rule
 * named by a name several share is refused; a new rule needs a trigger
 * and steps or a rule to copy; an update stores the whole rule with the
 * `updated` stamp it read; a run resolves issue keys to ids.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../common', () => ({
  withPresentationHint: (body: string) => body,
}));
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: true, val: {} }),
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({ ATLASSIAN_ADMIN_TOKEN: 'atlassian-admin-token' }));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: () => null }));
jest.mock('@/lib/jira-admin/change-requests', () => {
  const actual = jest.requireActual<typeof import('@/lib/jira-admin/change-requests')>(
    '@/lib/jira-admin/change-requests'
  );
  return { ...actual, createChangeRequest: jest.fn(), cancelChangeRequest: jest.fn() };
});
jest.mock('./automation-client', () => {
  const actual = jest.requireActual<typeof import('./automation-client')>('./automation-client');
  return { ...actual, resolveAutomationAccess: jest.fn() };
});

import { authedFetch } from '@renkei/delegate-client';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerJiraAdminTools } from './index';
import type { JiraAdminAuth } from './jira-admin-auth';
import { automationBaseFor, resolveAutomationAccess } from './automation-client';
import { FAKE_BASE } from '@/lib/jira-admin/fake-site.fixture';
import { createChangeRequest, type ChangeRequest } from '@/lib/jira-admin/change-requests';
import type {
  AutomationRulePayload,
  AutomationRunPayload,
  AutomationStatePayload,
} from '@/lib/jira-admin/automation';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const CHANGE_ID = 'b2c3d4e5-4b7f-4e0d-8f00-7a2f5b4d9c66';
const AUTO = automationBaseFor('cloud-1');

let site: Record<string, [number, unknown]>;
let requests: { method: string; url: string; body: unknown }[];

const stubAuth: JiraAdminAuth = {
  kind: 'oauth',
  resolve: async () => ({
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    accountId: 'acct-1',
    auth: authedFetch((url, init) => fetch(url, init), 'atlassian-admin:acct-1'),
  }),
};

const context = {
  subject: 'subject-1',
  origin: 'https://renkei.example',
  jiraAdminScopes: ['read:jira-user', 'read:jira-work'],
  jiraAdminTokenAvailable: true,
} as MCPToolContext;

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (toolName: string, _config: unknown, handler: ToolHandler) => {
      registered.set(toolName, handler);
    },
  } as unknown as McpServer;
  await registerJiraAdminTools(server, context, stubAuth);
  const handler = registered.get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';
const stored = <T>() =>
  jest.mocked(createChangeRequest).mock.calls[0]?.[1]?.payload as T | undefined;

const RULE = {
  uuid: 'rule-1',
  name: 'Escalate outages',
  state: 'ENABLED',
  description: 'Pages on-call',
  labels: ['ops'],
  ruleScopeARIs: ['ari:cloud:jira:cloud-1:project/10000'],
  updated: 1700000000000,
  authorAccountId: 'acct-1',
  actor: { type: 'ACCOUNT_ID', actor: 'acct-1' },
  trigger: { id: 't-1', type: 'jira.issue.event.trigger:created', value: {} },
  components: [
    { id: 'c-1', type: 'jira.issue.comment', value: { comment: 'Paging' }, children: [] },
  ],
};
const TIDY = {
  uuid: 'rule-2',
  name: 'Nightly tidy',
  state: 'DISABLED',
  ruleScopeARIs: [],
  updated: 1,
};
const TWIN = {
  uuid: 'rule-3',
  name: 'Nightly tidy',
  state: 'ENABLED',
  ruleScopeARIs: [],
  updated: 2,
};

beforeEach(() => {
  site = {
    [`${AUTO}/rest/v1/rule/summary`]: [200, { data: [RULE, TIDY, TWIN], links: {} }],
    [`${AUTO}/rest/v1/rule/rule-1?redactSensitiveFields=true`]: [
      200,
      { rule: RULE, connections: [] },
    ],
    [`${AUTO}/rest/v1/rule/rule-2?redactSensitiveFields=true`]: [
      200,
      { rule: TIDY, connections: [] },
    ],
    [`${FAKE_BASE}/rest/api/3/project/search?startAt=0&maxResults=100`]: [
      200,
      {
        isLast: true,
        values: [
          { id: '10000', key: 'OPS' },
          { id: '10300', key: 'HR' },
        ],
      },
    ],
    [`${FAKE_BASE}/rest/api/3/project/OPS`]: [200, { id: '10000', key: 'OPS' }],
    [`${FAKE_BASE}/rest/api/3/project/HR`]: [200, { id: '10300', key: 'HR' }],
    [`${FAKE_BASE}/rest/api/3/issue/OPS-1?fields=id`]: [200, { id: '10101', key: 'OPS-1' }],
    [`${FAKE_BASE}/rest/api/3/issue/OPS-2?fields=id`]: [200, { id: '10102', key: 'OPS-2' }],
  };
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });
    const [status, answer] = site[url] ?? [404, { message: 'No such thing.' }];
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  jest.mocked(resolveAutomationAccess).mockResolvedValue({
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    accountId: 'acct-1',
    email: 'dana@example.com',
    auth: authedFetch((url, init) => fetch(url, init), 'atlassian-admin-token:acct-1'),
    label: 'Atlassian API token',
    baseUrl: AUTO,
    apiToken: true,
  });
  jest.mocked(createChangeRequest).mockReset();
  jest.mocked(createChangeRequest).mockImplementation(async (_db, input) => {
    const now = new Date();
    const change: ChangeRequest = {
      id: CHANGE_ID,
      subject: input.subject,
      agentId: null,
      cloudId: input.cloudId,
      siteUrl: input.siteUrl ?? null,
      kind: input.kind,
      title: input.title,
      reason: input.reason ?? null,
      payload: input.payload,
      status: 'pending',
      results: null,
      expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      createdAt: now,
      updatedAt: now,
      appliedBy: null,
      appliedAt: null,
      cancelledAt: null,
    };
    return change;
  });
});

const onlyReads = () =>
  requests.every(
    (request) => request.method === 'GET' || request.url === `${AUTO}/rest/v1/rule/summary`
  );

describe('jira_admin_list_automation_rules', () => {
  it('lists each rule with its scope by space key, as the token’s owner', async () => {
    const result = text(await call('jira_admin_list_automation_rules'));
    expect(result).toContain('3 automation rules, as dana@example.com:');
    expect(result).toContain(
      'Escalate outages — rule-1 — enabled — OPS — labels: ops — updated 2023-11-14'
    );
    expect(result).toContain('Nightly tidy — rule-2 — disabled — site-wide');
    expect(onlyReads()).toBe(true);
  });

  it('filters by space through the project’s ARI', async () => {
    await call('jira_admin_list_automation_rules', { space: 'ops', state: 'enabled' });
    const search = requests.find((request) => request.url === `${AUTO}/rest/v1/rule/summary`);
    expect(search?.body).toEqual({
      limit: 50,
      state: 'ENABLED',
      scope: 'ari:cloud:jira:cloud-1:project/10000',
    });
  });

  it('says when no token is saved', async () => {
    jest.mocked(resolveAutomationAccess).mockResolvedValue('No Atlassian API token is saved.');
    const result = await call('jira_admin_list_automation_rules');
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('No Atlassian API token is saved.');
  });
});

describe('jira_admin_get_automation_rule', () => {
  it('shows a rule in words and as its definition JSON', async () => {
    const result = text(await call('jira_admin_get_automation_rule', { rule: 'Escalate outages' }));
    expect(result).toContain(
      'Trigger: jira.issue.event.trigger:created; 1 step (jira.issue.comment)'
    );
    expect(result).toContain('"ruleScopeARIs": [');
    expect(result).toContain('"type": "jira.issue.comment"');
  });

  it('refuses a name several rules share', async () => {
    const result = await call('jira_admin_get_automation_rule', { rule: 'Nightly tidy' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('2 automation rules are named “Nightly tidy” — pass the uuid');
  });
});

describe('jira_admin_propose_automation_rule_state', () => {
  it('proposes the switch for rules not in that state already, writing nothing', async () => {
    const result = await call('jira_admin_propose_automation_rule_state', {
      rules: ['rule-1', 'rule-2'],
      enabled: false,
      reason: 'Freeze week',
    });
    expect(result.isError).toBeUndefined();
    expect(onlyReads()).toBe(true);
    expect(stored<AutomationStatePayload>()).toEqual({
      rules: [{ uuid: 'rule-1', name: 'Escalate outages', from: 'ENABLED', to: 'DISABLED' }],
    });
    expect(jest.mocked(createChangeRequest).mock.calls[0]?.[1]).toMatchObject({
      kind: 'automation_state',
      title: 'Disable the automation rule “Escalate outages”',
      reason: 'Freeze week',
    });
    expect(text(result)).toContain('“Nightly tidy” is disabled already.');
    expect(text(result)).toContain(`https://renkei.example/jira-admin/changes/${CHANGE_ID}`);
  });
});

describe('jira_admin_propose_automation_rule', () => {
  it('creates from a copied rule, scoped to the spaces named, as the token’s owner', async () => {
    const result = await call('jira_admin_propose_automation_rule', {
      name: 'Escalate outages (HR)',
      copyFrom: 'rule-1',
      spaces: ['HR'],
      enabled: false,
    });
    expect(result.isError).toBeUndefined();
    const payload = stored<AutomationRulePayload>();
    expect(payload?.mode).toBe('create');
    expect(payload?.projects).toEqual([{ id: '10300', key: 'HR' }]);
    expect(payload?.rule).toMatchObject({
      name: 'Escalate outages (HR)',
      state: 'DISABLED',
      ruleScopeARIs: ['ari:cloud:jira:cloud-1:project/10300'],
      actor: { type: 'ACCOUNT_ID', actor: 'acct-1' },
      authorAccountId: 'acct-1',
      trigger: { type: 'jira.issue.event.trigger:created', value: {} },
    });
    expect(payload?.rule).not.toHaveProperty('uuid');
    expect(text(result)).toContain('Trigger and steps copied from “Escalate outages” (rule-1).');
  });

  it('needs a trigger and steps for a new rule, and exactly one source', async () => {
    const none = await call('jira_admin_propose_automation_rule', {
      name: 'Empty',
      spaces: ['OPS'],
    });
    expect(text(none)).toContain('Pass exactly one of definition or copyFrom');
    const bare = await call('jira_admin_propose_automation_rule', {
      name: 'Empty',
      definition: { components: [] },
    });
    expect(text(bare)).toContain('The definition needs a trigger');
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('updates only what is given, keeping the rest and the stamp it read', async () => {
    const result = await call('jira_admin_propose_automation_rule', {
      update: 'rule-1',
      description: 'Pages the on-call engineer',
      spaces: ['OPS', 'HR'],
      enabled: false,
    });
    expect(result.isError).toBeUndefined();
    const payload = stored<AutomationRulePayload>();
    expect(payload?.mode).toBe('update');
    expect(payload?.uuid).toBe('rule-1');
    expect(payload?.updatedAt).toBe(1700000000000);
    expect(payload?.changes).toEqual([
      'Set its description to “Pages the on-call engineer”',
      'Scope it to OPS, HR (was OPS)',
      'Disable it',
    ]);
    expect(payload?.rule).toMatchObject({
      name: 'Escalate outages',
      description: 'Pages the on-call engineer',
      state: 'DISABLED',
      ruleScopeARIs: [
        'ari:cloud:jira:cloud-1:project/10000',
        'ari:cloud:jira:cloud-1:project/10300',
      ],
      components: RULE.components,
    });
    expect(onlyReads()).toBe(true);
  });

  it('says when an update changes nothing', async () => {
    const result = await call('jira_admin_propose_automation_rule', {
      update: 'rule-1',
      labels: ['ops'],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Nothing to do');
  });
});

describe('jira_admin_propose_automation_run', () => {
  it('resolves issues to ids and refuses a disabled rule', async () => {
    const result = await call('jira_admin_propose_automation_run', {
      rule: 'Escalate outages',
      issues: ['ops-1', 'OPS-2'],
      inputs: { severity: 'high' },
    });
    expect(result.isError).toBeUndefined();
    expect(stored<AutomationRunPayload>()).toEqual({
      rule: { uuid: 'rule-1', name: 'Escalate outages' },
      issues: [
        { key: 'OPS-1', id: '10101' },
        { key: 'OPS-2', id: '10102' },
      ],
      userInputs: { severity: 'high' },
    });
    const disabled = await call('jira_admin_propose_automation_run', {
      rule: 'rule-2',
      issues: ['OPS-1'],
    });
    expect(text(disabled)).toContain('“Nightly tidy” is disabled, so it cannot run');
  });
});
