/**
 * The description-regeneration rules of the one save path: a save that
 * changes nothing the author can see (the list's on/off toggle, stored
 * instructions merely re-normalized) must not spend a model call; an
 * explicit refresh or a real content change must. And the save validates
 * the tool selection against the owner's own projection.
 */

jest.mock('next/server', () => ({ after: (task: () => unknown) => void task() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({
  listAvailableTools: jest.fn(async () => [{ name: 'jira_search_issues', appOnly: false }]),
}));
jest.mock('@/lib/agents/store', () => ({
  getAgent: jest.fn(),
  createAgent: jest.fn(),
  updateAgent: jest.fn(async () => ({ apiKeys: [] })),
}));
jest.mock('@/lib/agents/describe', () => ({ generateAgentDescription: jest.fn(async () => {}) }));
jest.mock('@/lib/agents/edit-notification', () => ({ notifyAgentEdited: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import type { AgentDraft } from '@renkei/agents';
import { saveAgent } from './save';

const storeMock = jest.requireMock<{ getAgent: jest.Mock; updateAgent: jest.Mock }>(
  '@/lib/agents/store'
);
const describeMock = jest.requireMock<{ generateAgentDescription: jest.Mock }>(
  '@/lib/agents/describe'
);

const existing = {
  id: 'agent-1',
  name: 'Thinker',
  description: 'Thinks.',
  descriptionStatus: 'failed',
  reviewNotes: null,
  // Stored with trailing whitespace on purpose: normalization trims it,
  // and that alone must not read as an edit.
  instructions: '## Goal\n\nThink it through.\n\n',
  tools: ['jira_search_issues'],
  llmModelId: null,
  enabled: true,
  guardrails: null,
  canAskQuestions: false,
  autoAcceptActions: false,
  triggers: [],
};

function parsedWith(overrides: Partial<AgentDraft> = {}, refreshDescription = false) {
  const draft: AgentDraft = {
    name: 'Thinker',
    instructions: existing.instructions,
    tools: [...existing.tools],
    triggers: [],
    enabled: false,
    llmModelId: null,
    guardrails: null,
    canAskQuestions: false,
    autoAcceptActions: false,
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
  it('a toggle-shaped save never re-describes — renormalization included', async () => {
    const result = await saveAgent('auth0|alice', parsedWith(), {
      agentId: 'agent-1',
    });
    expect(result.outcome).toBe('saved');
    // Even with descriptionStatus 'failed' on the row: retries belong to a
    // real edit or the builder's re-check, never to the on/off toggle.
    expect(describeMock.generateAgentDescription).not.toHaveBeenCalled();
    expect(storeMock.updateAgent).toHaveBeenCalledWith(
      'auth0|alice',
      'agent-1',
      expect.anything(),
      expect.objectContaining({ markDescriptionStale: false })
    );
  });

  it('an explicit refresh re-describes', async () => {
    await saveAgent('auth0|alice', parsedWith({}, true), { agentId: 'agent-1' });
    expect(describeMock.generateAgentDescription).toHaveBeenCalledTimes(1);
  });

  it('a real content change re-describes', async () => {
    await saveAgent('auth0|alice', parsedWith({ instructions: '## Goal\n\nThink harder.' }), {
      agentId: 'agent-1',
    });
    expect(describeMock.generateAgentDescription).toHaveBeenCalledTimes(1);
  });

  it('turning auto-accept on is a change worth re-describing', async () => {
    await saveAgent('auth0|alice', parsedWith({ autoAcceptActions: true }), {
      agentId: 'agent-1',
    });
    expect(describeMock.generateAgentDescription).toHaveBeenCalledTimes(1);
  });
});

describe('validation against the owner’s tools', () => {
  it('refuses a tool the owner does not have', async () => {
    const result = await saveAgent('auth0|alice', parsedWith({ tools: ['gone_tool'] }), {
      agentId: 'agent-1',
    });
    expect(result).toEqual({
      outcome: 'invalid',
      issues: [expect.objectContaining({ path: 'tools.0' })],
    });
  });
});
