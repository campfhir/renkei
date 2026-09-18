/**
 * The org's WebEx bot, from the database — connector 'webex-bot', beside
 * 'webex-user' (the Integration people grant their own access through).
 *
 * The bot exists for exactly one job: leaving a person a note they will
 * NOTICE. A note posted with the person's own token is authored by them, so
 * WebEx marks it read the instant it lands and shows no badge — and the
 * public API has no way to mark a message unread. A direct message from the
 * bot is somebody else's message: it arrives unread, with WebEx's own
 * notification. The bot reads nothing and joins nothing; every read in this
 * codebase still runs as the person.
 *
 * Optional. Null from here means "no bot": every caller falls back to the
 * person's solo note-to-self space (sendNoteToPerson), which is where notes
 * went before there was a bot. Nothing here throws — a notification is
 * reach, never the record, and a bot that cannot be resolved must never
 * cost the note itself.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { WebexClient, WEBEX_BOT_CONNECTOR } from '@renkei/connector-webex';
import { logger } from '@/lib/logger';

export { WEBEX_BOT_CONNECTOR };

export interface WebexBot {
  token: string;
  /** What the bot is called in WebEx, recorded when the token was saved. */
  displayName: string | null;
  /** The bot's own address (…@webex.bot), recorded when the token was saved. */
  email: string | null;
}

/** The tenant's bot, or null when none is configured, it is disabled, or it cannot be read. */
export async function getWebexBot(tenantId: string): Promise<WebexBot | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return null;
  try {
    const configResult = await readConnectorConfigCached(
      tenantId,
      WEBEX_BOT_CONNECTOR,
      keyResult.val
    );
    if (!configResult.ok) {
      logger.warn('Could not read webex-bot connector config', {
        component: 'connectors/webex-bot',
        tenantId,
      });
      return null;
    }
    const config = configResult.val;
    if (!config || !config.enabled) return null;
    const token = config.secrets.botToken;
    if (!token) return null;
    return {
      token,
      displayName:
        typeof config.settings.displayName === 'string' ? config.settings.displayName : null,
      email: typeof config.settings.email === 'string' ? config.settings.email : null,
    };
  } catch (error) {
    logger.warn('webex-bot lookup errored: {error}', {
      component: 'connectors/webex-bot',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** A client speaking as the bot, or null when the org has none — the `bot` sendNoteToPerson takes. */
export async function webexBotClient(
  tenantId: string,
  lane: 'interactive' | 'background' = 'interactive'
): Promise<WebexClient | null> {
  const bot = await getWebexBot(tenantId);
  return bot ? new WebexClient(bot.token, { lane }) : null;
}
