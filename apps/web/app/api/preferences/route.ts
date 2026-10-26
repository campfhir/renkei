/**
 * One person's own preferences. Strictly their own: the subject comes from
 * the session and never from the request, so there is no shape of body that
 * edits somebody else's settings.
 *
 * `notifications`, `theme`, `voice`, `image`, `coachMarks` and `chatArchive`
 * are independent documents, each a whole-document replace when its key is
 * present in the body — which is what each form on the preferences page (and
 * the chat's voice menu, and the Tutorials page) sends. Unknown connector and
 * category keys are DROPPED rather than rejected: during a rolling deploy an
 * older page can post a grid that no longer matches the catalog, and refusing
 * the save would strand somebody on a page that cannot be used until the
 * deploy finishes.
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
  isChatArchiveDays,
  parseChatArchivePrefs,
  parseCoachMarkPrefs,
  parseImagePrefs,
  parseNotificationPrefs,
  parseThemePrefs,
  parseVoicePrefs,
  setChatArchivePrefs,
  setCoachMarkPrefs,
  setImagePrefs,
  setNotificationPrefs,
  setThemePrefs,
  setVoicePrefs,
} from '@renkei/user-prefs';
import { getSessionFromRequest } from '@/lib/session';
import { routeLog } from '@/lib/log-context';

async function GETHandler(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const [notifications, theme, voice, image, coachMarks, chatArchive] = await Promise.all([
    getNotificationPrefs(session.subject, { fresh: true }),
    getThemePrefs(session.subject, { fresh: true }),
    getVoicePrefs(session.subject, { fresh: true }),
    getImagePrefs(session.subject, { fresh: true }),
    getCoachMarkPrefs(session.subject, { fresh: true }),
    getChatArchivePrefs(session.subject, { fresh: true }),
  ]);
  return NextResponse.json({ notifications, theme, voice, image, coachMarks, chatArchive });
}

async function PUTHandler(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  }
  const payload: {
    notifications?: unknown;
    theme?: unknown;
    voice?: unknown;
    image?: unknown;
    coachMarks?: unknown;
    chatArchive?: unknown;
  } = body;

  // Each of the two is only written when the caller actually sent that key —
  // the notification form PUTs just `{notifications}` and the appearance
  // form PUTs just `{theme}`, and writing the other's default over an unsent
  // key would silently reset whichever preference the caller wasn't editing.
  //
  // The parser is the validator for the one that IS sent: it keeps what it
  // recognises and fills the rest from the defaults, so a partial or stale
  // document is usable rather than a 400.
  let notifications = await getNotificationPrefs(session.subject, { fresh: true });
  if ('notifications' in payload) {
    notifications = parseNotificationPrefs(payload.notifications);
    const written = await setNotificationPrefs(session.subject, notifications);
    if (!written.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }

  let theme = await getThemePrefs(session.subject, { fresh: true });
  if ('theme' in payload) {
    theme = parseThemePrefs(payload.theme);
    const written = await setThemePrefs(session.subject, theme);
    if (!written.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }

  let voice = await getVoicePrefs(session.subject, { fresh: true });
  if ('voice' in payload) {
    voice = parseVoicePrefs(payload.voice);
    const written = await setVoicePrefs(session.subject, voice);
    if (!written.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }

  let image = await getImagePrefs(session.subject, { fresh: true });
  if ('image' in payload) {
    image = parseImagePrefs(payload.image);
    const written = await setImagePrefs(session.subject, image);
    if (!written.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }

  let coachMarks = await getCoachMarkPrefs(session.subject, { fresh: true });
  if ('coachMarks' in payload) {
    coachMarks = parseCoachMarkPrefs(payload.coachMarks);
    const written = await setCoachMarkPrefs(session.subject, coachMarks);
    if (!written.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }

  // Unlike the others this one is refused rather than parsed down: a window
  // longer than the org keeps chats is a choice the person can see is wrong,
  // and silently saving something else would leave them thinking it took.
  let chatArchive = await getChatArchivePrefs(session.subject, { fresh: true });
  if ('chatArchive' in payload) {
    const requested: unknown = payload.chatArchive;
    const days: unknown =
      typeof requested === 'object' && requested !== null
        ? Reflect.get(requested, 'afterDays')
        : undefined;
    if (days !== null && !isChatArchiveDays(days)) {
      return NextResponse.json(
        { error: 'chatArchive.afterDays must be a whole number of days, or null for never' },
        { status: 400 }
      );
    }
    const org = await getOrgSettings();
    const retention = org.ok ? org.val.chatRetentionDays : 0;
    if (isChatArchiveDays(days) && retention > 0 && days > retention) {
      return NextResponse.json(
        {
          error: `Archiving cannot be longer than the organization keeps chats (${retention} days)`,
        },
        { status: 400 }
      );
    }
    chatArchive = parseChatArchivePrefs(requested);
    const written = await setChatArchivePrefs(session.subject, chatArchive);
    if (!written.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }

  return NextResponse.json({ notifications, theme, voice, image, coachMarks, chatArchive });
}

export const GET = routeLog(GETHandler);
export const PUT = routeLog(PUTHandler);
