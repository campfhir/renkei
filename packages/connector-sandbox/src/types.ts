/**
 * Domain vocabulary for the sandbox scratch space — a per-caller staging
 * area for file bytes an agent is moving between two connectors that have
 * no way to reference each other directly yet (e.g. a network file share,
 * which only offers a download link, and OnBase, which only accepts staged
 * upload bytes). Unlike every other connector, there is no third-party
 * account behind this one: "auth" is simply "this tenant's own signed-in
 * caller," scoped by (tenantId, subject).
 */

/** One staged file's metadata, as the store and worker both speak it. */
export interface SandboxFileSummary {
  id: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  /** Where the bytes came from, for display/audit — never the full URL or a secret. */
  source: string;
  /** The batch job this file belongs to, if any — see limits.ts's batch quota pool. */
  batchId: string | null;
  createdAt: Date;
  expiresAt: Date;
}
