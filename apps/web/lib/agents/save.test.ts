/**
 * The description-regeneration rules of the one save path: a save that
 * changes nothing the author can see (the list's on/off toggle, a stored
 * doc merely re-normalized to the current version) must not spend a model
 * call; an explicit refresh or a real content change must.
 */

jest.mock('next/server', () => ({ after: (task: () => unknown) => void task() }));
jest.mock('@renkei/settings', () => ({ getOrgSettings: jest.fn(async () => ({ ok: false })) }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ listAvailableTools: jest.fn(async () => []) }));
jest.mock('@/lib/agents/store', () => ({
  getAgent: jest.fn(),
  createAgent: jest.fn(),
  updateAgent: jest.fn(async () => ({ apiKeys: [] })),
}));
jest.mock('@/lib/agents/describe', () => ({ generateAgentDescription: jest.fn(async () => {}) }));
jest.mock('@/lib/agents/edit-notification', () => ({ notifyAgentEdited: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { AgentDraft } from '@renkei/agents';
import { saveAgent } from './save';

const storeMock = jest.requireMock<{ getAgent: jest.Mock; updateAgent: jest.Mock }>(
  '@/lib/agents/store'
);
const describeMock = jest.requireMock<{ generateAgentDescription: jest.Mock }>(
  '@/lib/agents/describe'
);

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const db = {} as Kysely<DB>;

const stepId = randomUUID();
/** Stored in an OLDER format on purpose: version 1, pre-collapse. */
const storedSteps = {
  version: 1,
  steps: [
    {
      id: stepId,
      name: 'Think',
      instruction: [{ t: 'text', v: 'Think it through.' }],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    },
  ],
};

const existing = {
  id: 'agent-1',
  name: 'Thinker',
  description: 'Thinks.',
  descriptionStatus: 'failed',
  reviewNotes: null,
  steps: storedSteps,
  llmModelId: null,
  enabled: true,
  guardrails: null,
  blockedTools: [],
  triggers: [],
};

function parsedWith(overrides: Partial<AgentDraft> = {}, refreshDescription = false) {
  const draft: AgentDraft = {
    name: 'Thinker',
    // The toggle round-trips the STORED doc; JSON round-trip mimics the wire.
    steps: JSON.parse(JSON.stringify(storedSteps)),
    triggers: [],
    enabled: false,
    llmModelId: null,
    guardrails: null,
    blockedTools: [],
    ...overrides,
  };
  return {
    input: { ...draft, triggers: [] },
    draft,
    refreshDescription,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  storeMock.getAgent.mockResolvedValue(existing);
});

describe('saveAgent description regeneration', () => {
  it('a toggle-shaped save never re-describes — version renormalization included', async () => {
    const result = await saveAgent(db, 't1', 'auth0|alice', parsedWith(), {
      agentId: 'agent-1',
    });
    expect(result.outcome).toBe('saved');
    // Even with descriptionStatus 'failed' on the row: retries belong to a
    // real edit or the builder's re-check, never to the on/off toggle.
    expect(describeMock.generateAgentDescription).not.toHaveBeenCalled();
    expect(storeMock.updateAgent).toHaveBeenCalledWith(
      expect.anything(),
      't1',
      'auth0|alice',
      'agent-1',
      expect.anything(),
      expect.objectContaining({ markDescriptionStale: false })
    );
  });

  it('an explicit refresh re-describes', async () => {
    await saveAgent(db, 't1', 'auth0|alice', parsedWith({}, true), { agentId: 'agent-1' });
    expect(describeMock.generateAgentDescription).toHaveBeenCalledTimes(1);
  });

  it('a real content change re-describes', async () => {
    const changed = JSON.parse(JSON.stringify(storedSteps));
    changed.steps[0].instruction = [{ t: 'text', v: 'Think harder.' }];
    await saveAgent(db, 't1', 'auth0|alice', parsedWith({ steps: changed }), {
      agentId: 'agent-1',
    });
    expect(describeMock.generateAgentDescription).toHaveBeenCalledTimes(1);
  });
});
