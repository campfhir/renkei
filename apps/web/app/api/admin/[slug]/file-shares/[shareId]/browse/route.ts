/**
 * The rules editor's view of a share: an UNFILTERED listing over the
 * service credential (operator-only — this is the one surface that sees
 * everything), each entry annotated with the selected layer's computed
 * access and whether that value comes from an explicit rule on the entry
 * itself or is inherited from above. `subject` empty = the share-wide
 * layer; set = that subject's layer, whose default is their grant.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  childPath,
  decryptCredentials,
  getShare,
  layerAccess,
  listGrants,
  listRules,
  normalizePath,
  openBackend,
  readCredentialCiphertext,
  withSessionLimits,
} from '@renkei/connector-fileshares';
import type { AccessLevel, PathRule } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';

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

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Encryption key unavailable' }, { status: 500 });
  }
  const ciphertext = await readCredentialCiphertext(dbResult.val, tenant.id, shareId);
  if (!ciphertext.ok || ciphertext.val === null) {
    return NextResponse.json({ error: 'No credentials stored yet' }, { status: 503 });
  }
  const credentials = decryptCredentials(ciphertext.val, keyResult.val);
  if (!credentials.ok) {
    return NextResponse.json({ error: 'Stored credentials cannot be read' }, { status: 503 });
  }

  const listed = await withSessionLimits(shareId, 'interactive', async () => {
    const backend = await openBackend(summary, credentials.val);
    if (!backend.ok) return backend;
    try {
      return await backend.val.list(path.val);
    } finally {
      await backend.val.close();
    }
  });
  if (!listed.ok) {
    return NextResponse.json(
      { error: listed.err.message ?? listed.err.type },
      { status: listed.err.type === 'not_found' ? 404 : 502 }
    );
  }

  const ci = summary.caseInsensitive;
  const explicitPaths = new Set(rules.map((rule) => (ci ? rule.path.toLowerCase() : rule.path)));
  return NextResponse.json({
    path: path.val,
    layerDefault,
    entries: listed.val.map((entry) => {
      const entryPath = childPath(path.val, entry.name);
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
