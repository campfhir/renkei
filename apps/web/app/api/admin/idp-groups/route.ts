/**
 * The IdP group values sign-ins have recorded, for the audience picker's
 * suggestions. A convenience, never a gate: an admin may type a group
 * nobody has signed in with yet, and the rule takes effect when they do.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { observedIdpGroups } from '@/lib/identity';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get('q') ?? '';
  const values = await observedIdpGroups(query.slice(0, 200));
  return NextResponse.json({ groups: values.map((value) => ({ key: value, label: value })) });
}
