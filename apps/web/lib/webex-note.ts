/**
 * Leaving a person a WebEx note from the web app — the one place the
 * "bot first, solo space second" choice is made for every web-side
 * notifier (a chat or agent shared with them, an agent of theirs edited).
 * The MCP tool webex_note_to_self makes the same choice on its own auth
 * path; the worker's owner-channels makes it with its own resolvers.
 */

import { WebexClient, sendNoteToPerson, type NoteDelivery } from '@renkei/connector-webex';
import type { Result } from '@campfhir/safe-functions/types';
import type { WebexUserAccess } from '@/lib/webex-user-access';
import { webexBotClient } from '@/lib/webex-bot';

/** The address a grant recorded for the person, the bot's only way to reach them. */
export function personEmailOf(access: Pick<WebexUserAccess, 'metadata'>): string | null {
  return typeof access.metadata.personEmail === 'string' ? access.metadata.personEmail : null;
}

export async function sendWebexNote(
  tenantId: string,
  access: WebexUserAccess,
  markdown: string
): Promise<Result<NoteDelivery, 'WEBEX_API_ERROR'>> {
  return sendNoteToPerson({
    bot: await webexBotClient(tenantId),
    user: new WebexClient(access.accessToken),
    personEmail: personEmailOf(access),
    markdown,
  });
}
