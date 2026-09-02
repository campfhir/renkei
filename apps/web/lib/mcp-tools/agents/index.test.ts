/**
 * The agents tools' contract: access resolves through resolveAgentAccess
 * (owner or grantee — someone with neither reads an agentId as not-found),
 * the three definition-editing tools refuse agent-run callers and
 * enabled:true, writes are confirm-gated dry runs by default, and batch
 * knowledge operations report per-entry results.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@/lib/agents/store', () => ({ listAgents: jest.fn() }));
jest.mock('@/lib/agents/access-grants', () => ({
  resolveAgentAccess: jest.fn(),
  listAgentsSharedWith: jest.fn(async () => []),
}));
jest.mock('@/lib/identity', () => ({
  getIdentityEmail: jest.fn(async () => ({ ok: true, val: 'alice@example.com' })),
}));
jest.mock('@/lib/agents/save', () => ({ saveAgent: jest.fn() }));
jest.mock('@/lib/agents/describe', () => ({ renderStepsOutline: jest.fn(() => 'OUTLINE') }));
jest.mock('@/lib/agents/trigger-summary', () => ({ triggerSummary: jest.fn(() => 'on demand') }));
jest.mock('@/lib/agents/runs-view', () => ({
  listRunsForOwner: jest.fn(),
  getRunForOwner: jest.fn(),
}));
jest.mock('@/lib/agents/run-debug', () => ({ renderRunDebugMarkdown: jest.fn(() => 'DEBUG MD') }));
jest.mock('@/lib/agents/agent-notes', () => ({
  MAX_AGENT_NOTE_CHARS: 50_000,
  MAX_AGENT_NOTE_TITLE_CHARS: 200,
  listAgentNotes: jest.fn(),
  createAgentNote: jest.fn(),
  updateAgentNote: jest.fn(),
  deleteAgentNote: jest.fn(),
}));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ listAvailableTools: jest.fn() }));
jest.mock('@/lib/agents/approvals', () => ({
  listPendingApprovals: jest.fn(async () => []),
  decideApproval: jest.fn(),
  listPendingQuestions: jest.fn(async () => []),
  answerQuestion: jest.fn(),
}));
jest.mock('@renkei/queue', () => ({
  agentJobsQueue: () => ({ producer: { enqueue: jest.fn() } }),
}));
jest.mock('@renkei/agents/runs', () => ({
  createAgentRun: jest.fn(),
  findInProgressRun: jest.fn(),
}));
jest.mock('@/lib/agents/run-cancellation', () => ({ requestRunCancellation: jest.fn() }));
jest.mock('@renkei/agents/memory', () => ({
  readAgentMemory: jest.fn(async () => ({ summary: null, entries: [] })),
  renderAgentKnowledgeNotes: jest.fn(async () => ''),
  renderAgentMemory: jest.fn(() => ''),
  countAgentMemory: jest.fn(async () => ({ entries: 0, hasSummary: false })),
  forgetAgentMemory: jest.fn(async () => ({
    entriesDeleted: 0,
    summaryCleared: false,
    missingIds: [],
  })),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerAgentTools } from './index';
import type { MCPToolContext } from '../common';
import { APPROVAL_DEFAULT_TIMEOUT_HOURS, CURRENT_STEPS_VERSION } from '@renkei/agents';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const storeMock = jest.requireMock<{ listAgents: jest.Mock }>('@/lib/agents/store');
const accessGrantsMock = jest.requireMock<{
  resolveAgentAccess: jest.Mock;
  listAgentsSharedWith: jest.Mock;
}>('@/lib/agents/access-grants');
const identityMock = jest.requireMock<{ getIdentityEmail: jest.Mock }>('@/lib/identity');
const saveMock = jest.requireMock<{ saveAgent: jest.Mock }>('@/lib/agents/save');
const runsMock = jest.requireMock<{ listRunsForOwner: jest.Mock; getRunForOwner: jest.Mock }>(
  '@/lib/agents/runs-view'
);
const catalogMock = jest.requireMock<{ listAvailableTools: jest.Mock }>(
  '@/lib/mcp-tools/tool-catalog'
);
const approvalsMock = jest.requireMock<{
  listPendingApprovals: jest.Mock;
  decideApproval: jest.Mock;
  listPendingQuestions: jest.Mock;
  answerQuestion: jest.Mock;
}>('@/lib/agents/approvals');
const runNowMock = jest.requireMock<{ createAgentRun: jest.Mock; findInProgressRun: jest.Mock }>(
  '@renkei/agents/runs'
);
const memoryMock = jest.requireMock<{
  readAgentMemory: jest.Mock;
  countAgentMemory: jest.Mock;
  forgetAgentMemory: jest.Mock;
}>('@renkei/agents/memory');
const notesMock = jest.requireMock<{
  listAgentNotes: jest.Mock;
  createAgentNote: jest.Mock;
  updateAgentNote: jest.Mock;
  deleteAgentNote: jest.Mock;
}>('@/lib/agents/agent-notes');
const cancelMock = jest.requireMock<{ requestRunCancellation: jest.Mock }>(
  '@/lib/agents/run-cancellation'
);

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

/** The registered schema/description of each tool, by name. */
const configs = new Map<string, { description?: string; inputSchema?: unknown }>();

function registerAll(context: Partial<MCPToolContext>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  configs.clear();
  const server = {
    registerTool: (
      name: string,
      config: { description?: string; inputSchema?: unknown },
      handler: Handler
    ) => {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  registerAgentTools(server as unknown as McpServer, {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
    subject: 'auth0|alice',
    userEmail: 'alice@example.com',
    ...context,
  });
  return handlers;
}

/** A db whose select chains resolve to the given rows/row. */
function stubDb(options: { rows?: unknown[]; row?: unknown } = {}): void {
  const chain = {
    selectFrom: () => chain,
    innerJoin: () => chain,
    select: () => chain,
    where: () => chain,
    execute: async () => options.rows ?? [],
    executeTakeFirst: async () => options.row,
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: chain });
}

const AGENT = {
  id: 'agent-1',
  name: 'Triage',
  description: 'Sorts tickets.',
  descriptionStatus: 'ok',
  reviewNotes: null,
  steps: { version: 1, steps: [] },
  stepsVersion: 1,
  llmModelId: null,
  enabled: true,
  guardrails: 'Never invent numbers.',
  blockedTools: ['outlook_send_mail'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  triggers: [],
};

/** A minimal wire-valid steps document for create/update payloads. */
const STEPS_DOC = {
  version: 1,
  steps: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Do the thing',
      instruction: [{ t: 'text', v: 'Do it.' }],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    },
  ],
};

/** The AgentAccess shape resolveAgentAccess returns for the caller's own agent. */
const ownerAccess = (agent: unknown) => ({
  agent,
  ownerSubject: 'auth0|alice',
  viewerIsOwner: true,
  grant: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  stubDb();
  accessGrantsMock.resolveAgentAccess.mockResolvedValue(ownerAccess(AGENT));
  accessGrantsMock.listAgentsSharedWith.mockResolvedValue([]);
  identityMock.getIdentityEmail.mockResolvedValue({ ok: true, val: 'alice@example.com' });
});

test('the definition-editing tools refuse agent-run callers', async () => {
  const handlers = registerAll({ agent: { agentId: 'agent-9' } });
  for (const name of ['agent_create', 'agent_update']) {
    const result = await handlers.get(name)!({
      agentId: 'agent-1',
      name: 'X',
      steps: STEPS_DOC,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Agent runs cannot edit agent definitions');
  }
  expect(saveMock.saveAgent).not.toHaveBeenCalled();
});

test('agent_get returns the exact definition as raw JSON — no prose, no fence', async () => {
  const handlers = registerAll({});
  const result = await handlers.get('agent_get')!({ agentId: 'agent-1' });
  expect(result.isError).toBeUndefined();
  const parsed = JSON.parse(result.content[0]?.text ?? '');
  expect(parsed).toMatchObject({
    agentId: 'agent-1',
    enabled: true,
    name: 'Triage',
    guardrails: 'Never invent numbers.',
    blockedTools: ['outlook_send_mail'],
  });
  expect(parsed.steps).toEqual({ version: 1, steps: [] });
});

test('agent_get_description renders the readable view without the definition', async () => {
  const handlers = registerAll({});
  const result = await handlers.get('agent_get_description')!({ agentId: 'agent-1' });
  expect(result.isError).toBeUndefined();
  const text = result.content[0]?.text ?? '';
  expect(text).toContain('Triage — ON (agentId: agent-1)');
  expect(text).toContain('Standing guardrails:');
  expect(text).not.toContain('renkei-agent');
});

test('read, knowledge, and memory tools stay available to agent-run callers', async () => {
  storeMock.listAgents.mockResolvedValue([AGENT]);
  const handlers = registerAll({ agent: { agentId: 'agent-9' } });
  const result = await handlers.get('agent_list')!({});
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('Triage');
});

test('enabled:true is refused outright on create and update', async () => {
  const handlers = registerAll({});
  for (const name of ['agent_create', 'agent_update']) {
    const result = await handlers.get(name)!({
      agentId: 'agent-1',
      name: 'X',
      steps: STEPS_DOC,
      enabled: true,
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('builder');
  }
  expect(saveMock.saveAgent).not.toHaveBeenCalled();
});

test('agent_create without confirm is a dry run that persists nothing', async () => {
  saveMock.saveAgent.mockResolvedValue({
    outcome: 'valid-dry-run',
    normalized: { name: 'X', steps: STEPS_DOC, triggers: [], enabled: false, guardrails: null },
  });
  const handlers = registerAll({});
  const result = await handlers.get('agent_create')!({ name: 'X', steps: STEPS_DOC });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('Nothing was saved');
  expect(saveMock.saveAgent).toHaveBeenCalledWith(
    expect.anything(),
    'tenant-1',
    'auth0|alice',
    expect.objectContaining({ draft: expect.objectContaining({ enabled: false }) }),
    expect.objectContaining({ dryRun: true })
  );
});

test('agent_create with confirm persists disabled and reports the id', async () => {
  saveMock.saveAgent.mockResolvedValue({
    outcome: 'saved',
    agentId: 'agent-new',
    apiKeys: [],
    descriptionPending: true,
    normalized: { name: 'X', steps: STEPS_DOC, triggers: [], enabled: false, guardrails: null },
  });
  const handlers = registerAll({});
  const result = await handlers.get('agent_create')!({
    name: 'X',
    steps: STEPS_DOC,
    confirm: true,
  });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('agent-new');
  expect(result.content[0]?.text).toContain('DISABLED');
  expect(saveMock.saveAgent).toHaveBeenCalledWith(
    expect.anything(),
    'tenant-1',
    'auth0|alice',
    expect.anything(),
    expect.objectContaining({ dryRun: false })
  );
});

test('agent_update keeps an already-enabled agent on, unless keepEnabled:false', async () => {
  saveMock.saveAgent.mockResolvedValue({
    outcome: 'saved',
    agentId: 'agent-1',
    apiKeys: [],
    descriptionPending: true,
    normalized: { name: 'X', steps: STEPS_DOC, triggers: [], enabled: true, guardrails: null },
  });
  const handlers = registerAll({});
  await handlers.get('agent_update')!({
    agentId: 'agent-1',
    name: 'X',
    steps: STEPS_DOC,
    confirm: true,
  });
  expect(saveMock.saveAgent).toHaveBeenLastCalledWith(
    expect.anything(),
    'tenant-1',
    'auth0|alice',
    expect.objectContaining({ draft: expect.objectContaining({ enabled: true }) }),
    expect.objectContaining({ agentId: 'agent-1' })
  );

  await handlers.get('agent_update')!({
    agentId: 'agent-1',
    name: 'X',
    steps: STEPS_DOC,
    keepEnabled: false,
    confirm: true,
  });
  expect(saveMock.saveAgent).toHaveBeenLastCalledWith(
    expect.anything(),
    'tenant-1',
    'auth0|alice',
    expect.objectContaining({ draft: expect.objectContaining({ enabled: false }) }),
    expect.anything()
  );
});

test('validation issues come back as per-path lines, nothing saved', async () => {
  saveMock.saveAgent.mockResolvedValue({
    outcome: 'invalid',
    issues: [{ path: 'steps.0.instruction', message: 'needs an instruction' }],
  });
  const handlers = registerAll({});
  const result = await handlers.get('agent_update')!({
    agentId: 'agent-1',
    name: 'X',
    steps: STEPS_DOC,
    confirm: true,
  });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('steps.0.instruction: needs an instruction');
});

test("someone else's agentId reads as not-found on every agent-scoped tool", async () => {
  accessGrantsMock.resolveAgentAccess.mockResolvedValue(null);
  const handlers = registerAll({});
  for (const name of [
    'agent_get',
    'agent_runs_list',
    'agent_memory_list',
    'agent_memory_forget',
    'agent_knowledge_list',
    'agent_knowledge_remove',
  ]) {
    const result = await handlers.get(name)!({
      agentId: 'not-mine',
      noteIds: ['n1'],
      entryIds: ['m1'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No agent of yours');
  }
});

test('agent_knowledge_write reports per-entry results — one failure does not void the rest', async () => {
  notesMock.createAgentNote
    .mockResolvedValueOnce({ noteId: 'n-1' })
    .mockResolvedValueOnce('EMBEDDINGS_OFF');
  const handlers = registerAll({});
  const result = await handlers.get('agent_knowledge_write')!({
    agentId: 'agent-1',
    notes: [
      { title: 'Policy', content: 'Always escalate P1.' },
      { title: 'Format', content: 'Use the CIO template.' },
    ],
  });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('1/2');
  expect(result.content[0]?.text).toContain('noteId: n-1');
  expect(result.content[0]?.text).toContain('embedding provider');
  expect(notesMock.createAgentNote).toHaveBeenCalledTimes(2);
});

test('agent_knowledge_write with every entry failing is an error result', async () => {
  notesMock.createAgentNote.mockResolvedValue('EMBEDDINGS_OFF');
  const handlers = registerAll({});
  const result = await handlers.get('agent_knowledge_write')!({
    agentId: 'agent-1',
    notes: [{ title: 'Policy', content: 'X' }],
  });
  expect(result.isError).toBe(true);
});

test('agent_knowledge_update carries omitted fields over from the stored note', async () => {
  notesMock.listAgentNotes.mockResolvedValue([
    {
      noteId: 'n-1',
      title: 'Old title',
      content: 'Old content',
      authoredBy: 'user',
      sourceAt: null,
    },
  ]);
  notesMock.updateAgentNote.mockResolvedValue('OK');
  const handlers = registerAll({});
  const result = await handlers.get('agent_knowledge_update')!({
    agentId: 'agent-1',
    noteId: 'n-1',
    content: 'New content',
  });
  expect(result.isError).toBeUndefined();
  expect(notesMock.updateAgentNote).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      title: 'Old title',
      content: 'New content',
      ownerEmail: 'alice@example.com',
    })
  );
});

test('agent_run_get resolves the run to its agent and renders the debug markdown', async () => {
  stubDb({ row: { agent_id: 'agent-1' } });
  runsMock.getRunForOwner.mockResolvedValue({ id: 'run-1', attempts: [] });
  const handlers = registerAll({});
  const result = await handlers.get('agent_run_get')!({
    runId: '22222222-2222-4222-8222-222222222222',
  });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toBe('DEBUG MD');
});

test('every agents tool fails closed without a subject', async () => {
  storeMock.listAgents.mockResolvedValue([AGENT]);
  const handlers = registerAll({ subject: undefined });
  for (const [name, handler] of handlers) {
    const result = await handler({
      agentId: 'agent-1',
      runId: 'run-1',
      name: 'X',
      steps: STEPS_DOC,
      text: 'do something useful',
      notes: [{ title: 'T', content: 'C' }],
      noteIds: ['n-1'],
      noteId: 'n-1',
      content: 'C',
    });
    expect(result.isError).toBe(true);
    expect(`${name}: ${result.content[0]?.text ?? ''}`).toContain('no recorded identity');
  }
});

/** A catalog entry, with the two things a step author actually needs. */
const catalogTool = (
  name: string,
  connector: string,
  kind: 'read' | 'act',
  description: string,
  extra: { appOnly?: boolean } = {}
) => ({
  name,
  connector,
  kind,
  title: `${connector} · ${kind === 'act' ? 'Act' : 'Read'} — ${name}`,
  description,
  appOnly: extra.appOnly === true,
  outcomes: {
    success: { label: 'It worked' },
    failures: [
      { code: 'not-found', label: 'Missing', description: 'x', retriable: true },
      { code: 'other', label: 'Anything else', description: 'x', retriable: true },
    ],
  },
});

const CATALOG = [
  catalogTool('outlook_send_mail', 'outlook', 'act', 'Send an email as yourself.'),
  catalogTool('outlook_list_messages', 'outlook', 'read', 'List messages in a folder.'),
  catalogTool('jira_create_issue', 'jira', 'act', 'Create a Jira issue.'),
  catalogTool('jira_create_issue_preview', 'jira', 'act', 'A card only.', { appOnly: true }),
];

describe('agent_list_tools', () => {
  beforeEach(() => {
    catalogMock.listAvailableTools.mockResolvedValue(CATALOG);
  });

  it('names the whole vocabulary by connector when nothing is filtered', async () => {
    const handlers = registerAll({});
    const text = (await handlers.get('agent_list_tools')!({})).content[0]?.text ?? '';

    // Names, not descriptions: what a step has to get exactly right, without
    // the wall of prose for a catalog this size.
    expect(text).toContain('3 skills your agents can use, across 2 connectors:');
    expect(text).toContain('outlook (2):');
    expect(text).toContain('outlook_send_mail, outlook_list_messages');
    expect(text).toContain('jira (1):');
    expect(text).not.toContain('Send an email as yourself.');
  });

  it('leaves out the tools only a preview card can call', async () => {
    const handlers = registerAll({});
    const text = (await handlers.get('agent_list_tools')!({})).content[0]?.text ?? '';

    // The model never sees them, so an author must not be told to write a
    // step for one.
    expect(text).not.toContain('jira_create_issue_preview');
  });

  it('gives the full description and the failure codes once filtered', async () => {
    const handlers = registerAll({});
    const text =
      (await handlers.get('agent_list_tools')!({ connector: 'outlook', kind: 'act' })).content[0]
        ?.text ?? '';

    // The failure codes are the vocabulary failureHandling is keyed by — a
    // step cannot handle a condition it was never told about.
    expect(text).toContain('- outlook_send_mail');
    expect(text).toContain('[act] — Send an email as yourself.');
    expect(text).toContain('failure codes: not-found, other');
    expect(text).not.toContain('outlook_list_messages');
  });

  it('reports each query separately, naming the one that matched nothing', async () => {
    const handlers = registerAll({});
    const text =
      (await handlers.get('agent_list_tools')!({ query: ['send', 'delete a repository'] }))
        .content[0]?.text ?? '';

    expect(text).toContain('"send" — 1 match(es):');
    expect(text).toContain('outlook_send_mail');
    expect(text).toContain('"delete a repository" — no match');
  });

  it('names the connectors you do have when one is asked for that you do not', async () => {
    const handlers = registerAll({});
    const result = await handlers.get('agent_list_tools')!({ connector: 'zoom' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('your connectors are jira, outlook');
  });

  it('says why the catalog is empty rather than answering with nothing', async () => {
    catalogMock.listAvailableTools.mockResolvedValue([]);
    const handlers = registerAll({});
    const text = (await handlers.get('agent_list_tools')!({})).content[0]?.text ?? '';

    expect(text).toContain('no connectors enabled');
  });
});

/**
 * The approval card is a capability with no skill behind it, so a catalog
 * built from registered tools cannot mention it. Every place a caller
 * learns what an agent can do has to say so itself, or a model asked to
 * "check with me first" writes a step that says so and acts anyway.
 */
describe('the approval-card capability is discoverable', () => {
  /** The zod field description, wherever in the shape it sits. */
  type Zodish = { description?: string; _def?: { description?: string } } | undefined;
  const described = (tool: string, walk: (shape: Record<string, Zodish>) => Zodish): string => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const schema = configs.get(tool)?.inputSchema as { shape?: Record<string, Zodish> } | undefined;
    const field = walk(schema?.shape ?? {});
    return String(field?.description ?? field?._def?.description ?? '');
  };

  it('is spelled out on the steps argument of agent_create and agent_update', async () => {
    registerAll({});

    for (const tool of ['agent_create', 'agent_update']) {
      const steps = described(tool, (shape) => shape?.steps);
      expect(steps).toContain('needsApproval');
      expect(steps).toContain('CARD');
      // The recovery path is the part a caller cannot guess.
      expect(steps).toContain('onNotApproved');
      // Caps come from the constants, so they cannot name a limit the
      // validator does not enforce.
      expect(steps).toContain(`${APPROVAL_DEFAULT_TIMEOUT_HOURS}`);
    }
  });

  it('is spelled out on the node agent_patch_steps takes', async () => {
    registerAll({});

    const node = described('agent_patch_steps', (shape) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const operations = shape.operations as
        { element?: { shape?: Record<string, Zodish> } } | undefined;
      return operations?.element?.shape?.node;
    });
    expect(node).toContain('needsApproval');
    expect(node).toContain('onNotApproved');
  });

  it('is named by agent_list_tools, which no skill list could cover', async () => {
    catalogMock.listAvailableTools.mockResolvedValue(CATALOG);
    const handlers = registerAll({});

    const text = (await handlers.get('agent_list_tools')!({})).content[0]?.text ?? '';

    expect(text).toContain('PAUSE BEFORE A TOOL CALL');
    expect(text).toContain('home-page feed');
    expect(text).toContain('ASK A PERSON, ANYTIME');
  });

  it('names them even when the caller has no connectors at all', async () => {
    catalogMock.listAvailableTools.mockResolvedValue([]);
    const handlers = registerAll({});

    const text = (await handlers.get('agent_list_tools')!({})).content[0]?.text ?? '';

    expect(text).toContain('no connectors enabled');
    expect(text).toContain('PAUSE BEFORE A TOOL CALL');
  });
});

const PENDING = {
  cardId: 'card-1',
  runId: 'run-1',
  agentId: 'agent-1',
  agentName: 'Refund triage',
  title: 'Refund triage — needs your approval',
  summary: 'Wants to call Refund payment.',
  proposedTool: 'jira_refund_payment',
  proposedArgs: { amount: 240, customer: 'Dana Lin' },
  raisedAt: '2026-08-28T09:00:00.000Z',
  waitingUntil: '2026-08-31T09:00:00.000Z',
};

describe('agent_approvals_list', () => {
  it('carries what a decision needs: the cardId, the proposed call, and the time left', async () => {
    approvalsMock.listPendingApprovals.mockResolvedValue([PENDING]);
    jest.useFakeTimers().setSystemTime(new Date('2026-08-30T09:00:00.000Z'));
    const handlers = registerAll({});

    const text = (await handlers.get('agent_approvals_list')!({})).content[0]?.text ?? '';
    jest.useRealTimers();

    expect(text).toContain('1 approval(s) waiting on you');
    expect(text).toContain('cardId: card-1');
    expect(text).toContain('Wants to call');
    expect(text).toContain('"amount":240');
    expect(text).toContain('24h left before it times out');
    expect(text).toContain('agent_approval_decide');
  });

  it('says nothing is waiting rather than answering with an empty list', async () => {
    approvalsMock.listPendingApprovals.mockResolvedValue([]);
    const handlers = registerAll({});

    const text = (await handlers.get('agent_approvals_list')!({})).content[0]?.text ?? '';

    expect(text).toContain('Nothing is waiting on you');
  });
});

describe('agent_questions_list', () => {
  it('prints the FORM a question card asks with — a caller cannot see the card', async () => {
    approvalsMock.listPendingQuestions.mockResolvedValue([
      {
        cardId: 'card-2',
        runId: 'run-2',
        agentId: 'agent-2',
        agentName: 'Sunday Deep Sweep',
        title: 'Sunday Deep Sweep — has a question',
        message: 'Which issue tracks this?',
        form: [
          {
            kind: 'field',
            name: 'the issue key',
            label: 'Which issue tracks this?',
            type: 'text',
            required: true,
          },
          {
            kind: 'field',
            name: 'the comments',
            label: 'Which comments to post?',
            type: 'multi',
            required: false,
            options: ['decision 1', 'risk 2'],
          },
          {
            kind: 'field',
            name: 'the points',
            label: 'Story Points',
            type: 'number',
            required: false,
            min: 1,
            max: 13,
            key: 'customfield_10016',
          },
        ],
        raisedAt: '2026-08-28T09:00:00.000Z',
        waitingUntil: '2026-08-31T09:00:00.000Z',
      },
    ]);
    const handlers = registerAll({});

    const text = (await handlers.get('agent_questions_list')!({})).content[0]?.text ?? '';

    // The parameter to answer with, and enough of each field to answer it
    // without a rejected round trip.
    expect(text).toContain('`answers`');
    expect(text).toContain('"the issue key" — Which issue tracks this? (text) · required');
    expect(text).toContain('any of: decision 1 | risk 2');
    expect(text).toContain('number, min 1, max 13');
    // Where the answer is headed, so the step writing it needs no lookup.
    expect(text).toContain('writes to customfield_10016');
  });

  it('says nothing is waiting rather than answering with an empty list', async () => {
    approvalsMock.listPendingQuestions.mockResolvedValue([]);
    const handlers = registerAll({});

    const text = (await handlers.get('agent_questions_list')!({})).content[0]?.text ?? '';

    expect(text).toContain('Nothing is waiting on you');
  });
});

describe('agent_approval_decide', () => {
  beforeEach(() => {
    approvalsMock.decideApproval.mockReset();
  });

  it('REFUSES an agent run — the pause exists so a person decides', async () => {
    // An agent that could answer its own approval makes every approval step
    // decorative. This is the single most important rule in this file.
    const handlers = registerAll({ agent: { agentId: 'agent-1' } });

    const result = await handlers.get('agent_approval_decide')!({
      cardId: 'card-1',
      decision: 'approve',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Agent runs cannot decide approvals');
    expect(approvalsMock.decideApproval).not.toHaveBeenCalled();
  });

  it('reports where the run went, and that it was queued', async () => {
    approvalsMock.decideApproval.mockResolvedValue({
      outcome: 'decided',
      decision: 'approve',
      runId: 'run-1',
      resumed: true,
    });
    const handlers = registerAll({});

    const text =
      (await handlers.get('agent_approval_decide')!({ cardId: 'card-1', decision: 'approve' }))
        .content[0]?.text ?? '';

    expect(text).toContain('Approved — the call fires for real. Run run-1.');
    expect(text).toContain('queued to resume');
  });

  it('never calls a saved decision a failure when only the wake was lost', async () => {
    // The claim is durable and the sweep picks the run up; reporting an
    // error here would have the caller decide twice.
    approvalsMock.decideApproval.mockResolvedValue({
      outcome: 'decided',
      decision: 'decline',
      runId: 'run-1',
      resumed: false,
    });
    const handlers = registerAll({});

    const result = await handlers.get('agent_approval_decide')!({
      cardId: 'card-1',
      decision: 'decline',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('resume automatically within a few minutes');
  });

  it('says who got there first rather than overwriting a standing decision', async () => {
    approvalsMock.decideApproval.mockResolvedValue({
      outcome: 'already-decided',
      status: 'expired',
    });
    const handlers = registerAll({});

    const result = await handlers.get('agent_approval_decide')!({
      cardId: 'card-1',
      decision: 'approve',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('already expired');
  });

  it('points an ordinary card at the tool that handles it', async () => {
    approvalsMock.decideApproval.mockResolvedValue({ outcome: 'not-approval' });
    const handlers = registerAll({});

    const result = await handlers.get('agent_approval_decide')!({
      cardId: 'card-9',
      decision: 'approve',
    });

    expect(result.content[0]?.text).toContain('card_dismiss');
  });
});

describe('a waiting run says what it is waiting on', () => {
  it('annotates the waiting run in agent_runs_list', async () => {
    // "waiting" alone reads as stuck. The answer is a decision the caller
    // reading this line can make.
    stubDb({ row: { id: 'agent-1' } });
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(ownerAccess(AGENT));
    runsMock.listRunsForOwner.mockResolvedValue([
      {
        id: 'run-1',
        status: 'waiting',
        triggerKind: 'schedule',
        createdAt: '2026-08-28T09:00:00.000Z',
        durationMs: null,
        error: null,
        errorKind: null,
        failedStepName: null,
      },
    ]);
    approvalsMock.listPendingApprovals.mockResolvedValue([PENDING]);
    const handlers = registerAll({});

    const text =
      (await handlers.get('agent_runs_list')!({ agentId: 'agent-1' })).content[0]?.text ?? '';

    expect(text).toContain('- waiting · via schedule');
    expect(text).toContain('Waiting on you:');
    expect(text).toContain('cardId: card-1');
  });

  it('spends no query on approvals when nothing is waiting', async () => {
    stubDb({ row: { id: 'agent-1' } });
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(ownerAccess(AGENT));
    runsMock.listRunsForOwner.mockResolvedValue([
      {
        id: 'run-2',
        status: 'succeeded',
        triggerKind: 'manual',
        createdAt: '2026-08-28T09:00:00.000Z',
        durationMs: 1200,
        error: null,
        errorKind: null,
        failedStepName: null,
      },
    ]);
    approvalsMock.listPendingApprovals.mockClear();
    const handlers = registerAll({});

    await handlers.get('agent_runs_list')!({ agentId: 'agent-1' });

    expect(approvalsMock.listPendingApprovals).not.toHaveBeenCalled();
  });
});

describe('agent_memory_forget', () => {
  beforeEach(() => {
    stubDb({ row: { id: 'agent-1' } });
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(ownerAccess(AGENT));
  });

  it('lists entryIds so selective forgetting is reachable at all', async () => {
    memoryMock.readAgentMemory.mockResolvedValue({
      summary: 'Handles P1s.',
      entries: [{ id: 'mem-1', content: 'Acme uses UTC.', createdAt: new Date(0) }],
    });
    const handlers = registerAll({});
    const result = await handlers.get('agent_memory_list')!({ agentId: 'agent-1' });
    expect(result.content[0]?.text).toContain('(entryId: mem-1)');
  });

  it('refuses a call that names nothing to forget', async () => {
    const handlers = registerAll({});
    const result = await handlers.get('agent_memory_forget')!({ agentId: 'agent-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Nothing to forget');
    expect(memoryMock.forgetAgentMemory).not.toHaveBeenCalled();
  });

  it('forgets named entries immediately and names the ids that matched nothing', async () => {
    memoryMock.forgetAgentMemory.mockResolvedValue({
      entriesDeleted: 1,
      summaryCleared: false,
      missingIds: ['mem-9'],
    });
    const handlers = registerAll({});
    const result = await handlers.get('agent_memory_forget')!({
      agentId: 'agent-1',
      entryIds: ['mem-1', 'mem-9'],
    });
    expect(result.isError).toBeUndefined();
    expect(memoryMock.forgetAgentMemory).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'agent-1',
      {
        kind: 'entries',
        entryIds: ['mem-1', 'mem-9'],
      }
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('1/2');
    expect(text).toContain('mem-9: no entry of this agent has that id.');
  });

  it('every named id missing is an error result', async () => {
    memoryMock.forgetAgentMemory.mockResolvedValue({
      entriesDeleted: 0,
      summaryCleared: false,
      missingIds: ['mem-9'],
    });
    const handlers = registerAll({});
    const result = await handlers.get('agent_memory_forget')!({
      agentId: 'agent-1',
      entryIds: ['mem-9'],
    });
    expect(result.isError).toBe(true);
  });

  it('all without confirm is a dry run that deletes nothing', async () => {
    memoryMock.countAgentMemory.mockResolvedValue({ entries: 12, hasSummary: true });
    const handlers = registerAll({});
    const result = await handlers.get('agent_memory_forget')!({ agentId: 'agent-1', all: true });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('12 entries and the rolling summary');
    expect(result.content[0]?.text).toContain('confirm: true');
    expect(memoryMock.forgetAgentMemory).not.toHaveBeenCalled();
  });

  it('all with confirm clears everything', async () => {
    memoryMock.countAgentMemory.mockResolvedValue({ entries: 12, hasSummary: true });
    memoryMock.forgetAgentMemory.mockResolvedValue({
      entriesDeleted: 12,
      summaryCleared: true,
      missingIds: [],
    });
    const handlers = registerAll({});
    const result = await handlers.get('agent_memory_forget')!({
      agentId: 'agent-1',
      all: true,
      confirm: true,
    });
    expect(result.isError).toBeUndefined();
    expect(memoryMock.forgetAgentMemory).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'agent-1',
      { kind: 'all' }
    );
    expect(result.content[0]?.text).toContain('12 entries and the rolling summary forgotten');
  });

  it('refuses all mixed with a narrower selector', async () => {
    const handlers = registerAll({});
    const result = await handlers.get('agent_memory_forget')!({
      agentId: 'agent-1',
      all: true,
      entryIds: ['mem-1'],
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(memoryMock.forgetAgentMemory).not.toHaveBeenCalled();
  });

  it('lets a run forget named entries but never wipe the whole record', async () => {
    memoryMock.forgetAgentMemory.mockResolvedValue({
      entriesDeleted: 1,
      summaryCleared: false,
      missingIds: [],
    });
    const handlers = registerAll({ agent: { agentId: 'agent-1' } });

    const wipe = await handlers.get('agent_memory_forget')!({
      agentId: 'agent-1',
      all: true,
      confirm: true,
    });
    expect(wipe.isError).toBe(true);
    expect(wipe.content[0]?.text).toContain('whole memory');
    expect(memoryMock.forgetAgentMemory).not.toHaveBeenCalled();

    const selective = await handlers.get('agent_memory_forget')!({
      agentId: 'agent-1',
      entryIds: ['mem-1'],
    });
    expect(selective.isError).toBeUndefined();
    expect(memoryMock.forgetAgentMemory).toHaveBeenCalledTimes(1);
  });

  it('clears the rolling summary on its own', async () => {
    memoryMock.forgetAgentMemory.mockResolvedValue({
      entriesDeleted: 0,
      summaryCleared: true,
      missingIds: [],
    });
    const handlers = registerAll({});
    const result = await handlers.get('agent_memory_forget')!({
      agentId: 'agent-1',
      summary: true,
    });
    expect(result.isError).toBeUndefined();
    expect(memoryMock.forgetAgentMemory).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'agent-1',
      { kind: 'summary' }
    );
    expect(result.content[0]?.text).toContain('Rolling summary cleared.');
  });
});

describe('agent_run_now', () => {
  /** An agent the engine would actually accept: steps at the current version. */
  const RUNNABLE = {
    ...AGENT,
    steps: { version: CURRENT_STEPS_VERSION, steps: [] },
    triggers: [
      {
        id: 'trigger-1',
        draft: { kind: 'schedule', recurrences: [], timezone: 'America/Chicago' },
        enabled: true,
        lastFiredAt: null,
        lastError: null,
        nextRunAt: '2026-08-30T13:00:00.000Z',
        keyHint: null,
      },
    ],
  };

  beforeEach(() => {
    runNowMock.createAgentRun.mockResolvedValue({ ok: true, val: { runId: 'run-7' } });
    runNowMock.findInProgressRun.mockResolvedValue(null);
  });

  it('starts an enabled agent whose schedule is on, and leaves the schedule alone', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(ownerAccess(RUNNABLE));
    const handlers = registerAll({});

    const result = await handlers.get('agent_run_now')!({ agentId: 'agent-1' });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('runId: run-7');
    expect(text).toContain('next scheduled run is still 2026-08-30T13:00:00.000Z');
    // Recorded as the manual run it is, with the state a scheduled run gets
    // so trigger.scheduledFor binds the same way.
    expect(runNowMock.createAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        agentId: 'agent-1',
        triggerId: null,
        triggerKind: 'manual',
        triggeredBySubject: 'auth0|alice',
        initialState: expect.objectContaining({ timezone: 'America/Chicago' }),
      })
    );
  });

  it('says the agent is off rather than running it', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(
      ownerAccess({ ...RUNNABLE, enabled: false })
    );
    const handlers = registerAll({});

    const result = await handlers.get('agent_run_now')!({ agentId: 'agent-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('is turned off');
    expect(runNowMock.createAgentRun).not.toHaveBeenCalled();
  });

  it('says the agent is not schedule-triggered, and what does trigger it', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(
      ownerAccess({
        ...RUNNABLE,
        triggers: [
          {
            id: 'trigger-2',
            draft: { kind: 'event', eventId: 'microsoft/mail.received' },
            enabled: true,
            lastFiredAt: null,
            lastError: null,
            nextRunAt: null,
            keyHint: null,
          },
        ],
      })
    );
    const handlers = registerAll({});

    const result = await handlers.get('agent_run_now')!({ agentId: 'agent-1' });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('is not triggered by a schedule');
    expect(text).toContain('It runs: on demand');
    expect(runNowMock.createAgentRun).not.toHaveBeenCalled();
  });

  it('separates a switched-off schedule from having none', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(
      ownerAccess({
        ...RUNNABLE,
        triggers: [{ ...RUNNABLE.triggers[0], enabled: false }],
      })
    );
    const handlers = registerAll({});

    const result = await handlers.get('agent_run_now')!({ agentId: 'agent-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('that trigger is switched off');
    expect(runNowMock.createAgentRun).not.toHaveBeenCalled();
  });

  it('refuses agent-run callers — chaining carries the guards, this does not', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(ownerAccess(RUNNABLE));
    const handlers = registerAll({ agent: { agentId: 'agent-9' } });

    const result = await handlers.get('agent_run_now')!({ agentId: 'agent-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('chain them instead');
    expect(runNowMock.createAgentRun).not.toHaveBeenCalled();
  });

  it("reports the cap's own message when the run is refused", async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(ownerAccess(RUNNABLE));
    runNowMock.createAgentRun.mockResolvedValue({
      ok: false,
      err: {
        type: 'DAILY_RUN_CAP',
        message: 'This organization has reached its 200 runs per day.',
      },
    });
    const handlers = registerAll({});

    const result = await handlers.get('agent_run_now')!({ agentId: 'agent-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('200 runs per day');
  });

  it('refuses when a run is already queued or running, and says so', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(ownerAccess(RUNNABLE));
    runNowMock.findInProgressRun.mockResolvedValue({ id: 'run-3', status: 'running' });
    const handlers = registerAll({});

    const result = await handlers.get('agent_run_now')!({ agentId: 'agent-1' });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('already has a run running');
    expect(text).toContain('run-3');
    expect(text).toContain('confirm: true');
    expect(runNowMock.createAgentRun).not.toHaveBeenCalled();
  });

  it('starts anyway once confirm: true is given, without asking again', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(ownerAccess(RUNNABLE));
    runNowMock.findInProgressRun.mockResolvedValue({ id: 'run-3', status: 'running' });
    const handlers = registerAll({});

    const result = await handlers.get('agent_run_now')!({ agentId: 'agent-1', confirm: true });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('runId: run-7');
    expect(runNowMock.createAgentRun).toHaveBeenCalledTimes(1);
  });
});

describe('sharing — a grantee reaches an agent someone else shared with them', () => {
  /** The AgentAccess shape resolveAgentAccess returns for a grantee. */
  const granteeAccess = (agent: unknown) => ({
    agent,
    ownerSubject: 'auth0|owner',
    viewerIsOwner: false,
    grant: { id: 'grant-1', expiresAt: null },
  });

  it('agent_list lists agents shared with the caller, separately from their own', async () => {
    storeMock.listAgents.mockResolvedValue([AGENT]);
    accessGrantsMock.listAgentsSharedWith.mockResolvedValue([
      {
        agent: { ...AGENT, id: 'agent-2', name: 'Renewals' },
        ownerSubject: 'auth0|owner',
        ownerName: 'Owner Person',
        ownerEmail: 'owner@example.com',
        expiresAt: null,
      },
    ]);
    const handlers = registerAll({});

    const text = (await handlers.get('agent_list')!({})).content[0]?.text ?? '';

    expect(text).toContain('1 agent(s) of yours:');
    expect(text).toContain('Triage');
    expect(text).toContain('1 agent(s) shared with you:');
    expect(text).toContain('Renewals');
    expect(text).toContain('shared by Owner Person');
  });

  it('agent_get reads a shared agent exactly as the owner would', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(granteeAccess(AGENT));
    const handlers = registerAll({});

    const result = await handlers.get('agent_get')!({ agentId: 'agent-1' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? '');
    expect(parsed.agentId).toBe('agent-1');
  });

  it('agent_runs_list and agent_memory_list read the OWNER-scoped data for a shared agent', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(granteeAccess(AGENT));
    runsMock.listRunsForOwner.mockResolvedValue([]);
    const handlers = registerAll({});

    await handlers.get('agent_runs_list')!({ agentId: 'agent-1' });

    expect(runsMock.listRunsForOwner).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'auth0|owner',
      'agent-1',
      expect.anything()
    );
  });

  it('agent_patch saves through the grant, carrying the owner subject', async () => {
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(granteeAccess(AGENT));
    saveMock.saveAgent.mockResolvedValue({
      outcome: 'saved',
      agentId: 'agent-1',
      apiKeys: [],
      normalized: { name: 'Triage', steps: AGENT.steps, triggers: [], enabled: true },
    });
    const handlers = registerAll({});

    await handlers.get('agent_patch')!({
      agentId: 'agent-1',
      name: 'Triage 2',
      confirm: true,
    });

    expect(saveMock.saveAgent).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      // The actor in the audit trail is still the caller, not the owner.
      'auth0|alice',
      expect.anything(),
      expect.objectContaining({ agentId: 'agent-1', ownerSubject: 'auth0|owner' })
    );
  });

  it("agent_run_get hides the approval card — deciding it stays the owner's call", async () => {
    stubDb({ row: { agent_id: 'agent-1' } });
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(granteeAccess(AGENT));
    runsMock.getRunForOwner.mockResolvedValue({ id: 'run-1', status: 'waiting', attempts: [] });
    const handlers = registerAll({});

    const result = await handlers.get('agent_run_get')!({
      runId: '22222222-2222-4222-8222-222222222222',
    });

    expect(result.isError).toBeUndefined();
    expect(approvalsMock.listPendingApprovals).not.toHaveBeenCalled();
    expect(result.content[0]?.text ?? '').not.toContain('Waiting on you');
  });

  it('agent_run_cancel resolves the agent from the run and cancels through the grant', async () => {
    stubDb({ row: { agent_id: 'agent-1' } });
    accessGrantsMock.resolveAgentAccess.mockResolvedValue(granteeAccess(AGENT));
    cancelMock.requestRunCancellation.mockResolvedValue({ outcome: 'canceling' });
    const handlers = registerAll({});

    const result = await handlers.get('agent_run_cancel')!({
      runId: '22222222-2222-4222-8222-222222222222',
    });

    expect(result.isError).toBeUndefined();
    expect(cancelMock.requestRunCancellation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        agentId: 'agent-1',
        ownerSubject: 'auth0|owner',
        canceledBySubject: 'auth0|alice',
      })
    );
  });
});
