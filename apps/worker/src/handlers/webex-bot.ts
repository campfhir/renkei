/**
 * The org's WebEx bot, for the worker — the twin of apps/web/lib/webex-bot.ts
 * (same connector row, same reason to exist: a note posted with a person's
 * own token is read the instant it lands, a direct message from the bot
 * arrives unread). Null means no bot; every caller then posts to the
 * person's solo note-to-self space instead. Never throws — notification
 * is reach, never the record.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { WebexClient, WEBEX_BOT_CONNECTOR } from '@renkei/connector-webex';
import { logger } from '../logger';

export async function webexBotClient(tenantId: string): Promise<WebexClient | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return null;
  try {
    const configResult = await readConnectorConfigCached(
      tenantId,
      WEBEX_BOT_CONNECTOR,
      keyResult.val
    );
    if (!configResult.ok) {
      logger.warn('could not read the webex-bot connector config', {
        component: 'webex/bot',
        tenantId,
      });
      return null;
    }
    const config = configResult.val;
    if (!config || !config.enabled || !config.secrets.botToken) return null;
    return new WebexClient(config.secrets.botToken, { lane: 'background' });
  } catch (error) {
    logger.warn('webex-bot lookup errored: {error}', {
      component: 'webex/bot',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
