/**
 * This person's high-risk lists (@renkei/user-prefs' high-risk.ts): kind
 * 'agents' (what still waits for them when an agent accepts its own
 * actions) and 'code' (what a code project's Auto mode still asks before).
 * PUT replaces one kind's lists wholesale and answers what was stored.
 * The organization's locked tools are high risk whatever these say, so
 * they are not the person's to store and are left as given.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getHighRiskPrefs, setHighRiskPrefs, type HighRiskKind } from '@renkei/user-prefs';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

function kindOf(value: unknown): HighRiskKind | null {
  return value === 'agents' || value === 'code' ? value : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const kind = kindOf(request.nextUrl.searchParams.get('kind'));
  if (!kind) return jsonError(400, 'invalid-kind', "Expected kind 'agents' or 'code'");
  return NextResponse.json(
    await getHighRiskPrefs(ready.context.session.subject, kind, { fresh: true })
  );
}

export async function PUT(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const body = await readJsonBody(request);
  const kind = kindOf(body.kind);
  if (!kind || !Array.isArray(body.marked) || !Array.isArray(body.unmarked)) {
    return jsonError(
      400,
      'invalid-high-risk',
      "Expected kind 'agents' or 'code', marked: string[] and unmarked: string[]"
    );
  }
  const written = await setHighRiskPrefs(ready.context.session.subject, kind, {
    marked: body.marked,
    unmarked: body.unmarked,
  });
  if (!written.ok) {
    logger.error(
      '{actor} changed their {kind} high-risk tools, but the list was not saved: {error}',
      {
        component: 'api/preferences/high-risk',
        ...who(ready.context.session),
        kind,
        error: written.err.message ?? written.err.type,
      }
    );
    return jsonError(500, 'save-failed', 'Could not save');
  }
  logger.info('{actor} changed their {kind} high-risk tools', {
    component: 'api/preferences/high-risk',
    ...who(ready.context.session),
    kind,
    marked: written.val.marked,
    unmarked: written.val.unmarked,
  });
  return NextResponse.json(written.val);
}
