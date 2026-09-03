/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_move_issues: the preflight (required fields, work type, request
 * type follows work type), the bulk-move submission and its polling, the
 * re-keying read-back, and the service-desk follow-up edit.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';

jest.mock('../common', () => ({
  getCachedDisplayName: () => 'Tester',
  withPresentationHint: (body: string, suggestion: string) =>
    `${body}\n\n(Presentation hint: ${suggestion})`,
  issueUrl: (siteUrl: string, issueKey: string) => `${siteUrl}/browse/${issueKey}`,
  requestUrl: (siteUrl: string, issueKey: string) =>
    `${siteUrl}/servicedesk/customer/portals/all/requests/${issueKey}`,
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import { registerMoveTools } from './move';
import { clearFieldSchemaCache } from './field-schema';
import { clearProjectTypeCache } from './issue-urls';
import type { JiraAuth } from './jira-auth';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** A Jira 400 as jiraFetch raises it. */
class FakeJiraApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public fieldErrors: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

let calls: Call[] = [];
let responder: (call: Call) => unknown;

function stubAuth(): JiraAuth {
  return {
    kind: 'oauth',
    fetch: async (_scopes, path, init) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const body = responder(call);
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body), { status: 200 });
    },
  };
}

async function tools(): Promise<Map<string, ToolHandler>> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerMoveTools(
    server,
    {
      tenantId: 'tenant-1',
      accountId: 'acct-1',
      siteUrl: 'https://example.atlassian.net',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
    } as unknown as MCPToolContext,
    stubAuth(),
    { sleep: async () => {}, pollBudgetMs: 10_000 }
  );
  return registered;
}

// ——— A site ————————————————————————————————————————————————————————————

const FIELD_SCHEMA = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' }, clauseNames: [] },
  {
    id: 'components',
    name: 'Components',
    custom: false,
    schema: { type: 'array', items: 'component' },
    clauseNames: ['component'],
  },
  {
    id: 'customfield_10010',
    name: 'Request Type',
    custom: true,
    schema: { type: 'sd-customerrequesttype', custom: 'com.atlassian.servicedesk:vp-origin' },
    clauseNames: ['Request Type'],
  },
  {
    id: 'customfield_10020',
    name: 'Team',
    custom: true,
    schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
    clauseNames: ['Team'],
  },
  {
    id: 'customfield_10030',
    name: 'Legacy Ref',
    custom: true,
    schema: {
      type: 'string',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
    },
    clauseNames: ['Legacy Ref'],
  },
  {
    id: 'customfield_10040',
    name: 'Time to resolution',
    custom: true,
    schema: { type: 'sd-sla-field', custom: 'com.atlassian.servicedesk:sd-sla-field' },
    clauseNames: [],
  },
];

const ENG = { id: '10000', key: 'ENG', name: 'Engineering', projectTypeKey: 'software' };
const OPS = { id: '10100', key: 'OPS', name: 'Operations', projectTypeKey: 'business' };
const DESK = { id: '10200', key: 'HELP', name: 'IT Help Desk', projectTypeKey: 'service_desk' };
const PROJECTS = [ENG, OPS, DESK];

const TASK = { id: '3', name: 'Task', subtask: false };
const BUG = { id: '4', name: 'Bug', subtask: false };
const SUBTASK = { id: '5', name: 'Subtask', subtask: true };
const SERVICE_REQUEST = { id: '10001', name: '[System] Service request', subtask: false };
const INCIDENT = { id: '10002', name: '[System] Incident', subtask: false };

const WORK_TYPES: Record<string, unknown[]> = {
  [ENG.id]: [TASK, BUG, SUBTASK],
  [OPS.id]: [TASK, SUBTASK],
  [DESK.id]: [SERVICE_REQUEST, INCIDENT, SUBTASK],
};

const REQUEST_TYPES = [
  { id: '25', name: 'Get IT help', issueTypeId: SERVICE_REQUEST.id },
  { id: '26', name: 'Report an outage', issueTypeId: INCIDENT.id },
  { id: '27', name: 'Report a problem', issueTypeId: INCIDENT.id },
];

function issue(
  id: string,
  key: string,
  summary: string,
  extra: Record<string, unknown> = {},
  project: typeof ENG = ENG,
  issuetype: typeof TASK = TASK
) {
  return {
    id,
    key,
    fields: {
      summary,
      issuetype,
      project,
      status: { name: 'To Do' },
      subtasks: [],
      ...extra,
    },
  };
}

/** Per-project create screens; `required` and presence are what the preflight reads. */
let createMeta: Record<string, unknown[]> = {};
/** What the queue reports once polled. */
let taskProgress: unknown[] = [];
/** The keys issues have after the move, by id. */
let movedKeys: Record<string, string> = {};
let sourceIssues: unknown[] = [];

function serve(): void {
  responder = (call) => {
    const { path, method, body } = call;
    if (path === '/rest/api/3/field') return FIELD_SCHEMA;
    if (path.startsWith('/rest/api/3/project/search')) {
      const url = new URL(`https://x${path}`);
      const query = url.searchParams.get('query')?.toLowerCase();
      const id = url.searchParams.get('id');
      return {
        values: PROJECTS.filter((p) =>
          id
            ? p.id === id
            : p.key.toLowerCase() === query || p.name.toLowerCase().includes(query ?? '')
        ),
      };
    }
    if (path.startsWith('/rest/api/3/project/')) {
      const key = decodeURIComponent(path.split('/').pop() ?? '');
      return PROJECTS.find((p) => p.key === key) ?? new FakeJiraApiError('Not found', 404);
    }
    if (path.startsWith('/rest/api/3/issuetype/project?projectId=')) {
      return WORK_TYPES[path.split('=').pop() ?? ''] ?? [];
    }
    if (path.startsWith('/rest/api/3/issue/createmeta/')) {
      const [projectId, , typeId] = path.replace('/rest/api/3/issue/createmeta/', '').split('/');
      return { fields: createMeta[`${projectId}/${typeId?.split('?')[0]}`] ?? [] };
    }
    if (path.startsWith('/rest/api/3/issue/createmeta?')) {
      // buildFieldUpdates' allowed-value enrichment for supplied option fields.
      return {
        projects: [
          {
            key: 'OPS',
            issuetypes: [
              {
                id: TASK.id,
                name: TASK.name,
                fields: {
                  customfield_10020: {
                    allowedValues: [
                      { id: '901', value: 'Platform' },
                      { id: '902', value: 'Network' },
                    ],
                  },
                },
              },
            ],
          },
        ],
      };
    }
    if (path === '/rest/api/3/issue/bulkfetch' && method === 'POST') {
      const wanted = ((body?.issueIdsOrKeys as string[]) ?? []).map(String);
      const fields = (body?.fields as string[]) ?? [];
      if (fields[0] === 'summary') {
        // The post-move read-back, by id.
        return {
          issues: wanted
            .filter((id) => movedKeys[id])
            .map((id) => ({ id, key: movedKeys[id], fields: { summary: `moved ${id}` } })),
        };
      }
      const found = (sourceIssues as { key: string }[]).filter((entry) =>
        wanted.includes(entry.key)
      );
      return {
        issues: found,
        issueErrors: wanted
          .filter((key) => !found.some((entry) => entry.key === key))
          .map((key) => ({ id: key, errorMessage: 'not found' })),
      };
    }
    if (path.startsWith('/rest/servicedeskapi/servicedesk/HELP')) {
      return { id: '7', projectKey: 'HELP' };
    }
    if (path.startsWith('/rest/servicedeskapi/servicedesk/7/requesttype')) {
      return { values: REQUEST_TYPES, isLastPage: true };
    }
    if (path.startsWith('/rest/servicedeskapi/')) {
      return new FakeJiraApiError('Unauthorized', 401);
    }
    if (path === '/rest/api/3/bulk/issues/move' && method === 'POST') {
      return { taskId: '777' };
    }
    if (path.startsWith('/rest/api/3/bulk/queue/')) {
      const next = taskProgress.length > 1 ? taskProgress.shift() : taskProgress[0];
      return next ?? { taskId: '777', status: 'COMPLETE', progressPercent: 100 };
    }
    if (method === 'PUT' && path.startsWith('/rest/api/3/issue/')) return {};
    if (method === 'POST' && path.endsWith('/comment')) return { id: '1' };
    throw new Error(`unexpected call ${method} ${path}`);
  };
}

function complete(processed: string[], failed: Record<string, string[]> = {}) {
  return {
    taskId: '777',
    status: 'COMPLETE',
    progressPercent: 100,
    processedAccessibleIssues: processed.map(Number),
    failedAccessibleIssues: failed,
    totalIssueCount: processed.length + Object.keys(failed).length,
  };
}

function text(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

function movePayload(): Record<string, unknown> {
  const call = calls.find((entry) => entry.path === '/rest/api/3/bulk/issues/move');
  return call?.body ?? {};
}

function puts(): Call[] {
  return calls.filter((call) => call.method === 'PUT');
}

beforeEach(() => {
  calls = [];
  createMeta = {};
  taskProgress = [];
  movedKeys = {};
  sourceIssues = [];
  clearFieldSchemaCache();
  clearProjectTypeCache();
  serve();
});

describe('jira_move_issues — a plain project move', () => {
  it('moves the issues, keeps the work type by name, and reports the new keys', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Fix the pump'), issue('102', 'ENG-2', 'Replace valve')];
    createMeta[`${OPS.id}/${TASK.id}`] = [
      { fieldId: 'summary', name: 'Summary', required: true },
      { fieldId: 'customfield_10030', name: 'Legacy Ref', required: false },
    ];
    taskProgress = [
      { taskId: '777', status: 'RUNNING', progressPercent: 40 },
      complete(['101', '102']),
    ];
    movedKeys = { '101': 'OPS-7', '102': 'OPS-8' };

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({ issueKeys: ['ENG-1', 'ENG-2'], targetProjectKey: 'ops' });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Moved 2 of 2 issue(s) to Operations (OPS) as Task:');
    expect(text(result)).toContain('• ENG-1 → OPS-7 — Fix the pump');
    expect(text(result)).toContain('• ENG-2 → OPS-8 — Replace valve');
    expect(text(result)).toContain('[Open in Jira](https://example.atlassian.net/browse/OPS-7)');

    expect(movePayload()).toEqual({
      sendBulkNotification: false,
      targetToSourcesMapping: {
        '10100,3': {
          issueIdsOrKeys: ['101', '102'],
          inferClassificationDefaults: true,
          inferStatusDefaults: true,
          inferSubtaskTypeDefault: true,
          inferFieldDefaults: true,
        },
      },
    });
    // Polled until the queue said COMPLETE — two reads for two answers.
    expect(calls.filter((call) => call.path === '/rest/api/3/bulk/queue/777')).toHaveLength(2);
    // Nothing to write after a move into a plain project.
    expect(puts()).toHaveLength(0);
    expect(result._meta).toEqual({
      'renkei/act': {
        id: 'OPS-7',
        url: 'https://example.atlassian.net/browse/OPS-7',
        entity: 'issues',
      },
    });
  });

  it('reads the source issues in one bulkfetch, without the heavy collections', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Fix the pump')];
    taskProgress = [complete(['101'])];
    movedKeys = { '101': 'OPS-7' };

    const move = (await tools()).get('jira_move_issues')!;
    await move({ issueKeys: ['ENG-1'], targetProjectKey: 'OPS' });

    const fetch = calls.find((call) => call.path === '/rest/api/3/issue/bulkfetch');
    expect(fetch?.body).toEqual({
      issueIdsOrKeys: ['ENG-1'],
      fields: ['*all', '-comment', '-attachment', '-worklog', '-watches', '-votes'],
    });
  });

  it('refuses before moving when a required target field is empty on a source issue', async () => {
    sourceIssues = [
      issue('101', 'ENG-1', 'Has a team', { customfield_10020: { id: '901', value: 'Platform' } }),
      issue('102', 'ENG-2', 'No team'),
    ];
    createMeta[`${OPS.id}/${TASK.id}`] = [
      {
        fieldId: 'customfield_10020',
        name: 'Team',
        required: true,
        allowedValues: [{ value: 'Platform' }, { value: 'Network' }],
      },
    ];

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({ issueKeys: ['ENG-1', 'ENG-2'], targetProjectKey: 'OPS' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Nothing was moved.');
    expect(text(result)).toContain(
      '• Team (customfield_10020) is required for Task in OPS and empty on ENG-2 — pass it in fields (valid: Platform, Network).'
    );
    expect(movePayload()).toEqual({});
  });

  it('fills a required target field from `fields`, via the move and a follow-up edit', async () => {
    sourceIssues = [issue('102', 'ENG-2', 'No team')];
    createMeta[`${OPS.id}/${TASK.id}`] = [
      { fieldId: 'customfield_10020', name: 'Team', required: true },
    ];
    taskProgress = [complete(['102'])];
    movedKeys = { '102': 'OPS-9' };

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({
      issueKeys: ['ENG-2'],
      targetProjectKey: 'OPS',
      fields: { Team: 'Network' },
    });

    expect(result.isError).toBeUndefined();
    const mapping = (
      movePayload().targetToSourcesMapping as Record<string, Record<string, unknown>>
    )['10100,3'];
    expect(mapping?.inferFieldDefaults).toBe(false);
    expect(mapping?.targetMandatoryFields).toEqual([
      { fields: { customfield_10020: { retain: false, type: 'raw', value: ['902'] } } },
    ]);
    // And the same value set on the moved issue, in the edit API's own shape.
    expect(puts()).toEqual([
      {
        method: 'PUT',
        path: '/rest/api/3/issue/OPS-9',
        body: { fields: { customfield_10020: { id: '902' } } },
      },
    ]);
  });

  it('warns about values the target cannot hold, and clears project-scoped ones', async () => {
    sourceIssues = [
      issue('101', 'ENG-1', 'Old ref', {
        customfield_10030: 'LEG-77',
        components: [{ id: '1', name: 'Pumps' }],
        customfield_10040: { ongoingCycle: {} },
      }),
    ];
    createMeta[`${OPS.id}/${TASK.id}`] = [{ fieldId: 'summary', name: 'Summary', required: true }];
    taskProgress = [complete(['101'])];
    movedKeys = { '101': 'OPS-7' };

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({ issueKeys: ['ENG-1'], targetProjectKey: 'OPS' });

    expect(text(result)).toContain(
      '• Project-scoped values will be cleared by the move: Components (ENG-1).'
    );
    expect(text(result)).toContain(
      '• Not on the Task create screen in OPS — Jira may clear these on move: Legacy Ref (ENG-1).'
    );
    // SLA fields are derived, never "lost".
    expect(text(result)).not.toContain('Time to resolution');
  });

  it('needs a work type when the target has no type of the same name', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'A bug', {}, ENG, BUG)];

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({ issueKeys: ['ENG-1'], targetProjectKey: 'OPS' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      'Operations (OPS) has no work type named "Bug" to keep; pass targetWorkType — one of: Task (3), Subtask (5).'
    );
  });

  it('needs a parent when the target work type is a subtask type', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'A task')];

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'OPS',
      targetWorkType: 'Subtask',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Subtask is a subtask type, so targetParentKey');
  });

  it('puts the parent into the mapping key', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'A task')];
    taskProgress = [complete(['101'])];
    movedKeys = { '101': 'OPS-12' };

    const move = (await tools()).get('jira_move_issues')!;
    await move({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'OPS',
      targetWorkType: 'Subtask',
      targetParentKey: 'OPS-3',
    });

    expect(Object.keys(movePayload().targetToSourcesMapping as object)).toEqual(['10100,5,OPS-3']);
  });

  it('reports the issues Jira failed, with its reasons, and the ones that moved', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Moves'), issue('102', 'ENG-2', 'Stays')];
    taskProgress = [complete(['101'], { '102': ['Issue is archived'] })];
    movedKeys = { '101': 'OPS-7' };

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({ issueKeys: ['ENG-1', 'ENG-2'], targetProjectKey: 'OPS' });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Moved 1 of 2 issue(s)');
    expect(text(result)).toContain('Not moved:\n• ENG-2: Issue is archived');
  });

  it('hands back the task id when the queue is still running at the budget', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Slow')];
    taskProgress = [{ taskId: '777', status: 'RUNNING', progressPercent: 10 }];

    const registered = new Map<string, ToolHandler>();
    await registerMoveTools(
      {
        registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
          registered.set(name, handler);
        },
      } as unknown as McpServer,
      {
        tenantId: 't',
        accountId: 'a',
        siteUrl: 'https://example.atlassian.net',
      } as unknown as MCPToolContext,
      stubAuth(),
      { sleep: async () => {}, pollBudgetMs: 0 }
    );
    const result = await registered.get('jira_move_issues')!({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'OPS',
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('still running in Jira (task 777, RUNNING, 10%)');
    expect(text(result)).toContain('jira_get_bulk_operation taskId=777');
  });

  it('refuses a move into the project and work type the issue already has', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Here already')];

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({ issueKeys: ['ENG-1'], targetProjectKey: 'ENG' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Already in ENG as Task: ENG-1.');
  });

  it('names issues Jira could not find instead of moving the rest', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Real')];

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({ issueKeys: ['ENG-1', 'ENG-999'], targetProjectKey: 'OPS' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('• ENG-999: not found or not visible to you');
    expect(movePayload()).toEqual({});
  });
});

describe('jira_move_issues — into a service desk', () => {
  it('infers the request type from the work type and sets it after the move', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Laptop broken')];
    taskProgress = [complete(['101'])];
    movedKeys = { '101': 'HELP-40' };

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'HELP',
      targetWorkType: '[System] Service request',
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain(
      'Moved 1 of 1 issue(s) to IT Help Desk (HELP) as [System] Service request:'
    );
    expect(text(result)).toContain('Request type "Get IT help" set on HELP-40.');
    expect(puts()).toEqual([
      {
        method: 'PUT',
        path: '/rest/api/3/issue/HELP-40',
        body: { fields: { customfield_10010: '25' } },
      },
    ]);
    // Both links, since the destination is a service desk.
    expect(text(result)).toContain('[Customer portal](');
  });

  it('asks for a choice when several request types are backed by the work type', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Outage')];

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'HELP',
      targetWorkType: INCIDENT.id,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      '2 request types in IT Help Desk are backed by [System] Incident — pass targetRequestType: Report an outage (26), Report a problem (27).'
    );
    expect(movePayload()).toEqual({});
  });

  it('accepts a chosen request type by name when it matches the work type', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Outage')];
    taskProgress = [complete(['101'])];
    movedKeys = { '101': 'HELP-41' };

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'HELP',
      targetWorkType: '[System] Incident',
      targetRequestType: 'report an outage',
    });

    expect(result.isError).toBeUndefined();
    expect(puts()[0]?.body).toEqual({ fields: { customfield_10010: '26' } });
  });

  it('refuses a request type backed by a different work type', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Outage')];

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'HELP',
      targetWorkType: '[System] Service request',
      targetRequestType: 'Report an outage',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      'Request type "Report an outage" is backed by [System] Incident, not [System] Service request — a request type follows its work type. Either pass targetWorkType "[System] Incident", or keep [System] Service request and choose one of: Get IT help (25).'
    );
  });

  it('moves anyway, with a warning, when no request type is backed by the work type', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'A subtask-ish thing')];
    taskProgress = [complete(['101'])];
    movedKeys = { '101': 'HELP-42' };

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'HELP',
      targetWorkType: 'Subtask',
      targetParentKey: 'HELP-1',
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('No request type in IT Help Desk is backed by Subtask');
    expect(puts()).toHaveLength(0);
  });

  it('keeps the move and says so when the request type write is refused', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Laptop broken')];
    taskProgress = [complete(['101'])];
    movedKeys = { '101': 'HELP-40' };
    const base = responder;
    responder = (call) =>
      call.method === 'PUT'
        ? new FakeJiraApiError('Field customfield_10010 cannot be set', 400, {
            customfield_10010: 'cannot be set',
          })
        : base(call);

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'HELP',
      targetWorkType: SERVICE_REQUEST.id,
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('• ENG-1 → HELP-40');
    expect(text(result)).toContain(
      'Request type was not set on HELP-40 — Field customfield_10010 cannot be set. Set it with jira_update_issue: fields {"Request Type": "25"}.'
    );
  });

  it('warns that request types are lost when leaving a service desk', async () => {
    sourceIssues = [issue('301', 'HELP-9', 'Was a request', {}, DESK, SERVICE_REQUEST)];
    taskProgress = [complete(['301'])];
    movedKeys = { '301': 'OPS-20' };

    const move = (await tools()).get('jira_move_issues')!;
    const result = await move({
      issueKeys: ['HELP-9'],
      targetProjectKey: 'OPS',
      targetWorkType: 'Task',
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain(
      'Operations (OPS) is not a service desk: request types, SLAs and customer portal visibility do not carry over.'
    );
  });
});

describe('jira_move_issues_preview', () => {
  it('renders the plan as a card without moving anything', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Laptop broken', { components: [{ name: 'Pumps' }] })];

    const preview = (await tools()).get('jira_move_issues_preview')!;
    const result = await preview({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'HELP',
      targetWorkType: '[System] Service request',
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("awaiting the user's decision on the preview card");
    expect(movePayload()).toEqual({});
    expect(puts()).toHaveLength(0);

    const card = result.structuredContent!;
    expect(card.kind).toBe('issue');
    expect(card.title).toBe('Move ENG-1 to HELP');
    expect(card.subtitle).toBe('IT Help Desk · [System] Service request');
    expect(card.confirmTool).toBe('jira_move_issues_confirm');
    expect(card.confirmLabel).toBe('Move');
    expect(typeof card.previewId).toBe('string');
    const rows = card.fields as { label: string; value: string; oldValue?: string }[];
    expect(rows).toEqual(
      expect.arrayContaining([
        { label: 'Issue', value: 'ENG-1 — Laptop broken' },
        {
          label: 'Destination',
          value: 'IT Help Desk (HELP) · [System] Service request',
          oldValue: 'ENG · Task',
        },
        { label: 'Request type', value: 'Get IT help (25)' },
      ])
    );
    expect(rows.find((row) => row.label === 'Warnings')?.value).toContain('Components (ENG-1)');
  });

  it('returns the refusals instead of a card', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Outage')];

    const preview = (await tools()).get('jira_move_issues_preview')!;
    const result = await preview({
      issueKeys: ['ENG-1'],
      targetProjectKey: 'HELP',
      targetWorkType: 'Incident',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text(result)).toContain('has no work type "Incident"');
  });

  it('registers the confirm twin on the same handler', async () => {
    sourceIssues = [issue('101', 'ENG-1', 'Fix')];
    taskProgress = [complete(['101'])];
    movedKeys = { '101': 'OPS-7' };

    const confirm = (await tools()).get('jira_move_issues_confirm')!;
    const result = await confirm({ issueKeys: ['ENG-1'], targetProjectKey: 'OPS' });

    expect(text(result)).toContain('• ENG-1 → OPS-7');
  });
});

describe('jira_get_bulk_operation', () => {
  it('renders progress, successes and failures', async () => {
    taskProgress = [complete(['101'], { '102': ['Issue is archived', 'and locked'] })];

    const status = (await tools()).get('jira_get_bulk_operation')!;
    const result = await status({ taskId: '777' });

    expect(calls).toEqual([{ method: 'GET', path: '/rest/api/3/bulk/queue/777', body: null }]);
    const body = text(result);
    expect(body).toContain('Bulk operation 777: COMPLETE (100%)');
    expect(body).toContain('Succeeded (issue ids): 101');
    expect(body).toContain('• issue 102: Issue is archived; and locked');
  });

  it('says to check again while it runs', async () => {
    taskProgress = [{ taskId: '777', status: 'RUNNING', progressPercent: 55 }];

    const status = (await tools()).get('jira_get_bulk_operation')!;
    const result = await status({ taskId: '777' });

    expect(text(result)).toContain('RUNNING (55%)');
    expect(text(result)).toContain('Still running');
  });
});
