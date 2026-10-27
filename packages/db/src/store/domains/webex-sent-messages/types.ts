/**
 * The WebEx sent-message ledger (`webex_sent_messages`): messages Renkei
 * posted, so the ingest can tell them from what a person wrote.
 */
export interface WebexSentMessageStore {
  /** Record one; a retried send of the same id is the same fact (no-op). */
  record(messageId: string, accountId: string | null): Promise<void>;
  /** Whether the message is on the ledger, and for which account. */
  find(messageId: string): Promise<{ messageId: string; accountId: string | null } | null>;
}
