/**
 * Remembering what Renkei posted to WebEx, so the ingest can tell it apart
 * from what the person typed.
 *
 * Renkei posts as the USER — an agent replying in a space, a note to self, a
 * confirmed send all carry the user's own token. Those posts come back
 * through that same user's all-spaces webhook indistinguishable from
 * something they typed, and reacting to them makes an agent answer itself
 * until the daily run cap notices.
 *
 * The old guard was "skip anything the watcher authored", which stopped the
 * loop by also discarding every message the person genuinely wrote — content
 * their own agents and their own knowledge index have every reason to see.
 * This ledger makes the guard exact: WebEx's own message id, recorded here,
 * matched at ingest.
 *
 * ## Failing to record is not fatal, but it is not silent either
 *
 * The message is already sent by the time this runs — there is nothing to
 * roll back and refusing the tool call would be a lie about what happened.
 * So a failed write is logged at WARN and the send still reports success.
 * The consequence is bounded and worth naming: that one message will look
 * user-authored to the ingest, so an agent watching that space may react to
 * it once. That is why this is a warning rather than a debug line.
 */

import { getDatabase } from '@renkei/db';
import { logger } from '@/lib/logger';

/**
 * Record a message Renkei just posted.
 *
 * Never throws: the caller has already sent the message, and the ledger is a
 * loop guard rather than a correctness requirement of the send itself.
 */
export async function recordSentWebexMessage(
  tenantId: string,
  messageId: string,
  accountId: string | null
): Promise<void> {
  if (!messageId) {
    // No id in the response — nothing to match on later. Worth saying,
    // because it means the loop guard cannot cover this message.
    logger.warn('WebEx send returned no message id; it cannot be excluded from ingest', {
      component: 'mcp/webex-sent-ledger',
      tenantId,
    });
    return;
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.warn('could not record sent WebEx message {messageId}: database unavailable', {
      component: 'mcp/webex-sent-ledger',
      tenantId,
      messageId,
    });
    return;
  }
  try {
    await dbResult.val
      .insertInto('webex_sent_messages')
      .values({ tenant_id: tenantId, message_id: messageId, account_id: accountId })
      // A retried send of the same id is the same fact.
      .onConflict((conflict) => conflict.columns(['tenant_id', 'message_id']).doNothing())
      .execute();
  } catch (error) {
    logger.warn('could not record sent WebEx message {messageId}: {error}', {
      component: 'mcp/webex-sent-ledger',
      tenantId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
