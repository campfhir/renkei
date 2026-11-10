/**
 * One person's preference documents, read and changed in one place: the
 * Preferences route (app/api/preferences/route.ts) and the chat's own
 * preference tools (lib/chat/platform-tools/preferences.ts) both go through
 * here, so a change the model makes on the person's word passes the same
 * checks as one made on the Preferences page.
 *
 * `notifications`, `theme`, `voice`, `image`, `coachMarks` and `chatArchive`
 * are independent documents. A patch changes some fields of any of them —
 * `{ theme: { mode: 'dark' } }` changes the mode and nothing else — merged
 * into what is stored in one atomic write per document. Every patch is read
 * and checked before anything is written, so a refused field leaves every
 * document as it was.
 */

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
import { isRecord } from '@renkei/guards';

export async function readAllPreferences(subject: string) {
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

export type AllPreferences = Awaited<ReturnType<typeof readAllPreferences>>;

type Written = { ok: true } | { ok: false; err: { type: string; message?: string } };

/** A document's patch, read and checked, with the write that applies it. */
type Prepared =
  | { ok: true; patch: object; write: (subject: string) => Promise<Written> }
  | { ok: false; error: string };

/** One document a patch may name: its patch reader and its writer, joined. */
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

/** The documents a patch may name, in the order they are listed everywhere. */
export const PREFERENCE_DOCUMENTS: readonly string[] = Object.keys(DOCUMENTS);

export type PatchPreferencesOutcome =
  | { ok: true; changed: string[]; preferences: AllPreferences }
  /** The patch was refused before anything was written. */
  | { ok: false; kind: 'invalid'; error: string }
  /** A document's write failed; earlier documents of the same patch were written. */
  | { ok: false; kind: 'failed'; document: string; cause: string };

/**
 * Change some fields of one or more documents. Answers with the documents
 * that were written and all six as now stored.
 */
export async function patchPreferences(
  subject: string,
  body: unknown
): Promise<PatchPreferencesOutcome> {
  if (!isRecord(body)) return { ok: false, kind: 'invalid', error: 'Expected an object' };
  const names = Object.keys(body);
  if (names.length === 0) return { ok: false, kind: 'invalid', error: 'Nothing to change' };
  const unknown = names.filter((name) => !Object.prototype.hasOwnProperty.call(DOCUMENTS, name));
  if (unknown.length > 0) {
    return { ok: false, kind: 'invalid', error: `Not a preference: ${unknown.join(', ')}` };
  }

  const patches: { name: string; patch: object; write: (subject: string) => Promise<Written> }[] =
    [];
  for (const name of names) {
    const prepared = DOCUMENTS[name](body[name]);
    if (!prepared.ok) return { ok: false, kind: 'invalid', error: prepared.error };
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
      return {
        ok: false,
        kind: 'invalid',
        error: `Archiving cannot be longer than the organization keeps chats (${retention} days)`,
      };
    }
  }

  for (const { name, write } of patches) {
    const written = await write(subject);
    if (!written.ok) {
      return {
        ok: false,
        kind: 'failed',
        document: name,
        cause: written.err.message ?? written.err.type,
      };
    }
  }
  return { ok: true, changed: names, preferences: await readAllPreferences(subject) };
}
