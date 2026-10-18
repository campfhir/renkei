/**
 * The export's contract: its system prompt section is byte-identical to
 * what the engine sends the model — proven by rendering through the shared
 * builder and comparing against the fenced block, not by matching
 * hand-copied phrases.
 */

import { runSystemPrompt } from '@renkei/agents/run-prompts';
import { agentMarkdown, type AgentExportInput } from './export-markdown';

const agent: AgentExportInput = {
  name: 'Statement finder',
  description: 'Finds statements.',
  enabled: true,
  instructions: '## Goal\n\nFind the month’s statement and file it.',
  tools: ['jira_search_issues', 'jira_add_comment'],
  triggers: [],
  guardrails: 'Never invent numbers.',
  canAskQuestions: true,
  autoAcceptActions: false,
  limits: { minutes: 30, toolCalls: 150 },
};

describe('agentMarkdown', () => {
  it('embeds the system prompt byte-identical to the engine builder output', () => {
    const runtime = runSystemPrompt(
      agent.limits,
      { canAsk: true },
      {
        agentName: agent.name,
        instructions: agent.instructions,
        guardrailsText: 'Never invent numbers.',
      }
    );
    expect(agentMarkdown(agent)).toContain('````\n' + runtime + '\n````');
  });

  it('states the limits, the tools and how actions are accepted', () => {
    const markdown = agentMarkdown(agent);
    expect(markdown).toContain('150 tool calls, 30 minutes of active time');
    expect(markdown).toContain('- jira_add_comment');
    expect(markdown).toContain('Staged actions: accepted by the owner');
    expect(agentMarkdown({ ...agent, autoAcceptActions: true })).toContain(
      'accepted automatically where the organization allows it'
    );
  });

  it('drops the guardrails block when the agent has none', () => {
    expect(agentMarkdown({ ...agent, guardrails: null })).not.toContain('Standing guardrails');
  });
});
