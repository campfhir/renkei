/**
 * The Apex panel's Pull search: an org's own classes and triggers whose
 * names contain the words (all of them, first fifty of each, with none).
 *
 *   GET ?org=<connector key>&q=<words> → { where, entries: OrgApexEntry[] }
 *
 * On the person's own admin connection to that org, which must carry the
 * Apex capability.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { failed, searchOrgApex } from '@/lib/code/salesforce-apex';
import { apexFailureResponse, apexRouteContext } from '@/lib/code/salesforce-apex-route';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const ready = await apexRouteContext(request, params, { write: false });
  if (!ready.ok) return ready.response;
  const url = new URL(request.url);
  const found = await searchOrgApex(ready.context.caller, {
    org: url.searchParams.get('org') ?? undefined,
    query: (url.searchParams.get('q') ?? '').slice(0, 80),
  });
  if (failed(found)) return apexFailureResponse(ready.context, found, 'search an org’s Apex');
  return NextResponse.json(found);
}
