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
import { getOrgSettings } from '@renkei/settings';
import {
  getChatArchivePrefs,
  getCoachMarkPrefs,
  getImagePrefs,
  getNotificationPrefs,
  getThemePrefs,
  getVoicePrefs,
  parseChatArchivePatch,
  parseCoachMarkPatch,
  parseImagePatch,
  parseNotificationPatch,
  parseThemePatch,
  parseVoicePatch,
  patchChatArchivePrefs,
  patchCoachMarkPrefs,
  patchImagePrefs,
  patchNotificationPrefs,
  patchThemePrefs,
  patchVoicePrefs,
  type PrefsPatch,
} from '@renkei/user-prefs';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

async function readAll(subject: string) {
  const [notifications, theme, voice, image, coachMarks, chatArchive] = await Promise.all([
    getNotificationPrefs(subject, { fresh: true }),
    getThemePrefs(subject, { fresh: true }),
    getVoicePrefs(subject, { fresh: true }),
    getImagePrefs(subject, { fresh: true }),
    getCoachMarkPrefs(subject, { fresh: true }),
    getChatArchivePrefs(subject, { fresh: true }),
  ]);
  return { notifications, theme, voice, image, coachMarks, chatArchive };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  return NextResponse.json(await readAll(session.subject));
}

type Written = { ok: true } | { ok: false; err: { type: string; message?: string } };

/** A document's patch, read and checked, with the write that applies it. */
type Prepared =
  | { ok: true; patch: object; write: (subject: string) => Promise<Written> }
  | { ok: false; error: string };

/** One document a PATCH may name: its patch reader and its writer, joined. */
function document<T>(
  parse: (raw: unknown) => PrefsPatch<T>,
  write: (subject: string, patch: Partial<T>) => Promise<Written>
): (raw: unknown) => Prepared {
  return (raw) => {
    const parsed = parse(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, patch: parsed.patch, write: (subject) => write(subject, parsed.patch) };
  };
}

const DOCUMENTS: Record<string, (raw: unknown) => Prepared> = {
  notifications: document(parseNotificationPatch, patchNotificationPrefs),
  theme: document(parseThemePatch, patchThemePrefs),
  voice: document(parseVoicePatch, patchVoicePrefs),
  image: document(parseImagePatch, patchImagePrefs),
  coachMarks: document(parseCoachMarkPatch, patchCoachMarkPrefs),
  chatArchive: document(parseChatArchivePatch, patchChatArchivePrefs),
};

/**
 * Change some fields of one or more documents. Every patch is read and
 * checked before anything is written, so a refused field leaves every
 * document as it was. Answers with all six documents as now stored.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  }
  const names = Object.keys(body);
  if (names.length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });
  const unknown = names.filter((name) => !Object.prototype.hasOwnProperty.call(DOCUMENTS, name));
  if (unknown.length > 0) {
    return NextResponse.json({ error: `Not a preference: ${unknown.join(', ')}` }, { status: 400 });
  }

  const patches: { name: string; patch: object; write: (subject: string) => Promise<Written> }[] =
    [];
  for (const name of names) {
    const prepared = DOCUMENTS[name](Reflect.get(body, name));
    if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: 400 });
    patches.push({ name, patch: prepared.patch, write: prepared.write });
  }

  // A window longer than the organization keeps chats is a choice the
  // person can see is wrong: refused, not quietly saved as something else.
  const archive = patches.find((entry) => entry.name === 'chatArchive')?.patch;
  const days: unknown = archive ? Reflect.get(archive, 'afterDays') : null;
  if (typeof days === 'number') {
    const org = await getOrgSettings();
    const retention = org.ok ? org.val.chatRetentionDays : 0;
    if (retention > 0 && days > retention) {
      return NextResponse.json(
        {
          error: `Archiving cannot be longer than the organization keeps chats (${retention} days)`,
        },
        { status: 400 }
      );
    }
  }

  for (const { name, write } of patches) {
    const written = await write(session.subject);
    if (!written.ok) {
      logger.error(
        '{actor} changed their {document} preferences, but they were not saved: {error}',
        {
          component: 'api/preferences',
          ...who(session),
          document: name,
          error: written.err.message ?? written.err.type,
        }
      );
      return NextResponse.json({ error: 'Could not save' }, { status: 500 });
    }
  }
  return NextResponse.json(await readAll(session.subject));
}
