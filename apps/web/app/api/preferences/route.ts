/**
 * One person's own preferences. Strictly their own: the subject comes from
 * the session and never from the request, so there is no shape of body that
 * edits somebody else's settings.
 *
 * `notifications`, `theme`, `voice`, `image`, `coachMarks` and `chatArchive`
 * are independent documents. GET reads all six; PATCH changes some fields
 * of any of them — `{ theme: { mode: 'dark' } }` changes the mode and
 * nothing else — merged into what is stored in one atomic write per
 * document. A PATCH is idempotent (the same request twice leaves the same
 * preferences), and two made at once, of different fields, both land: each
 * Preferences card, the chat's voice menu and the Tutorials page send only
 * what they change, never a copy of everything else.
 *
 * A field a document does not have is refused, as is an empty patch.
 * Unknown connector and category keys INSIDE the notification grid are
 * dropped rather than refused: during a rolling deploy an older page can
 * post a grid that no longer matches the catalog, and refusing the save
 * would strand somebody on a page that cannot be used until the deploy
 * finishes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { patchPreferences, readAllPreferences } from '@/lib/preferences/documents';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  return NextResponse.json(await readAllPreferences(session.subject));
}

/**
 * Change some fields of one or more documents (lib/preferences/documents.ts).
 * Answers with all six documents as now stored.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const outcome = await patchPreferences(session.subject, body);
  if (outcome.ok) return NextResponse.json(outcome.preferences);
  if (outcome.kind === 'invalid') {
    return NextResponse.json({ error: outcome.error }, { status: 400 });
  }
  logger.error('{actor} changed their {document} preferences, but they were not saved: {error}', {
    component: 'api/preferences',
    ...who(session),
    document: outcome.document,
    error: outcome.cause,
  });
  return NextResponse.json({ error: 'Could not save' }, { status: 500 });
}
