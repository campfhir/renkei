/**
 * The ONE save path for an agent definition — normalize against the org's
 * caps, validate against THIS caller's tool projection, persist, audit,
 * and (re)generate the plain-language summary. The create (POST) and
 * update (PUT) routes AND the agents-over-MCP tools all run through here,
 * so what a save means cannot drift between the builder and chat.
 *
 * The summary generation is deferred through `defer` because it calls a
 * model: routes pass Next's `after` (respond first, describe after);
 * other callers may omit it for fire-and-forget.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  normalizeAgentDraft,
  validateAgentDraft,
  type AgentDraft,
  type ValidationIssue,
} from '@renkei/agents';
import { getOrgSettings } from '@renkei/settings';
import { listAvailableTools } from '@/lib/mcp-tools/tool-catalog';
import { createAgent, getAgent, updateAgent, type SaveAgentInput } from '@/lib/agents/store';
import { generateAgentDescription } from '@/lib/agents/describe';
import { recordAuditEvent } from '@/lib/audit-events';

export type SaveAgentResult =
  | { outcome: 'not-found' }
  | { outcome: 'invalid'; issues: ValidationIssue[] }
  | { outcome: 'valid-dry-run'; normalized: AgentDraft }
  | {
      outcome: 'saved';
      agentId: string;
      /** Freshly minted API-trigger keys — shown exactly once. */
      apiKeys: { triggerId: string; key: string }[];
      descriptionPending: boolean;
      normalized: AgentDraft;
    };

export async function saveAgent(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  parsed: { input: SaveAgentInput; draft: AgentDraft; refreshDescription: boolean },
  options: {
    /** Update this agent when set; create a new one otherwise. */
    agentId?: string;
    /** How to schedule the model-backed summary write (default: inline, unawaited). */
    defer?: (task: () => Promise<unknown>) => void;
    /**
     * Normalize and validate only — persist NOTHING. The MCP tools run
     * this pass first so a confirm-gated save can show what would change.
     */
    dryRun?: boolean;
  } = {}
): Promise<SaveAgentResult> {
  const defer = options.defer ?? ((task) => void task());

  const settings = await getOrgSettings(tenantId);
  const normalized = normalizeAgentDraft(parsed.draft, {
    attemptsCap: settings.ok ? settings.val.agentMaxStepAttempts : undefined,
    approvalWaitCapHours: settings.ok ? settings.val.agentApprovalMaxWaitDays * 24 : undefined,
  });
  const tools = await listAvailableTools(tenantId, subject);
  const issues = validateAgentDraft(normalized, tools);
  if (issues.length > 0) return { outcome: 'invalid', issues };

  if (options.dryRun) {
    if (options.agentId !== undefined) {
      const existing = await getAgent(db, tenantId, subject, options.agentId);
      if (!existing) return { outcome: 'not-found' };
    }
    return { outcome: 'valid-dry-run', normalized };
  }

  const savedInput: SaveAgentInput = {
    ...parsed.input,
    name: normalized.name,
    steps: normalized.steps,
    guardrails: normalized.guardrails,
    blockedTools: normalized.blockedTools,
  };
  const nameTaken: SaveAgentResult = {
    outcome: 'invalid',
    issues: [{ path: 'name', message: 'You already have an agent with this name.' }],
  };

  if (options.agentId === undefined) {
    const result = await createAgent(db, tenantId, subject, savedInput);
    if (result === 'NAME_TAKEN') return nameTaken;
    recordAuditEvent({
      tenantId,
      actorSubject: subject,
      action: 'agent.created',
      targetKind: 'agent',
      targetLabel: normalized.name,
    });
    defer(() =>
      generateAgentDescription(db, tenantId, {
        id: result.agentId,
        name: normalized.name,
        steps: normalized.steps,
        triggers: normalized.triggers,
        llmModelId: parsed.input.llmModelId,
        guardrails: normalized.guardrails,
      })
    );
    return {
      outcome: 'saved',
      agentId: result.agentId,
      apiKeys: result.apiKeys,
      descriptionPending: true,
      normalized,
    };
  }

  const agentId = options.agentId;
  const existing = await getAgent(db, tenantId, subject, agentId);
  if (!existing) return { outcome: 'not-found' };
  const describedChanged =
    existing.name !== normalized.name ||
    JSON.stringify(existing.steps) !== JSON.stringify(normalized.steps) ||
    // Guardrails shape the summary and the reviewer's concerns, so a
    // guardrails edit re-describes like a steps edit does.
    existing.guardrails !== normalized.guardrails ||
    JSON.stringify(existing.blockedTools) !== JSON.stringify(normalized.blockedTools) ||
    JSON.stringify(existing.triggers.map((trigger) => trigger.draft)) !==
      JSON.stringify(normalized.triggers);
  // An explicit save (refreshDescription — the builder's Save button)
  // rewrites the summary unconditionally: the review panel is about to
  // show it, so it must reflect THIS save, not a cached earlier one. The
  // panel's confirm and the list's on/off toggle omit the flag, so they
  // only regenerate when the content actually changed (or a summary is
  // still missing) — confirming must never re-stale what was just read.
  const needsDescription =
    parsed.refreshDescription || describedChanged || existing.descriptionStatus !== 'ok';

  const result = await updateAgent(db, tenantId, subject, agentId, savedInput, {
    markDescriptionStale: needsDescription,
  });
  if (result === 'NOT_FOUND') return { outcome: 'not-found' };
  if (result === 'NAME_TAKEN') return nameTaken;

  // A toggle and an edit are different stories in the audit trail: "turned
  // it on" is a decision to let it act, "changed it" is a change to what it
  // does. A save that flips enabled AND rewrites steps records both.
  if (existing.enabled !== normalized.enabled) {
    recordAuditEvent({
      tenantId,
      actorSubject: subject,
      action: normalized.enabled ? 'agent.enabled' : 'agent.disabled',
      targetKind: 'agent',
      targetLabel: normalized.name,
    });
  }
  if (describedChanged) {
    recordAuditEvent({
      tenantId,
      actorSubject: subject,
      action: 'agent.updated',
      targetKind: 'agent',
      targetLabel: normalized.name,
    });
  }

  if (needsDescription) {
    defer(() =>
      generateAgentDescription(db, tenantId, {
        id: agentId,
        name: normalized.name,
        steps: normalized.steps,
        triggers: normalized.triggers,
        llmModelId: parsed.input.llmModelId,
        guardrails: normalized.guardrails,
      })
    );
  }

  return {
    outcome: 'saved',
    agentId,
    apiKeys: result.apiKeys,
    descriptionPending: needsDescription,
    normalized,
  };
}
