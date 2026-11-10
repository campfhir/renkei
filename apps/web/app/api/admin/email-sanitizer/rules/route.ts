/**
 * Org-admin CRUD over classifier rules — content-free sender policy (domain/
 * sender/subject pattern → category). Safe for an operator to manage
 * directly: matching a rule never requires looking at message content. See
 * packages/email-sanitizer for the pipeline this configures.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { isEmailCategory, isClassifierMatchType } from '@/lib/email-sanitizer-guards';
import { listClassifierRules, upsertClassifierRule } from '@renkei/email-sanitizer';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import { isRecord } from '@renkei/guards';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await listClassifierRules();
  if (!result.ok) {
    logger.error(
      '{actor} opened the classifier rules, but they could not be read; the page got a 500: {error}',
      {
        component: 'api/admin/email-sanitizer/rules',
        ...who(access),
        error: result.err.message ?? result.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not read classifier rules' }, { status: 500 });
  }
  return NextResponse.json({ rules: result.val });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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
    category,
    matchType,
    matchValue,
    senderKey,
    priority,
    enabled,
  });
  if (!result.ok) {
    logger.error(
      '{actor} added the classifier rule "{matchType}: {matchValue}" ({category}), but it was not saved: {error}',
      {
        component: 'api/admin/email-sanitizer/rules',
        ...who(access),
        category,
        matchType,
        matchValue,
        error: result.err.message ?? result.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not save the rule' }, { status: 500 });
  }
  return NextResponse.json({ id: result.val });
}
