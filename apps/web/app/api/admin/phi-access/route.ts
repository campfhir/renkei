/**
 * The PHI access trail, for an operator (migration 141; lib/phi-access.ts):
 * who read, searched, exported or downloaded which clinical record through
 * the Mirth, OnBase and file-share tools, by identifier — never content.
 *
 *   GET /api/admin/{slug}/phi-access?subject=<oidc subject>&limit=100&before=<ISO>
 *
 * `subject` narrows to one person (the Access page lists subjects);
 * without it the org's whole trail comes back, newest first. `before`
 * pages further into the past. Read-only by construction: the table is
 * append-only and this route exposes no write.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { listPhiAccessEvents } from '@/lib/phi-access';

const DEFAULT_LIMIT = 100;

export async function GET(
  request: NextRequest
): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const query = request.nextUrl.searchParams;
  const subject = query.get('subject')?.trim() || undefined;
  const limitRaw = Number(query.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;
  const beforeRaw = query.get('before');
  const before = beforeRaw ? new Date(beforeRaw) : undefined;
  if (before && Number.isNaN(before.getTime())) {
    return NextResponse.json({ error: 'before must be an ISO 8601 date-time' }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const events = await listPhiAccessEvents(dbResult.val, { subject, limit, before });
  return NextResponse.json({ events });
}
