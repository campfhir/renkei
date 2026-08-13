/**
 * Finding where a forwarded WebEx message came from.
 *
 * A message pasted or forwarded into a room the bot watches usually did not
 * originate there — someone copied it out of a different space to loop the
 * bot's room in. The bot only ever sees the rooms it was invited to, so it
 * cannot find that origin itself; the sender's own WebEx grant can, because
 * it sees every room they are a member of. This is a best-effort, live
 * search — nothing here is persisted independently of the capture it
 * enriches (webex-capture.ts).
 */

import type { WebexClient, WebexMessage } from '@renkei/connector-webex';
import { logger } from '../logger';

/** The slice of the client this module needs — what tests stub. */
export type WebexSearchClient = Pick<WebexClient, 'listRooms' | 'listMessages'>;

/** Rooms scanned, most recently active first — bounded against a heavy user. */
const ROOMS_TO_SCAN = 15;
/** Messages checked per room — recent history only; this is not a full search. */
const MESSAGES_PER_ROOM = 25;
/** Below this, plain chatter ("ok", "thanks") would false-match constantly. */
const MIN_MATCHABLE_LENGTH = 20;

export interface ForwardedOrigin {
  roomId: string;
  roomTitle: string | null;
  messageId: string;
  personEmail: string | null;
  created: string | null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Search the sender's own WebEx rooms (excluding the one the message just
 * arrived in) for a message with the same text — the forwarded original.
 * Null on no match, no usable text, or any API failure; a failed search is
 * silently skipped, never fatal to the capture it would have enriched.
 */
export async function findForwardedOrigin(options: {
  client: WebexSearchClient;
  text: string;
  excludeRoomId: string;
}): Promise<ForwardedOrigin | null> {
  const needle = normalize(options.text);
  if (needle.length < MIN_MATCHABLE_LENGTH) {
    logger.debug('message text too short ({length} chars) to search reliably; skipping', {
      component: 'webex/forward-context',
      length: needle.length,
    });
    return null;
  }

  const { client } = options;
  const rooms = await client.listRooms(ROOMS_TO_SCAN);
  if (!rooms.ok) {
    logger.warn('could not list sender’s webex rooms for context search', {
      component: 'webex/forward-context',
    });
    return null;
  }
  logger.debug('scanning {count} of the sender’s rooms for a forwarded original', {
    component: 'webex/forward-context',
    count: rooms.val.length,
  });

  for (const room of rooms.val) {
    if (room.id === options.excludeRoomId) continue;

    const messages = await client.listMessages(room.id, MESSAGES_PER_ROOM);
    if (!messages.ok) {
      logger.debug('could not list messages in room {roomId}; skipping it', {
        component: 'webex/forward-context',
        roomId: room.id,
      });
      continue;
    }

    const hit = messages.val.find(
      (message): message is WebexMessage & { text: string } =>
        !!message.text && normalize(message.text) === needle
    );
    if (hit) {
      logger.debug('found the forwarded original in room {roomId} ({roomTitle})', {
        component: 'webex/forward-context',
        roomId: room.id,
        roomTitle: room.title ?? 'untitled',
      });
      return {
        roomId: room.id,
        roomTitle: room.title,
        messageId: hit.id,
        personEmail: hit.personEmail,
        created: hit.created,
      };
    }
  }

  logger.debug('no forwarded original found among the scanned rooms', {
    component: 'webex/forward-context',
  });
  return null;
}
