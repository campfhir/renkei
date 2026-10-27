/**
 * Rows still in a retired envelope form, as the per-user-key rollout
 * sweep (packages/user-keys/scripts/rekey-chats.ts) finds and rewrites
 * them: chat and project content not yet under the resource's key, and
 * a person's memories and connector credentials not yet under their own.
 * Every value is stored and returned sealed (or, for a pre-envelope
 * summary, as the plaintext it is); the sweep opens and re-seals.
 *
 * `notLike` is the LIKE pattern of the form already moved (`renc2:%`,
 * `uenc1:%`): a value matching it is left out.
 */

export interface LegacyEnvelopeChatRows {
  messages: { id: string; content: string }[];
  summaries: { id: string; content: string }[];
  subagentRuns: {
    id: string;
    task: string;
    instructions: string | null;
    transcript: string | null;
    report: string | null;
  }[];
}

export type LegacyEnvelopeCredentialTable =
  'mirth_instance_connections' | 'admanager_instance_connections' | 'file_share_connections';

/** One re-sealed row; only the columns given change. */
export type LegacyEnvelopeWrite =
  | {
      table: 'chat_messages' | 'chat_summaries' | 'chat_project_memories' | 'chat_user_memories';
      id: string;
      content: string;
    }
  | {
      table: 'chat_subagent_runs';
      id: string;
      task?: string;
      instructions?: string;
      transcript?: string;
      report?: string;
    }
  | { table: 'artifacts'; id: string; extractedText: string }
  | { table: 'chat_projects'; id: string; instructions: string }
  /** Every row of the person's in the table still holding `stored`. */
  | { table: LegacyEnvelopeCredentialTable; subject: string; stored: string; next: string }
  | {
      table: 'provider_grants';
      provider: string;
      accountId: string;
      encryptedAccessToken?: string;
      encryptedRefreshToken?: string;
    };

export interface LegacyEnvelopeStore {
  /** Up to `limit` chats after `after` (null to start), by id. */
  chatsPage(after: string | null, limit: number): Promise<{ id: string; ownerSubject: string }[]>;
  /** Every project, by id. */
  projects(): Promise<{ id: string; ownerSubject: string; instructions: string | null }[]>;
  /** A chat's messages, summaries and sub-agent runs not matching `notLike` (task, for runs), each by id. */
  chatRows(chatId: string, notLike: string): Promise<LegacyEnvelopeChatRows>;
  /**
   * The files still under a chat's or project's key (key_kind, key_ref)
   * whose extracted text is set and does not match `notLike`, by id.
   */
  attachments(
    keyKind: 'chat' | 'chat_project',
    keyRef: string,
    notLike: string
  ): Promise<{ id: string; extractedText: string }[]>;
  /** A project's memories not matching `notLike`, by id. */
  projectMemories(projectId: string, notLike: string): Promise<{ id: string; content: string }[]>;
  /** Every person's own memories not matching `notLike`, by id. */
  userMemories(notLike: string): Promise<{ id: string; ownerSubject: string; content: string }[]>;
  /** One credential table's rows not matching `notLike`, by subject (ties by the sealed value). */
  credentials(
    table: LegacyEnvelopeCredentialTable,
    notLike: string
  ): Promise<{ subject: string; encryptedCredentials: string }[]>;
  /**
   * Grants with an owner where either token does not match `notLike`, by
   * provider then account id.
   */
  providerGrants(notLike: string): Promise<
    {
      provider: string;
      accountId: string;
      subject: string;
      encryptedAccessToken: string;
      encryptedRefreshToken: string;
    }[]
  >;
  /** Write one re-sealed row; how many rows changed. */
  reseal(write: LegacyEnvelopeWrite): Promise<number>;
}
