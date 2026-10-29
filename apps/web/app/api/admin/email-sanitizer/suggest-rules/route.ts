/**
 * Org-model rule suggestions for the sanitizer. Synchronous — the operator
 * clicked a button and is watching. Nothing is persisted: suggestions come
 * back for review, and each one the operator accepts goes through the
 * ordinary POST /rules route with its validation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { suggestSanitizerRules } from '@/lib/email-sanitizer/suggest-rules';

export async function POST(_request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await suggestSanitizerRules();
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ suggestions: result.suggestions });
}
