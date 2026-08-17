/**
 * Dry-run a cleaner script against a pasted sample, in the same sandbox
 * with the same limits production uses — the admin sees exactly what the
 * pipeline would do before enabling anything. Nothing is persisted and
 * the sample is text the admin pasted themselves.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { runCleanerScript, MAX_SCRIPT_CHARS } from '@renkei/email-sanitizer';

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

  const body: unknown = await request.json().catch(() => null);
  const payload: { script?: unknown; text?: unknown } =
    typeof body === 'object' && body !== null ? body : {};
  const script = typeof payload.script === 'string' ? payload.script : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!script.trim() || !text.trim()) {
    return NextResponse.json({ error: 'Both a script and a sample are needed.' }, { status: 400 });
  }
  if (script.length > MAX_SCRIPT_CHARS) {
    return NextResponse.json({ error: 'Script too large.' }, { status: 400 });
  }

  const result = await runCleanerScript(script, {
    text: text.slice(0, 100_000),
    subject: '(test)',
    fromAddress: 'test@example.com',
    fromName: 'Test',
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: `${result.err.type}: ${result.detail ?? 'the script failed'}` },
      { status: 422 }
    );
  }
  return NextResponse.json({ output: result.val });
}
