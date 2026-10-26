/**
 * The org's agent-run retention window (agentRunRetentionDays) — how long
 * run history (content included) lives before the worker's sweep prunes
 * it. An org policy in settings, like every other limit.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrgSettings, setOrgSettings } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { routeLog } from '@/lib/log-context';

const ALLOWED_DAYS = [7, 14, 30, 90];

async function GETHandler(_request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const settings = await getOrgSettings();
  if (!settings.ok) return NextResponse.json({ error: 'Settings unavailable' }, { status: 500 });
  return NextResponse.json({ agentRunRetentionDays: settings.val.agentRunRetentionDays });
}

async function PUTHandler(request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const payload: { agentRunRetentionDays?: unknown } =
    typeof body === 'object' && body !== null ? body : {};
  const days = payload.agentRunRetentionDays;
  if (typeof days !== 'number' || !ALLOWED_DAYS.includes(days)) {
    return NextResponse.json(
      { error: `agentRunRetentionDays must be one of: ${ALLOWED_DAYS.join(', ')}` },
      { status: 400 }
    );
  }

  const saved = await setOrgSettings({ agentRunRetentionDays: days });
  if (!saved.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  return NextResponse.json({ agentRunRetentionDays: days });
}

export const GET = routeLog(GETHandler);
export const PUT = routeLog(PUTHandler);
