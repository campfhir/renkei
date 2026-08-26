/**
 * Prove a share's connection details actually reach a server — with the
 * STORED credential, or with credential fields from the body so an admin
 * can test before saving. The fileshare worker makes the connection (it is
 * the only process that opens protocol sessions or reads stored
 * credentials); unsaved credentials cross only the authenticated internal
 * seam and are never echoed in any direction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseSharePayload } from '@/lib/file-shares/parse';
import { clientFailure, fsTestConnection } from '@/lib/file-shares/service-client';
import { getShare } from '@renkei/connector-fileshares';

export async function POST(
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

  // The body is the same share payload the config form holds, so unsaved
  // edits (host, root, credentials) are what gets tested — falling back to
  // the stored share and credential where the body carries none.
  const body: unknown = await request.json().catch(() => null);
  const parsed = body === null ? null : parseSharePayload(body);
  if (parsed && 'error' in parsed) {
    return NextResponse.json({ ok: false, error: parsed.error });
  }

  const stored = await getShare(dbResult.val, tenant.id, shareId);
  if (!stored.ok) return NextResponse.json({ error: 'Could not read the share' }, { status: 500 });
  const storedRow = stored.val;

  let summary;
  if (parsed) {
    summary = {
      id: storedRow?.summary.id ?? 'unsaved',
      name: parsed.input.name,
      protocol: parsed.input.protocol,
      host: parsed.input.host,
      port: parsed.input.port,
      shareName: parsed.input.shareName,
      rootPath: parsed.input.rootPath,
      caseInsensitive: parsed.input.caseInsensitive,
      maxAccess: parsed.input.maxAccess,
    };
  } else if (storedRow) {
    summary = storedRow.summary;
  } else {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const tested = await fsTestConnection({
    tenantId: tenant.id,
    storedShareId: storedRow ? shareId : null,
    summary,
    credentials: parsed?.credentials ?? null,
  });
  if (!tested.ok) {
    if (tested.err.kind === 'op') {
      switch (tested.err.type) {
        case 'no_credentials':
          return NextResponse.json({
            ok: false,
            error: 'No credentials stored yet — enter them first.',
          });
        case 'bad_credentials':
          return NextResponse.json({
            ok: false,
            error: 'Stored credentials cannot be read — re-enter them.',
          });
        default:
          return NextResponse.json({
            ok: false,
            error: tested.err.message ?? `Connection failed (${tested.err.type})`,
          });
      }
    }
    const failure = clientFailure(tested.err);
    return NextResponse.json({ ok: false, error: failure.message });
  }
  return NextResponse.json({ ok: true, entries: tested.val.entries });
}
