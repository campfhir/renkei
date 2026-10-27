/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Automation rules: how the three kinds read on the review page, what
 * reads back, and what applying sends to a fake Automation API — on the
 * API token's fetcher, at the Automation base, never the Jira gateway.
 * What must hold: a rule already in the asked state is left alone and a
 * rule that is gone reported; an update is refused once the rule's
 * `updated` stamp has moved; a run names each issue's answer and fails
 * only when none succeeded; a copied definition loses Jira's ids.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({ ATLASSIAN_ADMIN_TOKEN: 'atlassian-admin-token' }));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));

import { authedFetch } from '@renkei/delegate-client';
import type { JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import { automationBaseFor, issueAri } from '@/lib/mcp-tools/jira-admin/automation-client';
import { describeChange } from './describe';
import {
  applyAutomationRule,
  applyAutomationRun,
  applyAutomationState,
  automationRuleTitle,
  automationRunTitle,
  automationStateTitle,
  definitionForCopy,
  readAutomationRulePayload,
  readAutomationRunPayload,
  readAutomationStatePayload,
  readRuleSummaries,
  type AutomationRulePayload,
  type AutomationRunPayload,
  type AutomationStatePayload,
} from './automation';

const BASE = automationBaseFor('cloud-1');

const access: JiraAdminAccess = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-1',
  auth: authedFetch((url, init) => fetch(url, init), 'atlassian-admin-token:acct-1'),
  label: 'Atlassian API token',
  baseUrl: BASE,
  apiToken: true,
};
const scope = { subject: 'subject-1' };

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
    { id: 'c-1', type: 'jira.issue.condition', value: { field: 'priority' }, children: [] },
    { id: 'c-2', type: 'jira.issue.comment', value: { comment: 'Paging' }, children: [] },
  ],
};

function statePayload(): AutomationStatePayload {
  return {
    rules: [
      { uuid: 'rule-1', name: 'Escalate outages', from: 'ENABLED', to: 'DISABLED' },
      { uuid: 'rule-gone', name: 'Old rule', from: 'ENABLED', to: 'DISABLED' },
    ],
  };
}

function updatePayload(): AutomationRulePayload {
  return {
    mode: 'update',
    uuid: 'rule-1',
    name: 'Escalate outages',
    projects: [{ id: '10000', key: 'OPS' }],
    updatedAt: 1700000000000,
    rule: { ...RULE, description: 'Pages the on-call engineer' },
    changes: ['Set its description to “Pages the on-call engineer”'],
  };
}

function runPayload(): AutomationRunPayload {
  return {
    rule: { uuid: 'rule-1', name: 'Escalate outages' },
    issues: [
      { key: 'OPS-1', id: '10101' },
      { key: 'OPS-2', id: '10102' },
    ],
    userInputs: { severity: 'high' },
  };
}

let site: Record<string, [number, unknown]>;
let requests: { method: string; url: string; body: unknown }[];

beforeEach(() => {
  site = {
    '/rest/v1/rule/rule-1?redactSensitiveFields=true': [200, { rule: RULE, connections: [] }],
    '/rest/v1/rule/rule-gone?redactSensitiveFields=true': [404, { message: 'Not found' }],
    '/rest/v1/rule/rule-1/state': [200, {}],
    '/rest/v1/rule/rule-1': [200, { ruleUuid: 'rule-1' }],
    '/rest/v1/rule': [201, { ruleUuid: 'rule-new' }],
    '/rest/v1/rule/manual/rule-1/invocation': [
      200,
      {
        'ari:cloud:jira:cloud-1:issue/10101': 'SUCCESS',
        'ari:cloud:jira:cloud-1:issue/10102': 'INVALID_TARGET_OBJECT',
      },
    ],
    '/rest/v1/rule/summary': [
      200,
      {
        data: [
          RULE,
          { uuid: 'rule-2', name: 'Nightly tidy', state: 'DISABLED', ruleScopeARIs: [] },
        ],
        links: {},
      },
    ],
  };
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const [status, answer] = site[path] ?? [404, { message: 'No such thing.' }];
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
});

describe('describing', () => {
  it('says what each kind does, and that it runs on the API token', () => {
    const state = describeChange({
      kind: 'automation_state',
      payload: statePayload(),
      siteUrl: 'https://acme.atlassian.net',
    });
    expect(state.operations.map((operation) => operation.text)).toEqual([
      'Disable the automation rule “Escalate outages”',
      'Disable the automation rule “Old rule”',
    ]);
    expect(state.reach).toBe(
      'Automation rules on https://acme.atlassian.net: every space a rule is scoped to sees it. ' +
        'Runs on your Atlassian API token, as you.'
    );
    expect(state.applyNote).toContain('Atlassian API token');
    expect(automationStateTitle(statePayload())).toBe('Disable 2 automation rules');

    const update = describeChange({
      kind: 'automation_rule',
      payload: updatePayload(),
      siteUrl: null,
    });
    expect(update.operations[0]?.text).toBe('Change the automation rule “Escalate outages” in OPS');
    expect(update.operations[0]?.details).toEqual([
      'Set its description to “Pages the on-call engineer”',
    ]);
    expect(update.siteWide).toBe(false);
    expect(automationRuleTitle(updatePayload())).toBe(
      'Change the automation rule “Escalate outages”'
    );

    const create = describeChange({
      kind: 'automation_rule',
      payload: { ...updatePayload(), mode: 'create', uuid: null, projects: [], changes: [] },
      siteUrl: null,
    });
    expect(create.operations[0]?.text).toBe(
      'Create the automation rule “Escalate outages”, site-wide, enabled'
    );
    expect(create.operations[0]?.details).toEqual([
      'Trigger: jira.issue.event.trigger:created; 2 steps (jira.issue.condition, jira.issue.comment)',
      'Labels: ops',
      'Description: Pages the on-call engineer',
    ]);
    expect(create.siteWide).toBe(true);

    const run = describeChange({ kind: 'automation_run', payload: runPayload(), siteUrl: null });
    expect(run.operations[0]?.text).toBe(
      'Run the manual rule “Escalate outages” on OPS-1 and OPS-2'
    );
    expect(run.operations[0]?.details).toEqual(['With inputs: {"severity":"high"}']);
    expect(run.reach).toContain('the rule’s actions run on them now, once');
    expect(automationRunTitle(runPayload())).toBe('Run “Escalate outages” on 2 issues');
  });

  it('reads back exactly what it wrote, and nothing else', () => {
    expect(readAutomationStatePayload(statePayload())).toEqual(statePayload());
    expect(
      readAutomationStatePayload({ rules: [{ uuid: 'x', from: 'ON', to: 'OFF' }] })
    ).toBeNull();
    expect(readAutomationRulePayload(updatePayload())).toEqual(updatePayload());
    expect(readAutomationRulePayload({ ...updatePayload(), uuid: '' })).toBeNull();
    expect(readAutomationRulePayload({ ...updatePayload(), rule: {} })).toBeNull();
    expect(readAutomationRunPayload(runPayload())).toEqual(runPayload());
    expect(readAutomationRunPayload({ ...runPayload(), issues: [] })).toBeNull();
  });

  it('strips what Jira assigned from a copied definition', () => {
    const copy = definitionForCopy({ ...RULE, created: 1, collaborators: ['x'] });
    expect(copy).not.toHaveProperty('uuid');
    expect(copy).not.toHaveProperty('updated');
    expect(copy).not.toHaveProperty('authorAccountId');
    expect(copy).not.toHaveProperty('collaborators');
    expect(copy.trigger).toEqual({ type: 'jira.issue.event.trigger:created', value: {} });
    expect(copy.components).toEqual([
      { type: 'jira.issue.condition', value: { field: 'priority' }, children: [] },
      { type: 'jira.issue.comment', value: { comment: 'Paging' }, children: [] },
    ]);
  });
});

describe('reading', () => {
  it('lists summaries by a POST search at the Automation base, naming scoped spaces by id', async () => {
    const read = await readRuleSummaries(scope, access, { state: 'ENABLED' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.rules.map((rule) => [rule.uuid, rule.projectIds])).toEqual([
      ['rule-1', ['10000']],
      ['rule-2', []],
    ]);
    expect(requests[0]).toEqual({
      method: 'POST',
      url: `${BASE}/rest/v1/rule/summary`,
      body: { limit: 50, state: 'ENABLED' },
    });
    expect(
      requests[0]?.url.startsWith('https://api.atlassian.com/automation/public/jira/cloud-1')
    ).toBe(true);
  });
});

describe('applying', () => {
  it('switches each rule after reading it, reporting one that is gone', async () => {
    const outcome = await applyAutomationState(scope, access, statePayload());
    expect(outcome.status).toBe('partial');
    expect(outcome.results).toEqual([
      { label: 'Disable the automation rule “Escalate outages”', outcome: 'done' },
      {
        label: 'Disable the automation rule “Old rule”',
        outcome: 'failed',
        detail: 'The rule no longer exists.',
      },
    ]);
    const writes = requests.filter((request) => request.method === 'PUT');
    expect(writes).toEqual([
      { method: 'PUT', url: `${BASE}/rest/v1/rule/rule-1/state`, body: { value: 'DISABLED' } },
    ]);
  });

  it('leaves a rule already in the asked state alone', async () => {
    const payload = statePayload();
    payload.rules = [{ uuid: 'rule-1', name: 'Escalate outages', from: 'DISABLED', to: 'ENABLED' }];
    const outcome = await applyAutomationState(scope, access, payload);
    expect(outcome.status).toBe('applied');
    expect(outcome.results[0]?.detail).toBe('It was enabled already.');
    expect(requests.some((request) => request.method === 'PUT')).toBe(false);
  });

  it('sends an update back in full, and refuses one once the rule has moved on', async () => {
    let outcome = await applyAutomationRule(scope, access, updatePayload());
    expect(outcome.status).toBe('applied');
    expect(requests.at(-1)).toEqual({
      method: 'PUT',
      url: `${BASE}/rest/v1/rule/rule-1`,
      body: { rule: updatePayload().rule },
    });

    site['/rest/v1/rule/rule-1?redactSensitiveFields=true'] = [
      200,
      { rule: { ...RULE, updated: 1700000999000 }, connections: [] },
    ];
    outcome = await applyAutomationRule(scope, access, updatePayload());
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]?.detail).toContain('has been changed since this was proposed');
  });

  it('creates a rule and says its uuid', async () => {
    const payload: AutomationRulePayload = {
      ...updatePayload(),
      mode: 'create',
      uuid: null,
      updatedAt: null,
      changes: [],
    };
    const outcome = await applyAutomationRule(scope, access, payload);
    expect(outcome.status).toBe('applied');
    expect(outcome.results[0]?.detail).toBe('Created as rule-new.');
    expect(requests.at(-1)?.body).toEqual({ rule: payload.rule });
  });

  it('runs a manual rule on each issue and names each answer', async () => {
    const outcome = await applyAutomationRun(scope, access, runPayload(), (id) =>
      issueAri('cloud-1', id)
    );
    expect(outcome.status).toBe('applied');
    expect(outcome.results[0]?.detail).toBe('OPS-1: SUCCESS; OPS-2: INVALID_TARGET_OBJECT');
    expect(requests.at(-1)).toEqual({
      method: 'POST',
      url: `${BASE}/rest/v1/rule/manual/rule-1/invocation`,
      body: {
        objects: ['ari:cloud:jira:cloud-1:issue/10101', 'ari:cloud:jira:cloud-1:issue/10102'],
        userInputs: { severity: 'high' },
      },
    });

    site['/rest/v1/rule/rule-1?redactSensitiveFields=true'] = [
      200,
      { rule: { ...RULE, state: 'DISABLED' }, connections: [] },
    ];
    const refused = await applyAutomationRun(scope, access, runPayload(), (id) =>
      issueAri('cloud-1', id)
    );
    expect(refused.status).toBe('failed');
    expect(refused.results[0]?.detail).toBe('The rule is disabled now, so it was not run.');
  });

  it('reads a 401 as the token, not a scope', async () => {
    site['/rest/v1/rule/rule-1?redactSensitiveFields=true'] = [401, { message: 'Unauthorized' }];
    const outcome = await applyAutomationState(scope, access, {
      rules: [statePayload().rules[0] as AutomationStatePayload['rules'][number]],
    });
    expect(outcome.results[0]?.detail).toContain('Atlassian refused the Atlassian API token (401)');
    expect(outcome.results[0]?.detail).toContain('Save a new one on the Connectors page');
  });
});
