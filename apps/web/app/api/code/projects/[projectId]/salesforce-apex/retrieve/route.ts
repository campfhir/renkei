/**
 * The Apex panel's Pull: classes and triggers from an org written into the
 * chat's worktree, in the Salesforce DX layout (a file already there is
 * replaced; nothing is committed).
 *
 *   POST { org, names: string[] } → Retrieved (lib/code/salesforce-apex.ts)
 *
 * The chat's owner, an editor of the project, only.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { apexNames, failed, retrieveApex } from '@/lib/code/salesforce-apex';
import { apexFailureResponse, apexRouteContext } from '@/lib/code/salesforce-apex-route';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const ready = await apexRouteContext(request, params, { write: true });
  if (!ready.ok) return ready.response;
  const body: unknown = await request.json().catch(() => null);
  const input = isRecord(body) ? body : {};
  const result = await retrieveApex(ready.context.checkout, ready.context.caller, {
    ...(typeof input.org === 'string' ? { org: input.org } : {}),
    names: apexNames(input.names),
  });
  if (failed(result)) return apexFailureResponse(ready.context, result, 'pull Apex');
  logger.info(
    '{actor} pulled {count} Apex classes and triggers from {where} into the code project "{project}"',
    {
      component: 'api/code/salesforce-apex',
      ...who(ready.context.session),
      count: result.pulled.length,
      where: result.where,
      project: ready.context.project.name,
      projectId: ready.context.project.id,
      names: result.pulled.map((unit) => unit.name),
    }
  );
  return NextResponse.json(result);
}
