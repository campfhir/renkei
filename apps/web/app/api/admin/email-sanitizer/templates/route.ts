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
import { listTemplateHealth } from '@renkei/email-sanitizer';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await listTemplateHealth();
  if (!result.ok) {
    logger.error(
      '{actor} opened the extraction-template health page, but it could not be read; the page got a 500: {error}',
      {
        component: 'api/admin/email-sanitizer/templates',
        ...who(access),
        error: result.err.message ?? result.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not read template health' }, { status: 500 });
  }
  return NextResponse.json({ templates: result.val });
}
