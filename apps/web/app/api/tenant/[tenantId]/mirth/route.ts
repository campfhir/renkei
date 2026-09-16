/**
 * The org's Mirth instances as this caller sees them — the REST twin of
 * what the connectors card renders. Every enabled instance is listed
 * (discovery is not the gate in this model — credentials are), marked with
 * whether the caller has connected it and, where they have, the account
 * name and their LLM-exposure choice.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { listInstancesWithConnection } from '@renkei/connector-mirth';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const instances = await listInstancesWithConnection(dbResult.val, tenantId, session.subject);
  if (!instances.ok) {
    return NextResponse.json({ error: 'Could not read the instances' }, { status: 500 });
  }

  return NextResponse.json({
    instances: instances.val.map((entry) => ({
      id: entry.instance.id,
      name: entry.instance.name,
      environment: entry.instance.environment,
      baseUrl: entry.instance.baseUrl,
      connection: entry.connection
        ? {
            username: entry.connection.username,
            toolAccess: entry.connection.toolAccess,
            allowDestructive: entry.connection.allowDestructive,
          }
        : null,
    })),
  });
}
