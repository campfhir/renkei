/**
 * Do the analysis. Called by the agents worker, never by a browser — the
 * draft run route's twin, with the same authentication: the worker's
 * agent-application bearer token names a SUBJECT, the row is read under
 * that subject, and so the pass can only ever read the run content its
 * owner may read.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getBearerToken, resolveAccessToken } from '@/lib/mcp-token';
import { recordLlmCall } from '@renkei/agents/runs';
import { getAgent } from '@/lib/agents/store';
import {
  claimOptimization,
  finishOptimization,
  getOptimization,
} from '@/lib/agents/optimization-store';
import { optimizeAgent } from '@/lib/agents/optimize';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; optimizationId: string }> }
): Promise<NextResponse> {
  const { tenantId, optimizationId } = await params;

  const token = getBearerToken(request);
  if (!token) return NextResponse.json({ error: 'Not authorized' }, { status: 401 });
  const record = await resolveAccessToken(token, tenantId, 'agent');
  if (!record) return NextResponse.json({ error: 'Not authorized' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const optimization = await getOptimization(db, tenantId, record.subject, optimizationId);
  if (!optimization) return NextResponse.json({ error: 'No such optimization' }, { status: 404 });

  if (!(await claimOptimization(db, optimizationId))) {
    return NextResponse.json({ status: optimization.status, alreadyClaimed: true });
  }

  try {
    const agent = await getAgent(db, tenantId, record.subject, optimization.agentId);
    if (!agent) {
      await finishOptimization(db, optimizationId, {
        status: 'failed',
        error: 'The agent no longer exists.',
      });
      return NextResponse.json({ status: 'failed' });
    }

    const outcome = await optimizeAgent(
      db,
      tenantId,
      record.subject,
      agent,
      optimization.request.windowDays
    );
    if ('error' in outcome) {
      await finishOptimization(db, optimizationId, {
        status: 'failed',
        error: outcome.error,
        detail: outcome.detail ?? null,
      });
      return NextResponse.json({ status: 'failed' });
    }
    await finishOptimization(db, optimizationId, {
      status: 'succeeded',
      result: outcome.report,
      usage: outcome.usage,
    });
    // The pass's own spend, in the same ledger the page it serves reads —
    // attributed to the owner who asked, against the agent it was about.
    await recordLlmCall(db, {
      tenantId,
      subject: record.subject,
      agentId: optimization.agentId,
      purpose: 'optimize',
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    });
    return NextResponse.json({ status: 'succeeded' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('optimization {optimizationId} threw: {error}', {
      component: 'api/agents-optimize-run',
      tenantId,
      optimizationId,
      error: message,
    });
    await finishOptimization(db, optimizationId, { status: 'failed', error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
