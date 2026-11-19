/**
 * One of the person's Fabric operations — the polling half of the
 * operation page, for a browser whose event stream could not stay open
 * (a proxy that buffers, a network that drops it). Each GET moves the
 * operation along first when it is due, as the stream would.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { currentOperation } from '@/lib/fabric/server';
import { operationView } from '@/lib/fabric/operation-view';
import { isUuid } from '@/lib/uuid';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ operationId: string }> }
): Promise<NextResponse> {
  const { operationId } = await params;
  if (!isUuid(operationId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const operation = await currentOperation(session.subject, operationId);
  if (!operation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Polling is watching too: the sweep leaves it to this page.
  if (operation.status === 'running') {
    await getDataStore().fabricOperations.markWatched(session.subject, operationId, new Date());
  }
  return NextResponse.json({ operation: operationView(operation) });
}
