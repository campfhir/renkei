/**
 * Org-model script drafting. Synchronous — the operator is watching. The
 * drafted script arrives pre-flown (compiled and executed against the
 * sample in the production sandbox) but NOT saved: it lands in the editor
 * for review, and only an explicit save through POST /scripts (with its
 * validation and audit event) makes it real.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getDatabase } from '@renkei/db';
import { suggestCleanerScript } from '@/lib/email-sanitizer/suggest-script';
import { isContentKind } from '@/lib/email-sanitizer/content-kinds';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });

  const body: unknown = await request.json().catch(() => null);
  const payload: { text?: unknown; instructions?: unknown; kind?: unknown } =
    typeof body === 'object' && body !== null ? body : {};
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    return NextResponse.json({ error: 'Paste a sample email body first.' }, { status: 400 });
  }

  const result = await suggestCleanerScript(
    dbResult.val,
    tenantRef.id,
    payload.text,
    typeof payload.instructions === 'string' ? payload.instructions : '',
    isContentKind(payload.kind) ? payload.kind : 'msg'
  );
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json(result);
}
