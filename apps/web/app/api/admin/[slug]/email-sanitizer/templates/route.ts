/**
 * Read-only "template health" for org-admins: sender, active version,
 * status, threshold, and an aggregate drift count. Deliberately GET-only
 * and content-free — templates are authored from a message owner's own
 * private mail-review page (see /[slug]/mail-review), never here. This
 * route must never grow a way to read message content; see
 * packages/email-sanitizer/src/persistence/log.ts for why.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { listTemplateHealth } from '@renkei/email-sanitizer';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await listTemplateHealth(tenantRef.id);
  if (!result.ok) {
    return NextResponse.json({ error: 'Could not read template health' }, { status: 500 });
  }
  return NextResponse.json({ templates: result.val });
}
