/** The org's requests for larger code-workspace checkouts, for the admin to decide. */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDatabase } from '@renkei/db';
import { listSizeRequests } from '@/lib/code/size-requests';

export async function GET(
  _request: NextRequest
): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = getDatabase();
  if (!db.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  return NextResponse.json({ requests: await listSizeRequests(db.val) });
}
