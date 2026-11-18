/**
 * The code pane's Apex panel (app/(app)/code/_components/apex-panel.tsx):
 * whether to offer it — the checkout holds Apex or a Salesforce DX project,
 * and the person's Salesforce Admin connection has the Apex capability —
 * and what it starts from: the orgs that capability reaches, the Apex
 * changed and not committed, and the repository's test classes.
 *
 *   GET → ApexPanelStatus (lib/code/salesforce-apex.ts)
 *
 * Reached through a chat (`/chats/[chatId]/salesforce-apex`) it reads that
 * chat's worktree; anyone who can read the project may look.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { apexPanelStatus, failed } from '@/lib/code/salesforce-apex';
import { apexFailureResponse, apexRouteContext } from '@/lib/code/salesforce-apex-route';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const ready = await apexRouteContext(request, params, { write: false });
  if (!ready.ok) return ready.response;
  const status = await apexPanelStatus(ready.context.checkout, ready.context.caller);
  if (failed(status))
    return apexFailureResponse(ready.context, status, 'read the Apex in the checkout');
  return NextResponse.json(status);
}
