/** The accounts (organizations/user accounts) Renkei's GitHub App is installed on for the signed-in person — for the new-project form's browser. */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { githubAuthFor, listAccounts } from '@/lib/code/github-browse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const listed = await listAccounts(await githubAuthFor(request, tenantId, session.subject));
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 409 });
  return NextResponse.json({ accounts: listed.accounts });
}
