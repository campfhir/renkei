/**
 * Health check-ins (migration 193): one row an environment of a code
 * project — the token an application checks in with, as its hash, and the
 * last check-in it made. The caller hashes tokens, validates a check-in
 * and says when things happened; lateness is the caller's to read from the
 * last check-in and the clock.
 */

export interface CiHealthRecord {
  projectId: string;
  environment: string;
  /** The last characters of the token, to tell one from another. */
  tokenHint: string;
  issuedBy: string;
  issuedAt: Date;
  /** What the last check-in said; null until the first. */
  status: string | null;
  message: string | null;
  version: string | null;
  /** When the application says it sent it. */
  sentAt: Date | null;
  /** When it arrived. */
  receivedAt: Date | null;
  /** How long until the next is due, as the application asked; null for the default. */
  intervalSeconds: number | null;
  checkins: number;
}

export interface CiHealthCheckin {
  status: string;
  message: string | null;
  version: string | null;
  sentAt: Date;
  receivedAt: Date;
  intervalSeconds: number | null;
}

export interface CiHealthStore {
  /** The project's environments that have a token, by environment. */
  listForProject(projectId: string): Promise<CiHealthRecord[]>;
  /**
   * Issue the environment's token, in place of any it had: the old one
   * stops working, and the last check-in is kept.
   */
  issueToken(
    projectId: string,
    environment: string,
    token: { hash: string; hint: string; issuedBy: string; at: Date }
  ): Promise<void>;
  /** Take the environment's token away, and its last check-in with it. False when it had none. */
  revoke(projectId: string, environment: string): Promise<boolean>;
  /** Record a check-in made with the token of that hash. Null when no environment has it. */
  checkIn(tokenHash: string, checkin: CiHealthCheckin): Promise<CiHealthRecord | null>;
}
