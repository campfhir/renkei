/**
 * Git tickets (delegate_git_tickets): a short-lived credential bound to
 * one person, one provider's host and one direction, for a code
 * workspace's git through the delegate. The secret is stored hashed.
 */
export interface DelegateGitTicketRecord {
  id: string;
  subject: string;
  provider: string;
  host: string;
  write: boolean;
  secretHash: string;
  expiresAt: Date;
}

export interface DelegateGitTicketStore {
  insert(ticket: DelegateGitTicketRecord): Promise<void>;
  /** One ticket by id, expired or not; null when there is none. */
  find(id: string): Promise<DelegateGitTicketRecord | null>;
  /** Delete the tickets that expired before `before`; how many went. */
  deleteExpired(before: Date): Promise<number>;
}
