/**
 * Wire → typed agent payload, shared by the create (POST) and update (PUT)
 * routes so the two can never drift on what a submission looks like.
 * Structural parsing only; the business rules live in @renkei/agents'
 * validator, which runs on the parsed result.
 */

import {
  isAgentStepsDoc,
  isTriggerDraft,
  triggerDraftIssue,
  type AgentDraft,
} from '@renkei/agents';
import type { SaveAgentInput, TriggerPayload } from '@/lib/agents/store';

export function parseAgentPayload(
  body: unknown
): { input: SaveAgentInput; draft: AgentDraft; refreshDescription: boolean } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'A JSON body is required' };
  const payload: {
    name?: unknown;
    steps?: unknown;
    triggers?: unknown;
    enabled?: unknown;
    llmModelId?: unknown;
    guardrails?: unknown;
    blockedTools?: unknown;
    refreshDescription?: unknown;
  } = body;

  if (typeof payload.name !== 'string') return { error: 'name is required' };
  if (!isAgentStepsDoc(payload.steps)) return { error: 'steps is not a valid step document' };
  if (!Array.isArray(payload.triggers)) return { error: 'triggers must be a list' };

  const triggers: TriggerPayload[] = [];
  // A rejection here names the offending key and its accepted values: this
  // is the boundary, so the draft never reaches the validator's per-path
  // messages, and "malformed" alone leaves a caller writing a draft by hand
  // (over MCP, say) guessing at a grammar it cannot read anywhere.
  for (const [index, entry] of payload.triggers.entries()) {
    const at = `Trigger ${index + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      return { error: `${at} must be a {draft, enabled} entry` };
    }
    const item: { id?: unknown; draft?: unknown; enabled?: unknown } = entry;
    if (item.draft === undefined) {
      // The likeliest wire mistake is a bare draft where the entry goes:
      // say which of the two shapes is missing rather than describing the
      // draft grammar for an entry that has no draft to describe.
      return { error: `${at} needs a "draft" — an entry is {draft, enabled}` };
    }
    // The guard narrows; the issue function says why it refused. Both run
    // the same switch, so the reason can never disagree with the verdict.
    if (!isTriggerDraft(item.draft)) {
      return { error: [at, triggerDraftIssue(item.draft)].filter(Boolean).join(': ') };
    }
    triggers.push({
      id: typeof item.id === 'string' ? item.id : undefined,
      draft: item.draft,
      enabled: item.enabled !== false,
    });
  }

  const enabled = payload.enabled === true;
  const llmModelId = typeof payload.llmModelId === 'string' ? payload.llmModelId : null;
  const guardrails =
    typeof payload.guardrails === 'string' && payload.guardrails.trim() ? payload.guardrails : null;
  const blockedTools = Array.isArray(payload.blockedTools)
    ? payload.blockedTools.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0
      )
    : [];

  return {
    input: {
      name: payload.name,
      steps: payload.steps,
      triggers,
      enabled,
      llmModelId,
      guardrails,
      blockedTools,
    },
    draft: {
      name: payload.name,
      steps: payload.steps,
      triggers: triggers.map((trigger) => trigger.draft),
      enabled,
      llmModelId,
      guardrails,
      blockedTools,
    },
    // The builder's Save sets this: an explicit save rewrites the summary
    // unconditionally, because the person is about to be shown it for
    // review. The review panel's confirm omits it, so confirming never
    // re-stales the summary that was just read.
    refreshDescription: payload.refreshDescription === true,
  };
}
