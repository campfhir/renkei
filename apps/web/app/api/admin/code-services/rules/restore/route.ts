/**
 * Put the seeded public images back into the allow-list — the ones that
 * are missing; whatever the organization added or kept stays. Operator-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { clientFailure, sandboxServicesEnabled, sbImageRulesRestore } from '@renkei/sandbox-client';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { logger } from '@/lib/logger';

export async function POST(
  _request: NextRequest
): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await sandboxServicesEnabled())) {
    return NextResponse.json(
      { error: 'Code project services are not enabled on this deployment', enabled: false },
      { status: 503 }
    );
  }
  const restored = await sbImageRulesRestore();
  if (!restored.ok) {
    const failure = clientFailure(restored.err);
    if (failure.status !== 400 && failure.status !== 404) {
      logger[failure.status >= 500 ? 'error' : 'warn']('Sandbox request failed ({status}): {error}', {
        component: 'api/admin/code-services/rules/restore',
        operation: 'restored',
        status: failure.status,
        error: 'message' in restored.err && restored.err.message ? restored.err.message : failure.message,
      });
    }
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ added: restored.val.added, rules: restored.val.rules });
}
