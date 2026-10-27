/**
 * Do the analysis. Called by the agents worker, never by a browser — the
 * draft run route's twin, with the same authentication: the worker's
 * agent-application bearer token names a SUBJECT, the row is read under
 * that subject, and so the pass can only ever read the run content its
 * owner may read.
 */

import { NextRequest, NextResponse } from 'next/server';
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
  { params }: { params: Promise<{ optimizationId: string }> }
): Promise<NextResponse> {
  const { optimizationId } = await params;

  const token = getBearerToken(request);
  if (!token) return NextResponse.json({ error: 'Not authorized' }, { status: 401 });
  const record = await resolveAccessToken(token, 'agent');
  if (!record) return NextResponse.json({ error: 'Not authorized' }, { status: 401 });

  const optimization = await getOptimization(record.subject, optimizationId);
  if (!optimization) return NextResponse.json({ error: 'No such optimization' }, { status: 404 });

  if (!(await claimOptimization(optimizationId))) {
    return NextResponse.json({ status: optimization.status, alreadyClaimed: true });
  }

  try {
    const agent = await getAgent(record.subject, optimization.agentId);
    if (!agent) {
      await finishOptimization(optimizationId, {
        status: 'failed',
        error: 'The agent no longer exists.',
      });
      return NextResponse.json({ status: 'failed' });
    }

    const outcome = await optimizeAgent(record.subject, agent, optimization.request.windowDays);
    if ('error' in outcome) {
      await finishOptimization(optimizationId, {
        status: 'failed',
        error: outcome.error,
        detail: outcome.detail ?? null,
      });
      return NextResponse.json({ status: 'failed' });
    }
    await finishOptimization(optimizationId, {
      status: 'succeeded',
      result: outcome.report,
      usage: outcome.usage,
    });
    // The pass's own spend, in the same ledger the page it serves reads —
    // attributed to the owner who asked, against the agent it was about.
    await recordLlmCall({
      subject: record.subject,
      agentId: optimization.agentId,
      purpose: 'optimize',
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      cacheReadInputTokens: outcome.usage.cacheReadInputTokens,
      cacheWriteInputTokens: outcome.usage.cacheWriteInputTokens,
      model: outcome.model,
    });
    return NextResponse.json({ status: 'succeeded' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('optimization {optimizationId} threw: {error}', {
      component: 'api/agents-optimize-run',
      optimizationId,
      error: message,
    });
    await finishOptimization(optimizationId, { status: 'failed', error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
