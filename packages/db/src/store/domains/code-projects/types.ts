/**
 * What a code project's pages read beyond its chat-project row: the
 * branch each checkout is on (sandbox_workspaces, kept current by the
 * sandbox worker), token spend per chat (chat_turns), requests for a
 * larger checkout (sandbox_size_requests), and the scopes a person's git
 * host connection carries (provider_grants, read-only here).
 */

export interface SizeRequestRecord {
  id: string;
  /** The worker's subject for the checkout, `code-project:<id>`. */
  subject: string;
  requestedBy: string;
  requestedBytes: number;
  reason: string;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

export interface CodeProjectStore {
  /** The branch of each ready checkout among these ids (others, and empty branches, left out), by id. */
  workspaceBranches(workspaceIds: string[]): Promise<{ id: string; branch: string }[]>;
  /** Token totals per chat of one project, across every turn, by chat id. */
  usageByChat(
    projectId: string
  ): Promise<{ chatId: string; inputTokens: number; outputTokens: number }[]>;
  /** The newest request for one checkout subject (ties by id), whatever its state. */
  latestSizeRequest(subject: string): Promise<SizeRequestRecord | null>;
  /** The sizes, in bytes, of every approved request for one checkout subject, smallest first. */
  approvedSizes(subject: string): Promise<number[]>;
  /** File a pending request; null when one is already pending for the subject. */
  createSizeRequest(request: {
    subject: string;
    requestedBy: string;
    requestedBytes: number;
    reason: string;
  }): Promise<SizeRequestRecord | null>;
  /**
   * The org's requests, pending first then newest (ties by id), at most
   * `limit`, each with the name of the project its subject names
   * (`projectPrefix` + project id), or null when that project is gone.
   */
  listSizeRequests(
    projectPrefix: string,
    limit: number
  ): Promise<(SizeRequestRecord & { projectName: string | null })[]>;
  /** Decide a pending request (approving may change the bytes); null when it is not pending. */
  decideSizeRequest(decision: {
    id: string;
    status: 'approved' | 'denied';
    decidedBy: string;
    note: string | null;
    approvedBytes?: number;
  }): Promise<SizeRequestRecord | null>;
  /**
   * The scopes on a person's connection to one host — the most recently
   * updated, when there are several (ties by account id) — or null.
   */
  providerGrantScopes(
    subject: string,
    provider: string
  ): Promise<{ requestedScopes: string[]; grantedScopes: string[] | null } | null>;
}
