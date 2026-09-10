/**
 * One connector's audience: the IdP group values a person must carry (any
 * one of them) to be offered it. An empty list is everyone.
 *
 * Keyed by capability key, not config key, because that is what the gate
 * reads — SharePoint can be scoped without scoping mail, which shares its
 * Entra app — and mounted outside /connectors/<configKey>/ so the two
 * namespaces cannot collide ('jira' the capability vs 'atlassian' the
 * config).
 *
 * Takes effect immediately for tools (the catalog cache is invalidated
 * here and the settings row moves the tool-surface version) — a connected
 * person outside the new audience loses the tools on their next request.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrgSettings, setOrgSettings } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { togglableConnectors } from '@/lib/connector-catalog';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { recordAuditEvent } from '@/lib/audit-events';

const MAX_VALUES = 50;
const MAX_VALUE_CHARS = 255;

function knownKey(capabilityKey: string): boolean {
  return togglableConnectors().some((entry) => entry.capabilityKey === capabilityKey);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; capabilityKey: string }> }
): Promise<NextResponse> {
  const { slug, capabilityKey } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!knownKey(capabilityKey)) {
    return NextResponse.json({ error: 'Unknown connector' }, { status: 404 });
  }
  const settings = await getOrgSettings(tenantRef.id);
  if (!settings.ok) {
    return NextResponse.json({ error: 'Could not read org settings' }, { status: 500 });
  }
  return NextResponse.json({ claimValues: settings.val.connectorAudiences[capabilityKey] ?? [] });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; capabilityKey: string }> }
): Promise<NextResponse> {
  const { slug, capabilityKey } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!knownKey(capabilityKey)) {
    return NextResponse.json({ error: 'Unknown connector' }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const submitted = 'claimValues' in body ? body.claimValues : undefined;
  if (!Array.isArray(submitted)) {
    return NextResponse.json({ error: 'claimValues must be an array' }, { status: 400 });
  }
  const claimValues = [
    ...new Set(
      submitted
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    ),
  ];
  if (claimValues.length > MAX_VALUES) {
    return NextResponse.json({ error: `At most ${MAX_VALUES} groups` }, { status: 400 });
  }
  if (claimValues.some((value) => value.length > MAX_VALUE_CHARS)) {
    return NextResponse.json({ error: 'A group value is too long' }, { status: 400 });
  }

  const settings = await getOrgSettings(tenantRef.id);
  if (!settings.ok) {
    return NextResponse.json({ error: 'Could not read org settings' }, { status: 500 });
  }
  // Rewrite the whole map: an emptied rule is dropped rather than kept as
  // an empty list, so "everyone" has one representation.
  const connectorAudiences = { ...settings.val.connectorAudiences };
  if (claimValues.length === 0) delete connectorAudiences[capabilityKey];
  else connectorAudiences[capabilityKey] = claimValues;

  const saved = await setOrgSettings(tenantRef.id, { connectorAudiences });
  if (!saved.ok) {
    return NextResponse.json({ error: 'Could not save org settings' }, { status: 500 });
  }
  // Org-wide: every cached catalog in the tenant may now be wrong about
  // which tools register for whom.
  invalidateToolCatalogCache(tenantRef.id);
  recordAuditEvent({
    tenantId: tenantRef.id,
    actorSubject: session.subject,
    action: 'connector.audience_updated',
    targetKind: 'connector',
    targetLabel: capabilityKey,
    details: { groups: claimValues.length },
  });
  return NextResponse.json({ claimValues });
}
