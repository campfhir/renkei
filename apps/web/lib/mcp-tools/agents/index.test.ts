/**
 * The agents tools' contract: everything owner-scoped (someone else's id
 * reads as not-found), the three definition-editing tools refuse agent-run
 * callers and enabled:true, writes are confirm-gated dry runs by default,
 * and batch knowledge operations report per-entry results.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@/lib/agents/store', () => ({ getAgent: jest.fn(), listAgents: jest.fn() }));
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
jest.mock('@renkei/agents/memory', () => ({
  readAgentMemory: jest.fn(async () => ({ summary: null, entries: [] })),
  renderAgentKnowledgeNotes: jest.fn(async () => ''),
  renderAgentMemory: jest.fn(() => ''),
}));
jest.mock('@/lib/agents/draft-store', () => ({
  createDraft: jest.fn(),
  getDraft: jest.fn(),
  consumeDraft: jest.fn(),
}));
jest.mock('@renkei/queue', () => ({ agentJobsQueue: jest.fn() }));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerAgentTools } from './index';
import type { MCPToolContext } from '../common';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const storeMock = jest.requireMock<{ getAgent: jest.Mock; listAgents: jest.Mock }>(
  '@/lib/agents/store'
);
const saveMock = jest.requireMock<{ saveAgent: jest.Mock }>('@/lib/agents/save');
const runsMock = jest.requireMock<{ listRunsForOwner: jest.Mock; getRunForOwner: jest.Mock }>(
  '@/lib/agents/runs-view'
);
const notesMock = jest.requireMock<{
  listAgentNotes: jest.Mock;
  createAgentNote: jest.Mock;
  updateAgentNote: jest.Mock;
  deleteAgentNote: jest.Mock;
}>('@/lib/agents/agent-notes');
const draftStoreMock = jest.requireMock<{
  createDraft: jest.Mock;
  getDraft: jest.Mock;
  consumeDraft: jest.Mock;
}>('@/lib/agents/draft-store');
const queueMock = jest.requireMock<{ agentJobsQueue: jest.Mock }>('@renkei/queue');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

function registerAll(context: Partial<MCPToolContext>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
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

let enqueue: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  stubDb();
  storeMock.getAgent.mockResolvedValue(AGENT);
  draftStoreMock.createDraft.mockResolvedValue('draft-1');
  enqueue = jest.fn(async () => ({ ok: true }));
  queueMock.agentJobsQueue.mockReturnValue({ producer: { enqueue } });
});

test('the three definition-editing tools refuse agent-run callers', async () => {
  const handlers = registerAll({ agent: { agentId: 'agent-9' } });
  for (const name of ['agent_draft', 'agent_create', 'agent_update']) {
    const result = await handlers.get(name)!({
      text: 'do something useful',
      agentId: 'agent-1',
      name: 'X',
      steps: STEPS_DOC,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Agent runs cannot edit agent definitions');
  }
  expect(saveMock.saveAgent).not.toHaveBeenCalled();
  expect(draftStoreMock.createDraft).not.toHaveBeenCalled();
});

test('agent_draft persists a draft row, enqueues the worker job, and returns the draftId', async () => {
  const handlers = registerAll({});
  const result = await handlers.get('agent_draft')!({
    text: 'watch a space and file tickets',
    agentId: 'agent-1',
  });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('draft-1');
  expect(result.content[0]?.text).toContain('agent_draft_get');
  expect(draftStoreMock.createDraft).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      tenantId: 'tenant-1',
      ownerSubject: 'auth0|alice',
      agentId: 'agent-1',
      request: expect.objectContaining({
        text: 'watch a space and file tickets',
        guardrails: 'Never invent numbers.',
      }),
    })
  );
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'draft',
      payload: { draftId: 'draft-1' },
      orderingKey: 'draft:tenant-1:auth0|alice',
    })
  );
});

test('agent_draft reports failure when the job cannot be enqueued', async () => {
  enqueue.mockResolvedValue({ ok: false, err: { message: 'queue down' } });
  const handlers = registerAll({});
  const result = await handlers.get('agent_draft')!({ text: 'watch a space and file tickets' });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('Could not start drafting');
});

test('agent_draft_get reports progress, then renders the finished draft and consumes it', async () => {
  draftStoreMock.getDraft.mockResolvedValue({
    id: 'draft-1',
    agentId: null,
    status: 'running',
    request: {},
    result: null,
    error: null,
    errorDetail: null,
    createdAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
  });
  const handlers = registerAll({});
  let result = await handlers.get('agent_draft_get')!({ draftId: 'draft-1' });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('Still drafting');
  expect(draftStoreMock.consumeDraft).not.toHaveBeenCalled();

  draftStoreMock.getDraft.mockResolvedValue({
    id: 'draft-1',
    agentId: 'agent-1',
    status: 'succeeded',
    request: {},
    result: {
      name: 'Triage watcher',
      steps: STEPS_DOC.steps,
      questions: ['Which project?'],
    },
    error: null,
    errorDetail: null,
    createdAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:01:00Z',
  });
  result = await handlers.get('agent_draft_get')!({ draftId: 'draft-1' });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('Triage watcher');
  expect(result.content[0]?.text).toContain('agent_update');
  expect(result.content[0]?.text).toContain('Which project?');
  expect(draftStoreMock.consumeDraft).toHaveBeenCalledWith(
    expect.anything(),
    'tenant-1',
    'auth0|alice',
    'draft-1'
  );
});

test('agent_draft_get surfaces a failed draft as an error', async () => {
  draftStoreMock.getDraft.mockResolvedValue({
    id: 'draft-1',
    agentId: null,
    status: 'failed',
    request: {},
    result: null,
    error: 'The model replied with nothing usable.',
    errorDetail: null,
    createdAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:01:00Z',
  });
  const handlers = registerAll({});
  const result = await handlers.get('agent_draft_get')!({ draftId: 'draft-1' });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('nothing usable');
  expect(draftStoreMock.consumeDraft).not.toHaveBeenCalled();
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
  storeMock.getAgent.mockResolvedValue(null);
  const handlers = registerAll({});
  for (const name of [
    'agent_get',
    'agent_runs_list',
    'agent_memory_list',
    'agent_knowledge_list',
    'agent_knowledge_remove',
  ]) {
    const result = await handlers.get(name)!({ agentId: 'not-mine', noteIds: ['n1'] });
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
    { noteId: 'n-1', title: 'Old title', content: 'Old content', authoredBy: 'user', sourceAt: null },
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
    expect.objectContaining({ title: 'Old title', content: 'New content', ownerEmail: 'alice@example.com' })
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
