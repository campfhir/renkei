/**
 * The agent definition as data — the single builder behind every surface
 * that emits the machine-readable form: the markdown export's fenced
 * block, and agent_get's. One builder, so the round trip (Import, and
 * agent_update fed from agent_get) can never chase two dialects.
 */

import type { AgentStepsDoc, TriggerDraft } from '@renkei/agents';

/** The fence info string marking a definition block in markdown. */
export const AGENT_DEFINITION_FENCE = 'json renkei-agent';

export interface AgentDefinitionInput {
  name: string;
  description?: string | null;
  steps: AgentStepsDoc;
  triggers: { draft: TriggerDraft; enabled: boolean }[];
  guardrails?: string | null;
  blockedTools?: string[];
  llmModelId?: string | null;
}

/** Exactly the keys the save path (parseAgentPayload / agent_update) reads. */
export function agentDefinition(agent: AgentDefinitionInput): Record<string, unknown> {
  return {
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    steps: agent.steps,
    triggers: agent.triggers,
    ...(agent.guardrails ? { guardrails: agent.guardrails } : {}),
    ...(agent.blockedTools && agent.blockedTools.length > 0
      ? { blockedTools: agent.blockedTools }
      : {}),
    ...(agent.llmModelId ? { llmModelId: agent.llmModelId } : {}),
  };
}

/** The definition as a fenced markdown block, ready to embed. */
export function fencedDefinition(agent: AgentDefinitionInput): string {
  return ['```' + AGENT_DEFINITION_FENCE, JSON.stringify(agentDefinition(agent), null, 2), '```'].join('\n');
}
