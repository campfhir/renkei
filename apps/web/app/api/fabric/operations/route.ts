/**
 * The person's Fabric definition fetches: GET lists their recent ones,
 * POST starts one — Fabric answers at once (written finished) or with a
 * long-running operation (written running, then followed by the
 * operation's stream while the page is open and by the worker's sweep
 * when it is not).
 */

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { getDataStore } from '@renkei/db';
import { startDefinitionOperation } from '@renkei/connector-fabric';
import { getSessionFromRequest } from '@/lib/session';
import { fabricAccessFor } from '@/lib/fabric/server';
import { operationView } from '@/lib/fabric/operation-view';
import { isGuid } from '@/lib/mcp-tools/fabric/client';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const operations = await getDataStore().fabricOperations.list(session.subject, { limit: 20 });
  return NextResponse.json({ operations: operations.map(operationView) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  const { kind, workspaceId, itemId } = body;
  if (kind !== 'notebook-definition' && kind !== 'pipeline-definition') {
    return NextResponse.json(
      { error: 'kind is notebook-definition or pipeline-definition' },
      { status: 400 }
    );
  }
  if (
    typeof workspaceId !== 'string' ||
    !isGuid(workspaceId) ||
    typeof itemId !== 'string' ||
    !isGuid(itemId)
  ) {
    return NextResponse.json({ error: 'workspaceId and itemId are Fabric ids' }, { status: 400 });
  }
  const access = await fabricAccessFor(session.subject);
  if (typeof access === 'string') return NextResponse.json({ error: access }, { status: 409 });

  const started = await startDefinitionOperation({
    id: randomUUID(),
    subject: session.subject,
    kind,
    workspaceId,
    workspaceName: typeof body.workspaceName === 'string' ? body.workspaceName.slice(0, 256) : '',
    itemId,
    itemName: typeof body.itemName === 'string' ? body.itemName.slice(0, 256) : '',
    format: kind === 'notebook-definition' ? 'ipynb' : null,
    fetcher: access.fetcher,
    base: access.base,
    now: new Date(),
  });
  if (!started.ok) {
    logger.warn(
      '{actor} asked Fabric for the definition of "{item}", and Fabric refused; nothing was started: {error}',
      {
        component: 'api/fabric/operations',
        ...who(session),
        item: typeof body.itemName === 'string' ? body.itemName : itemId,
        workspaceId,
        itemId,
        error: started.error,
      }
    );
    return NextResponse.json({ error: started.error }, { status: 502 });
  }
  logger.info('{actor} asked Fabric for the definition of "{item}"; it is {status}', {
    component: 'api/fabric/operations',
    ...who(session),
    item: started.operation.itemName || itemId,
    operationId: started.operation.id,
    status: started.operation.status,
  });
  return NextResponse.json({ operation: operationView(started.operation) }, { status: 201 });
}
