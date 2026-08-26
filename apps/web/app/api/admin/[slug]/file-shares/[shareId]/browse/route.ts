/**
 * The rules editor's view of a share: an UNFILTERED listing over the
 * service credential (operator-only — this is the one surface that sees
 * everything), each entry annotated with the selected layer's computed
 * access and whether that value comes from an explicit rule on the entry
 * itself or is inherited from above. `subject` empty = the share-wide
 * layer; set = that subject's layer, whose default is their grant.
 *
 * The listing itself comes from the fileshare worker (the process that
 * owns every SMB/SFTP session); the layer computation stays here — it is
 * pure rule evaluation over store rows, no I/O.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import {
  childPath,
  getShare,
  layerAccess,
  listGrants,
  listRules,
  normalizePath,
} from '@renkei/connector-fileshares';
import type { AccessLevel, PathRule } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { clientFailure, fsAdminList } from '@/lib/file-shares/service-client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const share = await getShare(dbResult.val, tenant.id, shareId);
  if (!share.ok) return NextResponse.json({ error: 'Could not read the share' }, { status: 500 });
  if (!share.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const summary = share.val.summary;
  if (!summary.hasCredentials) {
    return NextResponse.json({ error: 'No credentials stored yet' }, { status: 503 });
  }

  const path = normalizePath(request.nextUrl.searchParams.get('path') ?? '/');
  if (!path.ok) return NextResponse.json({ error: 'Unusable path' }, { status: 400 });

  const subject = request.nextUrl.searchParams.get('subject') || null;
  const rulesResult = await listRules(dbResult.val, tenant.id, shareId, subject);
  if (!rulesResult.ok) {
    return NextResponse.json({ error: 'Could not read rules' }, { status: 500 });
  }
  const rules: PathRule[] = rulesResult.val.map((rule) => ({
    path: rule.path,
    access: rule.access,
  }));

  // The layer's implicit '/' default: the share's ceiling for the shared
  // layer, the subject's grant default for a per-user layer.
  let layerDefault: AccessLevel = summary.maxAccess;
  if (subject) {
    const grants = await listGrants(dbResult.val, tenant.id, shareId);
    const grant = grants.ok ? grants.val.find((row) => row.subject === subject) : undefined;
    if (!grant) {
      return NextResponse.json({ error: 'That subject holds no grant here' }, { status: 400 });
    }
    layerDefault = grant.defaultAccess;
  }

  const listed = await fsAdminList(tenant.id, shareId, path.val);
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }

  const ci = summary.caseInsensitive;
  const explicitPaths = new Set(rules.map((rule) => (ci ? rule.path.toLowerCase() : rule.path)));
  return NextResponse.json({
    path: listed.val.path,
    layerDefault,
    entries: listed.val.entries.map((entry) => {
      const entryPath = childPath(listed.val.path, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        kind: entry.kind,
        size: entry.size,
        access: layerAccess(rules, entryPath, layerDefault, ci),
        explicit: explicitPaths.has(ci ? entryPath.toLowerCase() : entryPath),
      };
    }),
  });
}
