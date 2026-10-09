/**
 * The organization's service image allow-list (code_service_image_rules):
 * operator-only, read and written through the sandbox worker, which
 * seals a registry credential under its own key. Off when the deployment
 * does not offer services — the page says so rather than showing an
 * empty list.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  clientFailure,
  sandboxServicesEnabled,
  sbImageRuleSet,
  sbImageRulesList,
} from '@renkei/sandbox-client';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { parseImageRulePayload } from '@/lib/code/image-rules';

async function operatorGate(): Promise<NextResponse | null> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await sandboxServicesEnabled())) {
    return NextResponse.json(
      { error: 'Code project services are not enabled on this deployment', enabled: false },
      { status: 503 }
    );
  }
  return null;
}

export async function GET(
  _request: NextRequest
): Promise<NextResponse> {
  const denied = await operatorGate();
  if (denied) return denied;
  const listed = await sbImageRulesList();
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ rules: listed.val });
}

export async function POST(
  request: NextRequest
): Promise<NextResponse> {
  const denied = await operatorGate();
  if (denied) return denied;
  const body: unknown = await request.json().catch(() => null);
  const parsed = parseImageRulePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const set = await sbImageRuleSet(parsed);
  if (!set.ok) {
    const failure = clientFailure(set.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ rule: set.val.rule, dropped: set.val.dropped }, { status: 201 });
}
