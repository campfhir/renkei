/**
 * Org-admin switching of connectors on and off.
 *
 * Distinct from the three neighbouring controls, and the distinction is the
 * reason this route exists:
 *
 *   connector_configs.enabled  stops new CONNECTIONS. Already-connected users
 *                              keep working, so it is not an off switch.
 *   the scope ceiling          narrows what a user may consent to, and taking
 *                              a capability back means every connected user
 *                              must reconnect to get it again.
 *   disabledConnectors (here)  stops the TOOLS being registered, org-wide and
 *                              immediately, touching nobody's grant. Flipping
 *                              it back restores everything with no user
 *                              action at all.
 *
 * That last property is what makes this the right control for "turn this off
 * for now" — the others are provisioning decisions wearing the same clothes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getOrgSettings, setOrgSettings } from '@renkei/settings';
import { togglableConnectors } from '@/lib/connector-catalog';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const settings = await getOrgSettings(tenantRef.id);
  if (!settings.ok) {
    return NextResponse.json({ error: 'Could not read org settings' }, { status: 500 });
  }
  return NextResponse.json({ disabledConnectors: settings.val.disabledConnectors });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const submitted = 'disabledConnectors' in body ? body.disabledConnectors : undefined;
  if (!Array.isArray(submitted)) {
    return NextResponse.json({ error: 'disabledConnectors must be an array' }, { status: 400 });
  }

  // Only keys the catalog knows about. An unrecognised key would sit in the
  // settings row disabling nothing, which reads as "I turned it off and it
  // stayed on" — worse than a rejection.
  const known = new Set(togglableConnectors().map((entry) => entry.capabilityKey));
  const disabledConnectors = [
    ...new Set(
      submitted.filter((entry): entry is string => typeof entry === 'string' && known.has(entry))
    ),
  ];

  const saved = await setOrgSettings(tenantRef.id, { disabledConnectors });
  if (!saved.ok) {
    return NextResponse.json({ error: 'Could not save org settings' }, { status: 500 });
  }
  // Org-wide, not one caller's own — every cached catalog in this tenant
  // may now be wrong about which tools are registered.
  invalidateToolCatalogCache(tenantRef.id);
  return NextResponse.json({ disabledConnectors });
}
