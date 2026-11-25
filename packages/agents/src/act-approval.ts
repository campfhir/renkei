/**
 * Whether a staged action batch needs a PERSON to accept it.
 *
 * An agent never calls a tool that changes something: it stages the calls
 * (action-batch.ts) and a separate executor runs them once the batch is
 * accepted. Acceptance is a person clicking Accept on the batch's card —
 * or, when every action in the batch is one the owner lets this agent run
 * without asking (its allowed actions, per tool), the engine accepting on
 * their behalf. That is honored only where the org lets it be
 * (`agentActStepsRequireApproval`, @renkei/settings), because an agent
 * run acts on content it did not write — a mail that arrived, a chat
 * message, an API caller's payload:
 *
 *   - 'externally_triggered' (default): a run an event or a webhook started
 *     always waits for a person; a run a person started by hand, or a
 *     schedule, honors auto-accept.
 *   - 'all': every batch waits for a person.
 *   - 'off': auto-accept is always honored.
 *
 * Beneath the setting sit the organization's locked high-risk tools
 * (@renkei/settings' lockedHighRiskTools, which operators edit): a batch
 * holding one waits for a person whatever the agent is allowed. The caller
 * hands both as tests over tool names, read once per batch.
 *
 * Shared between the engine (which decides when a batch is staged) and the
 * web app (which tells owners what auto-accept will and will not cover),
 * so both answer from the same words.
 */

import type { ActApprovalPolicy } from '@renkei/settings';

/**
 * Whether a run's start counts as external for the policy: an event
 * trigger ('event' — a connector's fan-out) or an API-key invocation
 * ('api' — a webhook from another system). 'manual' (a person pressed
 * Run), 'chat' (a person handed the agent a task from a chat) and
 * 'schedule' are the org's own clock and hand — the engine still treats a
 * manual or chat run started by someone other than the owner as external. 'agent' — a run
 * another run chained — is resolved by the engine to the ROOT of its
 * chain before it gets here; one that could not be resolved reads as
 * external, the fail-closed direction.
 */
export function isExternallyTriggered(triggerKind: string): boolean {
  return triggerKind !== 'manual' && triggerKind !== 'chat' && triggerKind !== 'schedule';
}

export type ToolKindHint = 'read' | 'act' | null;

/** Why a batch waits for a person: an action the agent is not allowed, a locked tool, or the org's policy. */
export type ActApprovalReason = 'owner' | 'high-risk' | 'policy';

export interface ActApprovalInput {
  /** Every tool the batch would call. */
  tools: readonly string[];
  /** Locked by the organization as high risk: always waits. */
  isLocked: (tool: string) => boolean;
  /** One of the agent's allowed actions: runs without asking. */
  isAllowed: (tool: string) => boolean;
  policy: ActApprovalPolicy;
  externallyTriggered: boolean;
}

/** Null when the batch may be accepted without a person; otherwise why it waits. */
export function actApprovalReason(input: ActApprovalInput): ActApprovalReason | null {
  if (input.tools.some(input.isLocked)) return 'high-risk';
  if (!input.tools.every(input.isAllowed)) return 'owner';
  if (input.policy === 'all') return 'policy';
  if (input.policy === 'externally_triggered' && input.externallyTriggered) return 'policy';
  return null;
}
