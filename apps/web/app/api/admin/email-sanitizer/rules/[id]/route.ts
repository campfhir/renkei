/**
 * Update or delete one classifier rule. See ../route.ts for the create path
 * and the content-free rationale.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { isEmailCategory, isClassifierMatchType } from '@/lib/email-sanitizer-guards';
import { upsertClassifierRule, deleteClassifierRule } from '@renkei/email-sanitizer';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const { category, matchType, matchValue } = body;
  if (typeof category !== 'string' || !isEmailCategory(category)) {
    return NextResponse.json(
      { error: 'category must be one of human, system_notification, marketing' },
      { status: 400 }
    );
  }
  if (typeof matchType !== 'string' || !isClassifierMatchType(matchType)) {
    return NextResponse.json(
      { error: 'matchType must be one of domain, sender_email, subject_contains' },
      { status: 400 }
    );
  }
  if (typeof matchValue !== 'string' || !matchValue.trim()) {
    return NextResponse.json({ error: 'matchValue is required' }, { status: 400 });
  }
  const senderKey =
    typeof body.senderKey === 'string' && body.senderKey.trim() ? body.senderKey.trim() : null;
  if (category === 'system_notification' && !senderKey) {
    return NextResponse.json(
      {
        error:
          'senderKey is required for system_notification rules — it names the extraction template family',
      },
      { status: 400 }
    );
  }
  const priority =
    typeof body.priority === 'number' && Number.isFinite(body.priority) ? body.priority : 100;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  const result = await upsertClassifierRule({
    id,
    category,
    matchType,
    matchValue,
    senderKey,
    priority,
    enabled,
  });
  if (!result.ok) {
    return NextResponse.json({ error: 'Could not save the rule' }, { status: 500 });
  }
  return NextResponse.json({ id: result.val });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await deleteClassifierRule(id);
  if (!result.ok) {
    return NextResponse.json({ error: 'Could not delete the rule' }, { status: 500 });
  }
  return NextResponse.json({ deleted: true });
}
