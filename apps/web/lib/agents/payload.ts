/**
 * Wire → typed agent payload, shared by the create (POST) and update (PUT)
 * routes so the two can never drift on what a submission looks like.
 * Structural parsing only; the business rules live in @renkei/agents'
 * validator, which runs on the parsed result.
 */

import { isAgentStepsDoc, isTriggerDraft, type AgentDraft } from '@renkei/agents';
import type { SaveAgentInput, TriggerPayload } from '@/lib/agents/store';

export function parseAgentPayload(
  body: unknown
): { input: SaveAgentInput; draft: AgentDraft } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'A JSON body is required' };
  const payload: {
    name?: unknown;
    steps?: unknown;
    triggers?: unknown;
    enabled?: unknown;
    llmModelId?: unknown;
  } = body;

  if (typeof payload.name !== 'string') return { error: 'name is required' };
  if (!isAgentStepsDoc(payload.steps)) return { error: 'steps is not a valid step document' };
  if (!Array.isArray(payload.triggers)) return { error: 'triggers must be a list' };

  const triggers: TriggerPayload[] = [];
  for (const entry of payload.triggers) {
    if (typeof entry !== 'object' || entry === null) return { error: 'Malformed trigger' };
    const item: { id?: unknown; draft?: unknown; enabled?: unknown } = entry;
    if (!isTriggerDraft(item.draft)) return { error: 'Malformed trigger' };
    triggers.push({
      id: typeof item.id === 'string' ? item.id : undefined,
      draft: item.draft,
      enabled: item.enabled !== false,
    });
  }

  const enabled = payload.enabled === true;
  const llmModelId = typeof payload.llmModelId === 'string' ? payload.llmModelId : null;

  return {
    input: { name: payload.name, steps: payload.steps, triggers, enabled, llmModelId },
    draft: {
      name: payload.name,
      steps: payload.steps,
      triggers: triggers.map((trigger) => trigger.draft),
      enabled,
      llmModelId,
    },
  };
}
