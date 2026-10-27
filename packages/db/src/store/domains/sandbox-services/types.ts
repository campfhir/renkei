/**
 * Code project services (sandbox_services): the row describing a
 * container the sandbox worker created on its Docker engine. Every
 * per-caller read names the subject; updates by id are the worker's own
 * bookkeeping, and the sweep's walks read across callers. Lifetimes are
 * the caller's to compute.
 */

export interface SandboxServiceRecord {
  id: string;
  subject: string;
  name: string;
  image: string;
  containerId: string | null;
  /** As stored: 'starting', 'running', 'stopped', 'failed' or 'gone'. */
  status: string;
  error: string | null;
  host: string | null;
  ports: number[];
  exports: Record<string, string>;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export interface SandboxServiceStore {
  /** A new service, 'starting'. */
  insert(service: {
    id: string;
    subject: string;
    name: string;
    image: string;
    exports: Record<string, string>;
    expiresAt: Date;
  }): Promise<SandboxServiceRecord>;
  /** The subject's services by name. */
  list(subject: string): Promise<SandboxServiceRecord[]>;
  getByName(subject: string, name: string): Promise<SandboxServiceRecord | null>;
  /** Change the fields given; the others stay. */
  update(
    id: string,
    change: {
      status?: string;
      error?: string | null;
      containerId?: string | null;
      host?: string | null;
      ports?: number[];
    }
  ): Promise<void>;
  /** A use of these services: `lastUsedAt` and `expiresAt` on each. */
  touch(ids: string[], change: { lastUsedAt: Date; expiresAt: Date }): Promise<void>;
  deleteById(id: string): Promise<void>;
  /** Services expiring before `before`, soonest first (ties by id), at most `limit`. */
  listExpired(before: Date, limit: number): Promise<SandboxServiceRecord[]>;
  /** Every container id a row still claims, sorted. */
  listClaimedContainerIds(): Promise<string[]>;
}
