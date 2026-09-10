/**
 * A person's own catalog selections: which connectors show on their
 * connectors page.
 *
 * PUT adds one, DELETE removes one; both answer with the full list so the
 * page can replace its state rather than patch it. A selection is a layout
 * preference — it never registers or unregisters a tool — so the only
 * validation is that the key names something this person may actually add:
 * a connector the org offers them, per the same rules the page's catalog
 * uses. Adding a hidden connector would put an empty card on the page and
 * imply an entitlement that the projection would then refuse.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getConnectorPrefs, setConnectorPrefs } from '@renkei/user-prefs';
import { getSessionFromRequest } from '@/lib/session';
import { resolveUserCatalog } from '@/lib/connectors/user-catalog';
import { resolveAudienceAllows } from '@/lib/connectors/audience';

async function connectorFrom(request: NextRequest): Promise<string | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const connector = 'connector' in body ? body.connector : undefined;
  return typeof connector === 'string' && connector.length > 0 ? connector : null;
}

async function change(
  request: NextRequest,
  params: Promise<{ tenantId: string }>,
  apply: (added: string[], connector: string) => string[]
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const connector = await connectorFrom(request);
  if (!connector) {
    return NextResponse.json({ error: 'connector is required' }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });

  const catalog = await resolveUserCatalog(dbResult.val, tenantId, session.subject, {
    audienceAllows: await resolveAudienceAllows(dbResult.val, tenantId, session.subject),
    fresh: true,
  });
  if (!catalog.available.some((entry) => entry.capabilityKey === connector)) {
    return NextResponse.json({ error: 'Unknown or unavailable connector' }, { status: 400 });
  }

  const current = await getConnectorPrefs(tenantId, session.subject, { fresh: true });
  const added = apply(current.added, connector);
  const saved = await setConnectorPrefs(tenantId, session.subject, { added });
  if (!saved.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  return NextResponse.json({ added });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  return change(request, params, (added, connector) =>
    added.includes(connector) ? added : [...added, connector]
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  return change(request, params, (added, connector) => added.filter((key) => key !== connector));
}
