/**
 * Copy a shared agent: POST { token } forks the shared agent into one the
 * CALLER owns — new ids, the caller's subject, born disabled (every agent
 * is; doubly right here, since the copy runs on the caller's own grants
 * and they should look it over first).
 *
 * What copies: name (deduped with a "(copy)" suffix), steps, the model
 * pin, event/schedule/API triggers, and the agent's KNOWLEDGE notes —
 * re-authored under the recipient, embeddings reused. API triggers mint
 * FRESH keys (returned once, the builder rule). What does not: 'agent'
 * (chained) triggers — they point at the sharer's other agents; MEMORY —
 * that is the original's lived history, never configuration; and the
 * description, which regenerates on first edit.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { validateTriggerDrafts } from '@renkei/agents';
import { getSessionFromRequest } from '@/lib/session';
import { getIdentityEmail } from '@/lib/identity';
import { createAgent, getAgentByShareToken, type TriggerPayload } from '@/lib/agents/store';
import { copyAgentNotes } from '@/lib/agents/agent-notes';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';

const NAME_MAX = 200;
const MAX_NAME_TRIES = 20;

function candidateName(base: string, attempt: number): string {
  const suffix = attempt === 0 ? '' : attempt === 1 ? ' (copy)' : ` (copy ${attempt})`;
  return base.slice(0, NAME_MAX - suffix.length) + suffix;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const token =
    typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string'
      ? body.token
      : '';
  if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const shared = await getAgentByShareToken(db, tenantId, token);
  if (!shared) {
    return NextResponse.json({ error: 'This share link is no longer valid' }, { status: 404 });
  }

  // Chained triggers reference the SHARER's other agents — meaningless
  // (and unauthorized) under a new owner, so they stay behind.
  const triggers: TriggerPayload[] = shared.triggers
    .filter((trigger) => trigger.draft.kind !== 'agent')
    .map((trigger) => ({ draft: trigger.draft, enabled: trigger.enabled }));
  const issues = validateTriggerDrafts(triggers.map((trigger) => trigger.draft));
  if (issues.length > 0) {
    // A stored agent should never fail validation; if it somehow does, a
    // broken copy helps nobody.
    return NextResponse.json(
      { error: 'This agent’s configuration could not be copied as-is' },
      { status: 422 }
    );
  }

  for (let attempt = 0; attempt < MAX_NAME_TRIES; attempt += 1) {
    const created = await createAgent(db, tenantId, session.subject, {
      name: candidateName(shared.name, attempt),
      steps: shared.steps,
      triggers,
      enabled: false,
      llmModelId: shared.llmModelId,
    });
    if (created === 'NAME_TAKEN') continue;

    // Knowledge travels with the configuration; memory never does. Needs
    // the recipient's email (the note ref's owner prefix) — without one
    // the copy still succeeds, just knowledge-less, and says so.
    let notesCopied = 0;
    let notesSkipped = false;
    const emailResult = await getIdentityEmail(tenantId, session.subject);
    const ownerEmail = emailResult.ok ? emailResult.val : null;
    if (ownerEmail) {
      try {
        notesCopied = await copyAgentNotes(db, {
          tenantId,
          sourceAgentId: shared.id,
          targetAgentId: created.agentId,
          targetOwnerEmail: ownerEmail,
        });
      } catch (error) {
        notesSkipped = true;
        logger.warn('agent copy: knowledge notes not copied: {error}', {
          component: 'agents/copy',
          tenantId,
          subject: session.subject,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      notesSkipped = true;
    }

    recordAuditEvent({
      tenantId,
      actorSubject: session.subject,
      action: 'agent.copied',
      targetKind: 'agent',
      targetLabel: shared.name,
    });
    return NextResponse.json(
      { agentId: created.agentId, apiKeys: created.apiKeys, notesCopied, notesSkipped },
      { status: 201 }
    );
  }
  return NextResponse.json(
    { error: 'Too many copies of this agent already exist — rename one first' },
    { status: 409 }
  );
}
