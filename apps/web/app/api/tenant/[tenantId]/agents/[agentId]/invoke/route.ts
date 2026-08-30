/**
 * Starting a run by hand or by machine.
 *
 * Two auth paths, both failing closed:
 *   1. Session — the "Run now" button: the owner, or someone holding an
 *      unexpired access grant (access-grants.ts — troubleshooting means
 *      re-running). Either way the run executes on the OWNER's grants and
 *      records who pressed the button in triggered_by_subject.
 *   2. Bearer key — an api-kind trigger's key, matched by SHA-256 digest
 *      with a constant-time compare (the log-ship pattern). The key names
 *      exactly one trigger row on exactly one agent; there is no
 *      cross-agent key.
 *
 * The body's `state` becomes the run's initial state (trigger.* variables)
 * — identifiers and small content, capped well below anything jsonb would
 * regret. The web app stays a producer only (Decision #17): the row and
 * queue message are written here, execution happens in worker-agents.
 *
 * A second manual run while one is already `queued`/`running` is fine —
 * `createAgentRun`'s ordering key already runs one agent's jobs strictly
 * serial — but only the session path gets asked about it first, since only
 * it has someone to ask: a 409 `ALREADY_RUNNING` names the run it would
 * queue behind, and the button re-sends with `confirmQueue: true` once the
 * person says to go ahead. A machine trigger has no such round trip and
 * queues behind a live run without ceremony, same as it always has.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql, type Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { isCurrentStepsDoc } from '@renkei/agents';
import { createAgentRun, liveRunFor } from '@renkei/agents/runs';
import { sha256Hex } from '@renkei/crypto';
import { getSessionFromRequest } from '@/lib/session';
import { digestsMatch, getBearerToken } from '@/lib/mcp-token';
import { hasActiveGrant } from '@/lib/agents/access-grants';
import { isUuid } from '@/lib/uuid';

const MAX_STATE_BYTES = 64 * 1024;
/** Small in-memory burst brake; the daily cap in createAgentRun is the law. */
const BURST_WINDOW_MS = 60_000;
const BURST_MAX = 30;
const recentInvokes = new Map<string, number[]>();

function overBurst(tenantId: string): boolean {
  const now = Date.now();
  const stamps = (recentInvokes.get(tenantId) ?? []).filter((at) => now - at < BURST_WINDOW_MS);
  if (stamps.length >= BURST_MAX) {
    recentInvokes.set(tenantId, stamps);
    return true;
  }
  stamps.push(now);
  recentInvokes.set(tenantId, stamps);
  return false;
}

interface AgentRow {
  id: string;
  owner_subject: string;
  name: string;
  steps: unknown;
  llm_model_id: string | null;
  enabled: boolean;
}

async function agentById(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<AgentRow | null> {
  // Callers paste this id into external tools; a malformed one (glued-on
  // punctuation from an autolinker) is "no such agent", not a 22P02 → 500.
  if (!isUuid(agentId)) return null;
  const row = await db
    .selectFrom('agents')
    .select(['id', 'owner_subject', 'name', 'steps', 'llm_model_id', 'enabled'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', agentId)
    .executeTakeFirst();
  return row ?? null;
}

/** The api-kind trigger row whose stored digest matches the presented key. */
async function apiTriggerForKey(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  key: string
): Promise<string | null> {
  const rows = await db
    .selectFrom('agent_triggers')
    .select(['id', 'config'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('kind', '=', 'api')
    .where('enabled', '=', true)
    .execute();
  const digest = sha256Hex(key);
  for (const row of rows) {
    const config: { keyHash?: unknown } =
      typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
        ? row.config
        : {};
    if (typeof config.keyHash === 'string' && digestsMatch(config.keyHash, digest)) return row.id;
  }
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const agent = await agentById(db, tenantId, agentId);
  // The two auth paths resolve to (triggerId, triggeredBy) or a response.
  let triggerId: string | null = null;
  let triggeredBy: string | undefined;

  const session = await getSessionFromRequest(request, tenantId);
  if (session) {
    // A manual run by the owner or a grantee; anyone else sees a 404, not
    // a 403.
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (
      agent.owner_subject !== session.subject &&
      !(await hasActiveGrant(db, tenantId, agentId, session.subject))
    ) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    triggeredBy = session.subject;
  } else {
    const key = getBearerToken(request);
    if (!key || !agent) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    triggerId = await apiTriggerForKey(db, tenantId, agentId, key);
    if (!triggerId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!agent.enabled && triggerId !== null) {
    // A machine key does not run a switched-off agent; the owner's manual
    // "Run now" may (that is how a draft gets tested before enabling).
    return NextResponse.json({ error: 'This agent is turned off.' }, { status: 409 });
  }
  if (!isCurrentStepsDoc(agent.steps)) {
    return NextResponse.json(
      {
        error:
          'This agent is saved in an older format — open it in the builder and save to update it.',
      },
      { status: 409 }
    );
  }
  if (overBurst(tenantId)) {
    return NextResponse.json({ error: 'Too many runs started; slow down.' }, { status: 429 });
  }

  const raw = await request.text();
  if (raw.length > MAX_STATE_BYTES) {
    return NextResponse.json({ error: 'state must stay under 64KB' }, { status: 413 });
  }
  let state: Record<string, unknown> | undefined;
  let confirmQueue = false;
  if (raw.trim().length > 0) {
    try {
      const body: { state?: unknown; confirmQueue?: unknown } = JSON.parse(raw);
      if (typeof body.state === 'object' && body.state !== null && !Array.isArray(body.state)) {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowed to a plain object above
        state = body.state as Record<string, unknown>;
      }
      confirmQueue = body.confirmQueue === true;
    } catch {
      return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
    }
  }

  // A machine trigger queues behind a live run silently — the ordering key
  // already serializes it, and there is nobody there to ask. The button a
  // person presses gets a chance to notice first, unless this is the
  // confirmed retry of exactly that prompt.
  if (session && !confirmQueue) {
    const liveRun = await liveRunFor(db, tenantId, agentId);
    if (liveRun) {
      return NextResponse.json(
        {
          error: 'A run of this agent is already in progress.',
          code: 'ALREADY_RUNNING',
          liveRun,
        },
        { status: 409 }
      );
    }
  }

  const result = await createAgentRun(db, agentJobsQueue().producer, {
    tenantId,
    agentId,
    ownerSubject: agent.owner_subject,
    steps: agent.steps,
    llmModelId: agent.llm_model_id,
    triggerId,
    triggerKind: triggerId ? 'api' : 'manual',
    triggeredBySubject: triggeredBy,
    initialState: state,
  });
  if (!result.ok) {
    const status =
      result.err.type === 'DAILY_RUN_CAP' ? 429 : result.err.type === 'DB_ERROR' ? 500 : 409;
    return NextResponse.json(
      { error: result.err.message ?? 'The run could not be started.' },
      { status }
    );
  }

  if (triggerId) {
    await db
      .updateTable('agent_triggers')
      .set({ last_fired_at: sql`NOW()`, last_error: null, updated_at: sql`NOW()` })
      .where('id', '=', triggerId)
      .execute();
  }

  return NextResponse.json({ runId: result.val.runId }, { status: 202 });
}
