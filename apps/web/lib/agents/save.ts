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

import { after } from 'next/server';
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
import { notifyAgentEdited } from '@/lib/agents/edit-notification';
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
    /**
     * Save someone else's agent through an access grant (access-grants.ts):
     * the agent looked up and written under THIS owner while `subject`
     * stays the actor in the audit trail. Validation runs against the
     * owner's tool projection too — the agent runs on the owner's grants,
     * so "would this step's tool exist" is a question about the owner, not
     * about whoever is doing the troubleshooting. Callers MUST have
     * resolved an unexpired grant before setting this. Update-only: a
     * grant is on an existing agent, so creation never carries it.
     */
    ownerSubject?: string;
  } = {}
): Promise<SaveAgentResult> {
  // Default to Next's after(): the summary is written AFTER the response
  // in every caller (routes, MCP tools, imports) — a save never blocks on
  // a model, and the deferred work still runs to completion instead of
  // riding an unawaited promise a recycled process can drop.
  const defer = options.defer ?? ((task) => after(task));
  const owner = options.ownerSubject ?? subject;

  const settings = await getOrgSettings(tenantId);
  const normalized = normalizeAgentDraft(parsed.draft, {
    attemptsCap: settings.ok ? settings.val.agentMaxStepAttempts : undefined,
    approvalWaitCapHours: settings.ok ? settings.val.agentApprovalMaxWaitDays * 24 : undefined,
  });
  const tools = await listAvailableTools(tenantId, owner);
  const issues = validateAgentDraft(normalized, tools, {
    maxSteps: settings.ok ? settings.val.agentMaxSteps : undefined,
  });
  if (issues.length > 0) return { outcome: 'invalid', issues };

  if (options.dryRun) {
    if (options.agentId !== undefined) {
      const existing = await getAgent(db, tenantId, owner, options.agentId);
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
  const existing = await getAgent(db, tenantId, owner, agentId);
  if (!existing) return { outcome: 'not-found' };
  // Compared NORMALIZED-to-normalized: the stored doc may predate a
  // normalizer rule (an older steps version, a since-added strip), and a
  // round-tripped save that changed nothing the author can see must not
  // read as a content change — the list's on/off toggle sends the whole
  // definition back, and it was re-describing untouched agents purely
  // because normalization moved.
  const existingNormalized = normalizeAgentDraft(
    {
      name: existing.name,
      steps: existing.steps,
      triggers: existing.triggers.map((trigger) => trigger.draft),
      enabled: existing.enabled,
      llmModelId: existing.llmModelId,
      guardrails: existing.guardrails,
      blockedTools: existing.blockedTools,
    },
    {
      attemptsCap: settings.ok ? settings.val.agentMaxStepAttempts : undefined,
      approvalWaitCapHours: settings.ok ? settings.val.agentApprovalMaxWaitDays * 24 : undefined,
    }
  );
  const describedChanged =
    existingNormalized.name !== normalized.name ||
    JSON.stringify(existingNormalized.steps.steps) !== JSON.stringify(normalized.steps.steps) ||
    // Guardrails shape the summary and the reviewer's concerns, so a
    // guardrails edit re-describes like a steps edit does.
    existingNormalized.guardrails !== normalized.guardrails ||
    JSON.stringify(existingNormalized.blockedTools) !== JSON.stringify(normalized.blockedTools) ||
    JSON.stringify(existingNormalized.triggers) !== JSON.stringify(normalized.triggers);
  // An explicit save (refreshDescription — the builder's Save button)
  // rewrites the summary unconditionally: the review panel is about to
  // show it, so it must reflect THIS save, not a cached earlier one.
  // Everything else — the panel's confirm, the list's on/off toggle —
  // regenerates ONLY on a real content change: a toggle must never spend
  // a model call, and a previously failed summary retries on the next
  // real edit or the builder's re-check button, not on every save.
  const needsDescription = parsed.refreshDescription || describedChanged;

  const result = await updateAgent(db, tenantId, owner, agentId, savedInput, {
    markDescriptionStale: needsDescription,
  });
  if (result === 'NOT_FOUND') return { outcome: 'not-found' };
  if (result === 'NAME_TAKEN') return nameTaken;

  // An edit through a grant carries whose agent it was: the audit trail
  // must answer "who changed it" (the actor) AND "whose was it" (the
  // owner) without a join.
  const grantDetails = owner !== subject ? { details: { ownerSubject: owner } } : {};
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
      ...grantDetails,
    });
  }
  if (describedChanged) {
    recordAuditEvent({
      tenantId,
      actorSubject: subject,
      action: 'agent.updated',
      targetKind: 'agent',
      targetLabel: normalized.name,
      ...grantDetails,
    });
  }
  if (owner !== subject && (describedChanged || existing.enabled !== normalized.enabled)) {
    notifyAgentEdited({
      tenantId,
      ownerSubject: owner,
      actorSubject: subject,
      agentId,
      agentName: normalized.name,
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
