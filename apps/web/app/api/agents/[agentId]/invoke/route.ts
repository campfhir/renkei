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
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore, type AgentRecord } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { agentDefinitionOf } from '@renkei/agents';
import { createAgentRun, findInProgressRun } from '@renkei/agents/runs';
import { sha256Hex } from '@renkei/crypto';
import { getSessionFromRequest } from '@/lib/session';
import { digestsMatch, getBearerToken } from '@/lib/mcp-token';
import { hasActiveGrant } from '@/lib/agents/access-grants';
import { isUuid } from '@/lib/uuid';
import { logger } from '@/lib/logger';

const MAX_STATE_BYTES = 64 * 1024;
/** Small in-memory burst brake; the daily cap in createAgentRun is the law. */
const BURST_WINDOW_MS = 60_000;
const BURST_MAX = 30;
let recentInvokes: number[] = [];

function overBurst(): boolean {
  const now = Date.now();
  const stamps = recentInvokes.filter((at) => now - at < BURST_WINDOW_MS);
  if (stamps.length >= BURST_MAX) {
    recentInvokes = stamps;
    return true;
  }
  stamps.push(now);
  recentInvokes = stamps;
  return false;
}

async function agentById(agentId: string): Promise<AgentRecord | null> {
  // Callers paste this id into external tools; a malformed one (glued-on
  // punctuation from an autolinker) is "no such agent", not a 22P02 → 500.
  if (!isUuid(agentId)) return null;
  return getDataStore().agents.find(agentId);
}

/** The enabled api-kind trigger whose stored digest matches the presented key. */
function apiTriggerForKey(agent: AgentRecord, key: string): string | null {
  const digest = sha256Hex(key);
  for (const trigger of agent.triggers) {
    if (trigger.kind !== 'api' || !trigger.enabled) continue;
    const config: { keyHash?: unknown } =
      typeof trigger.config === 'object' &&
      trigger.config !== null &&
      !Array.isArray(trigger.config)
        ? trigger.config
        : {};
    if (typeof config.keyHash === 'string' && digestsMatch(config.keyHash, digest)) {
      return trigger.id;
    }
  }
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;

  const agent = await agentById(agentId);
  // The two auth paths resolve to (triggerId, triggeredBy) or a response.
  let triggerId: string | null = null;
  let triggeredBy: string | undefined;

  const session = await getSessionFromRequest(request);
  if (session) {
    // A manual run by the owner or a grantee; anyone else sees a 404, not
    // a 403.
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (
      agent.ownerSubject !== session.subject &&
      !(await hasActiveGrant(agentId, session.subject))
    ) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    triggeredBy = session.subject;
  } else {
    const key = getBearerToken(request);
    if (!key || !agent) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    triggerId = apiTriggerForKey(agent, key);
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
  if (overBurst()) {
    return NextResponse.json({ error: 'Too many runs started; slow down.' }, { status: 429 });
  }

  const raw = await request.text();
  if (raw.length > MAX_STATE_BYTES) {
    return NextResponse.json({ error: 'state must stay under 64KB' }, { status: 413 });
  }
  let state: Record<string, unknown> | undefined;
  let confirmed = false;
  if (raw.trim().length > 0) {
    try {
      const body: { state?: unknown; confirm?: unknown } = JSON.parse(raw);
      if (typeof body.state === 'object' && body.state !== null && !Array.isArray(body.state)) {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowed to a plain object above
        state = body.state as Record<string, unknown>;
      }
      confirmed = body.confirm === true;
    } catch {
      return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
    }
  }

  // A machine caller (API key, schedule, event, chain) never sees this —
  // those already run concurrently by design, serialized only by the
  // queue's ordering key. This is purely the "Run now" button's own
  // sanity check: a person clicking it twice, or clicking it without
  // noticing a run from a minute ago is still going, gets asked instead
  // of silently piling up a second run behind the first.
  if (triggerId === null && !confirmed) {
    const inProgress = await findInProgressRun(agentId);
    if (inProgress) {
      return NextResponse.json(
        {
          error: `A run of this agent is already ${inProgress.status}.`,
          code: 'already-in-progress',
          runId: inProgress.id,
          status: inProgress.status,
        },
        { status: 409 }
      );
    }
  }

  const result = await createAgentRun(agentJobsQueue().producer, {
    agentId,
    ownerSubject: agent.ownerSubject,
    definition: agentDefinitionOf(agent),
    llmModelId: agent.llmModelId,
    triggerId,
    triggerKind: triggerId ? 'api' : 'manual',
    triggeredBySubject: triggeredBy,
    initialState: state,
  });
  if (!result.ok) {
    if (result.err.type === 'DB_ERROR') {
      logger.error('The run could not be started: {error}', {
        component: 'api/agents/invoke',
        subject: triggeredBy ?? agent.ownerSubject,
        agentId,
        error: result.err.message ?? result.err.type,
      });
    }
    const status =
      result.err.type === 'DAILY_RUN_CAP' ? 429 : result.err.type === 'DB_ERROR' ? 500 : 409;
    return NextResponse.json(
      { error: result.err.message ?? 'The run could not be started.' },
      { status }
    );
  }

  if (triggerId) {
    await getDataStore().agents.markTriggerFired(triggerId);
  }

  return NextResponse.json({ runId: result.val.runId }, { status: 202 });
}
