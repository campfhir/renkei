import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { deleteCleanerScript, listCleanerScripts } from '@renkei/email-sanitizer';
import { recordAuditEvent } from '@/lib/audit-events';

/** Delete a cleaner script. Edits go through POST on the collection. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
): Promise<NextResponse> {
  const { slug, id } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Named in the audit trail; after the delete there is no row to ask.
  const existing = await listCleanerScripts(tenantRef.id);
  const name = existing.ok ? existing.val.find((script) => script.id === id)?.name : undefined;

  const deleted = await deleteCleanerScript(tenantRef.id, id);
  if (!deleted.ok) return NextResponse.json({ error: 'Could not delete' }, { status: 500 });

  recordAuditEvent({
    tenantId: tenantRef.id,
    actorSubject: access.subject,
    action: 'sanitizer.script_deleted',
    targetKind: 'cleaner-script',
    targetLabel: name ?? id,
  });
  return NextResponse.json({ deleted: true });
}
