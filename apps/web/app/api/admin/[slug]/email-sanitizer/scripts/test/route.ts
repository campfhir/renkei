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

  const body: unknown = await request.json().catch(() => null);
  const payload: {
    script?: unknown;
    text?: unknown;
    subject?: unknown;
    fromAddress?: unknown;
    fromName?: unknown;
    senderAddress?: unknown;
    replyToAddress?: unknown;
    messageId?: unknown;
    kind?: unknown;
    organizer?: unknown;
    attendees?: unknown;
    location?: unknown;
  } = typeof body === 'object' && body !== null ? body : {};
  const script = typeof payload.script === 'string' ? payload.script : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!script.trim() || !text.trim()) {
    return NextResponse.json({ error: 'Both a script and a sample are needed.' }, { status: 400 });
  }
  if (script.length > MAX_SCRIPT_CHARS) {
    return NextResponse.json({ error: 'Script too large.' }, { status: 400 });
  }

  // Header fields are settable so a script keyed on them (a reply-to
  // domain, an @odspnotify message id) can be exercised before enabling.
  const field = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback;
  const optionalField = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null;

  // Dry-running an invite as if it were mail would let a script pass here
  // and behave differently in production, which defeats the point of the
  // box being the production sandbox.
  const kind = isContentKind(payload.kind) ? payload.kind : 'msg';
  const attendees = Array.isArray(payload.attendees)
    ? payload.attendees.filter((entry): entry is string => typeof entry === 'string').slice(0, 50)
    : [];

  const result = await runCleanerScript(script, {
    kind,
    text: text.slice(0, 100_000),
    subject: field(payload.subject, '(test)'),
    fromAddress: field(payload.fromAddress, 'test@example.com'),
    fromName: field(payload.fromName, 'Test'),
    senderAddress: optionalField(payload.senderAddress),
    replyToAddress: optionalField(payload.replyToAddress),
    messageId: optionalField(payload.messageId),
    receivedAt: '2026-01-01T00:00:00Z',
    organizer: optionalField(payload.organizer),
    attendees,
    location: optionalField(payload.location),
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: `${result.err.type}: ${result.detail ?? 'the script failed'}` },
      { status: 422 }
    );
  }
  return NextResponse.json({ output: result.val });
}
