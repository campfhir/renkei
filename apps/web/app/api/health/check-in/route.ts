/**
 * POST: an application checks in — it says how it is (lib/ci/health-rules.ts
 * has the interface). No session: the bearer token is the one issued for
 * one environment of one code project, kept only as a hash, and all it can
 * do is this. It answers when the next check-in is expected, so an
 * application can pace itself from the answer.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getProjectRow } from '@/lib/chat/projects';
import { recordCheckIn } from '@/lib/ci/health';
import { DEFAULT_INTERVAL_SECONDS } from '@/lib/ci/health-rules';
import { logger } from '@/lib/logger';

const BODY_MAX_BYTES = 8 * 1024;

/** The body as JSON, or null when it is not. */
function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const text = await request.text().catch(() => '');
  if (text.length > BODY_MAX_BYTES) {
    return NextResponse.json({ error: 'A check-in is a few lines of JSON.' }, { status: 413 });
  }
  const body = parseJson(text);
  const outcome = await recordCheckIn({
    authorization: request.headers.get('authorization'),
    body,
    now: new Date(),
  });
  if (!outcome.ok) {
    logger.warn(
      'An application sent a health check-in Renkei did not take; nothing was recorded: {error}',
      {
        component: 'api/health/check-in',
        status: outcome.status,
        error: outcome.error,
      }
    );
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  const { record } = outcome;
  // The first check-in, and any that is not plain good news, is worth a line; a steady heartbeat is not.
  if (record.checkins === 1 || (record.status !== 'healthy' && record.status !== 'starting')) {
    const project = await getProjectRow(record.projectId);
    logger.info(
      'The application of the project "{project}" checked in from {environment} as {status}',
      {
        component: 'api/health/check-in',
        projectId: record.projectId,
        project: project?.name ?? record.projectId,
        environment: record.environment,
        status: record.status,
        checkins: record.checkins,
      }
    );
  }
  return NextResponse.json({
    recorded: true,
    environment: record.environment,
    status: record.status,
    nextCheckInSeconds: record.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
  });
}
