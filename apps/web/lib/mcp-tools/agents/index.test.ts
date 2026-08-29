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
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ listAvailableTools: jest.fn() }));
jest.mock('@renkei/agents/memory', () => ({
  readAgentMemory: jest.fn(async () => ({ summary: null, entries: [] })),
  renderAgentKnowledgeNotes: jest.fn(async () => ''),
  renderAgentMemory: jest.fn(() => ''),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerAgentTools } from './index';
import type { MCPToolContext } from '../common';
import { APPROVAL_DEFAULT_TIMEOUT_HOURS } from '@renkei/agents';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const storeMock = jest.requireMock<{ getAgent: jest.Mock; listAgents: jest.Mock }>(
  '@/lib/agents/store'
);
const saveMock = jest.requireMock<{ saveAgent: jest.Mock }>('@/lib/agents/save');
const runsMock = jest.requireMock<{ listRunsForOwner: jest.Mock; getRunForOwner: jest.Mock }>(
  '@/lib/agents/runs-view'
);
const catalogMock = jest.requireMock<{ listAvailableTools: jest.Mock }>(
  '@/lib/mcp-tools/tool-catalog'
);
const notesMock = jest.requireMock<{
  listAgentNotes: jest.Mock;
  createAgentNote: jest.Mock;
  updateAgentNote: jest.Mock;
  deleteAgentNote: jest.Mock;
}>('@/lib/agents/agent-notes');

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

beforeEach(() => {
  jest.clearAllMocks();
  stubDb();
  storeMock.getAgent.mockResolvedValue(AGENT);
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
      expect(steps).toContain('{kind:"approval"}');
      expect(steps).toContain('card');
      // The three outcome paths are the part a caller cannot guess.
      expect(steps).toContain('onApproved');
      expect(steps).toContain('onDeclined');
      expect(steps).toContain('onTimeout');
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
    expect(node).toContain('{kind:"approval"}');
  });

  it('is named by agent_list_tools, which no skill list could cover', async () => {
    catalogMock.listAvailableTools.mockResolvedValue(CATALOG);
    const handlers = registerAll({});

    const text = (await handlers.get('agent_list_tools')!({})).content[0]?.text ?? '';

    expect(text).toContain('PAUSE FOR A PERSON');
    expect(text).toContain('home-page feed');
    expect(text).toContain('there is no skill for it');
  });

  it('names them even when the caller has no connectors at all', async () => {
    catalogMock.listAvailableTools.mockResolvedValue([]);
    const handlers = registerAll({});

    const text = (await handlers.get('agent_list_tools')!({})).content[0]?.text ?? '';

    expect(text).toContain('no connectors enabled');
    expect(text).toContain('PAUSE FOR A PERSON');
  });
});
