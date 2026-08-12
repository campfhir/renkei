/**
 * Teach (or re-teach) an extraction template for a system-of-record sender,
 * from a real sample the caller is looking at on their own mail-review
 * page. Any signed-in user may do this — a saved template holds only
 * boilerplate text and field names (see registry/template.ts), never a
 * captured value, so it's safe to share tenant-wide the moment it's derived,
 * unlike everything else in the mail-review surface.
 *
 * v1 limitation: the sample is the bounded ~1000-char excerpt already shown
 * on the review page, not the full original body (which is never persisted
 * at rest) — long wrapper text may not fit. A live "fetch the full body to
 * mark up" flow is a natural follow-up, not built here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getIdentityEmail } from '@/lib/identity';
import { deriveTemplate, saveTemplateVersion } from '@renkei/email-sanitizer';
import type { MarkedField } from '@renkei/email-sanitizer';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMarkedFields(value: unknown): MarkedField[] | null {
  if (!Array.isArray(value)) return null;
  const fields: MarkedField[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      typeof entry.start !== 'number' ||
      typeof entry.end !== 'number' ||
      entry.end <= entry.start
    ) {
      return null;
    }
    fields.push({
      name: entry.name.trim(),
      start: entry.start,
      end: entry.end,
      pattern:
        typeof entry.pattern === 'string' && entry.pattern.trim()
          ? entry.pattern.trim()
          : undefined,
    });
  }
  return fields;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  const emailResult = await getIdentityEmail(tenantId, session.subject);
  const userEmail = emailResult.ok ? emailResult.val : null;
  if (!userEmail) {
    return NextResponse.json(
      { error: 'No email on record for your identity — sign out and back in to refresh it' },
      { status: 400 }
    );
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.senderKey !== 'string' || !body.senderKey.trim()) {
    return NextResponse.json({ error: 'senderKey is required' }, { status: 400 });
  }
  if (typeof body.sample !== 'string' || !body.sample.trim()) {
    return NextResponse.json({ error: 'sample is required' }, { status: 400 });
  }
  const markedFields = parseMarkedFields(body.markedFields);
  if (!markedFields || markedFields.length === 0) {
    return NextResponse.json(
      { error: 'markedFields must mark at least one field span' },
      { status: 400 }
    );
  }
  const matchThreshold =
    typeof body.matchThreshold === 'number' && body.matchThreshold > 0 && body.matchThreshold <= 1
      ? body.matchThreshold
      : undefined;

  const segments = deriveTemplate(body.sample, markedFields);
  const result = await saveTemplateVersion(tenantId, body.senderKey.trim(), segments, {
    matchThreshold,
    derivedByUpn: userEmail,
  });
  if (!result.ok) {
    return NextResponse.json({ error: 'Could not save the template' }, { status: 500 });
  }
  return NextResponse.json({ template: result.val });
}
